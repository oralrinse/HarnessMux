/**
 * agent-bridge mailbox core.
 *
 * A dependency-free, file-based message bus shared by two coding agents that
 * run as separate processes (for example OpenAI Codex and DeepSeek Harness).
 * The on-disk layout is the wire protocol; every write is atomic (temp file in
 * the same directory, then rename) so a reader never observes a partial write.
 *
 * Layout under the bridge root:
 *   bridge.json                 manifest (version, actors)
 *   inbox/<message-id>.json     a message waiting to be read
 *   read/<message-id>.json      the same message after it was consumed
 *   state/<actor>-cursor.json   per-actor read watermark
 *   log/<message-id>.json       audit copy of every message ever posted
 *
 * A message is addressed by its `to` field, not by its directory: `read` moves
 * every pending message whose `to` matches, so a sender only picks a recipient.
 *
 * Message ids are lexicographically ordered by creation time, which makes the
 * read watermark a simple string comparison.
 *
 * @module agent-bridge/core
 */

import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories created inside every bridge root. */
export const DIRS = ["inbox", "read", "state", "log"];

/** Actors the protocol knows about. Unknown names are allowed (forward compatible). */
export const ACTORS = ["codex", "dsh"];

/** Environment variables consulted when no explicit root is given. */
const ROOT_ENV_KEYS = ["AGENT_BRIDGE_DIR", "AGENT_BRIDGE_ROOT"];

/** File that remembers the chosen root so later calls need no --root. */
export const ROOT_CACHE = join(homedir(), ".dsh", "agent-bridge-root.txt");

/**
 * Resolve the bridge root. Precedence: explicit argument, `AGENT_BRIDGE_DIR`,
 * `AGENT_BRIDGE_ROOT`, the cached root, then `$DSH_HOME/agent-bridge`
 * (default `~/.dsh/agent-bridge`).
 *
 * @param {string} [explicit] - an explicit bridge root path.
 * @returns {string} the absolute bridge root.
 */
export function resolveBridgeRoot(explicit) {
	const fromArgs = explicit?.trim();
	if (fromArgs) return resolve(fromArgs);
	for (const key of ROOT_ENV_KEYS) {
		const value = process.env[key]?.trim();
		if (value) return resolve(value);
	}
	if (existsSync(ROOT_CACHE)) {
		const cached = readFileSync(ROOT_CACHE, "utf8").trim();
		if (cached) return resolve(cached);
	}
	const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
	return resolve(join(home, "agent-bridge"));
}

/** Remember a root so later invocations without `--root` find it again. */
export function rememberRoot(root) {
	try {
		const dir = dirname(ROOT_CACHE);
		mkdirSync(dir, { recursive: true });
		writeFileSync(ROOT_CACHE, root, "utf8");
		return true;
	} catch {
		// Remembering the root is a convenience; never fail a post because of it.
		return false;
	}
}

/**
 * Create the bridge tree if needed and write the manifest.
 *
 * @param {string} root - the absolute bridge root.
 * @param {object} [options] - `remember` (default true) records the root.
 * @returns {object} the parsed manifest.
 */
export function ensureBridge(root, options = {}) {
	for (const dir of DIRS) mkdirSync(join(root, dir), { recursive: true });
	const manifestPath = join(root, "bridge.json");
	if (!existsSync(manifestPath)) {
		writeJson(manifestPath, {
			version: 1,
			createdAt: new Date().toISOString(),
			protocol: "agent-bridge/v1",
			actors: ACTORS,
			notes: "File-based mailbox between two coding agents. Pending messages are JSON files in inbox/; consumed ones move to read/."
		});
	}
	// A test/sandbox root must never overwrite the user's remembered root.
	if (options.remember !== false && !isEphemeralRoot(root)) rememberRoot(root);
	return readJson(manifestPath);
}

/**
 * Whether a root is throwaway test state (inside this project's checkout).
 *
 * @param {string} root - candidate root.
 * @returns {boolean} true when the root must not be cached.
 */
function isEphemeralRoot(root) {
	const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const normalized = resolve(root);
	return normalized === projectRoot || normalized.startsWith(`${projectRoot}${sep}`);
}

/** @returns {boolean} whether the root looks initialised. */
export function isBridgeRoot(root) {
	return existsSync(join(root, "bridge.json"));
}

/** Atomically write JSON: temp file in the same directory, then rename. */
function writeJson(path, value) {
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** Read and parse JSON, rethrowing an error that names the file. */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`agent-bridge: cannot read ${path}: ${String(error)}`);
	}
}

/** A sortable, collision-free message id. */
function nextMessageId() {
	const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 17);
	return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * Short stable digest, used to derive a thread id from a topic.
 *
 * @param {string} text - input text.
 * @returns {string} 8 hex characters.
 */
export function shortHash(text) {
	return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** Every `*.json` file in a directory, sorted by name. */
function listMessageFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => entry.endsWith(".json"))
		.sort();
}

/** Read every message in a directory, tagging each with its file name. */
function readAll(dir) {
	return listMessageFiles(dir).map((entry) => ({ ...readJson(join(dir, entry)), _file: entry }));
}

/** Filename-friendly ASCII slug for a topic. */
function slug(text) {
	const ascii = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return ascii.slice(0, 24) || "thread";
}

/** Validate an actor name against the protocol character set. */
function requireActor(value, field) {
	const actor = String(value ?? "").trim();
	if (!/^[A-Za-z0-9_-]{1,32}$/u.test(actor)) {
		throw new Error(`agent-bridge: "${field}" must be 1-32 characters of [A-Za-z0-9_-] (got ${JSON.stringify(value)})`);
	}
	return actor;
}

/**
 * Post a message into the bridge.
 *
 * @param {string} root - the bridge root.
 * @param {object} input - message fields.
 * @param {string} input.from - sender actor (for example `codex`).
 * @param {string} input.to - recipient actor (for example `dsh`).
 * @param {string} input.body - markdown body (required, non-empty).
 * @param {string} [input.topic] - thread topic; defaults to `(no topic)`.
 * @param {string} [input.kind] - `instruction` | `question` | `answer` | `report` | `note`.
 * @param {string} [input.replyTo] - id of the message this one answers.
 * @param {string} [input.threadId] - explicit thread id; defaults to a hash of the topic.
 * @param {string[]} [input.refs] - files or URLs the message refers to.
 * @param {boolean} [input.expectReply] - whether the sender waits for an answer.
 * @returns {object} the stored message.
 */
export function postMessage(root, input) {
	ensureBridge(root, { remember: false });
	const body = String(input.body ?? "").trim();
	if (!body) throw new Error("agent-bridge: a message needs a non-empty body");
	const topic = String(input.topic ?? "").trim() || "(no topic)";
	const message = {
		id: nextMessageId(),
		createdAt: new Date().toISOString(),
		from: requireActor(input.from, "from"),
		to: requireActor(input.to, "to"),
		topic,
		threadId: input.threadId?.trim() || `${slug(topic)}-${shortHash(topic)}`,
		kind: input.kind ?? "note",
		expectReply: input.expectReply === true,
		...(input.replyTo ? { replyTo: input.replyTo } : {}),
		...(Array.isArray(input.refs) && input.refs.length > 0 ? { refs: input.refs } : {}),
		body
	};
	writeJson(join(root, "inbox", `${message.id}.json`), message);
	writeJson(join(root, "log", `${message.id}.json`), message);
	return message;
}

/**
 * List messages without consuming them.
 *
 * @param {string} root - the bridge root.
 * @param {object} [filter] - filters.
 * @param {string} [filter.to] - only messages addressed to this actor.
 * @param {string} [filter.from] - only messages from this actor.
 * @param {string} [filter.threadId] - only this thread.
 * @param {boolean} [filter.pendingOnly] - only messages still in inbox/.
 * @returns {object[]} messages with a `_pending` flag, oldest first.
 */
export function listMessages(root, filter = {}) {
	const pending = readAll(join(root, "inbox"));
	const consumed = readAll(join(root, "read"));
	const chosen = filter.pendingOnly === true ? pending : [...consumed, ...pending];
	return chosen
		.filter((message) => (filter.to ? message.to === filter.to : true))
		.filter((message) => (filter.from ? message.from === filter.from : true))
		.filter((message) => (filter.threadId ? message.threadId === filter.threadId : true))
		.map((message) => ({ ...message, _pending: existsSync(join(root, "inbox", message._file)) }))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Read messages addressed to an actor, consuming them by default.
 *
 * @param {string} root - the bridge root.
 * @param {object} input - read request.
 * @param {string} input.actor - the reader.
 * @param {boolean} [input.consume] - move read messages to read/ (default true).
 * @param {boolean} [input.fromCursor] - only messages newer than the reader's watermark.
 * @param {number} [input.limit] - maximum number of messages to return.
 * @returns {{messages: object[], cursor: string|null}} the messages and the new watermark.
 */
export function readMessages(root, input) {
	const actor = requireActor(input.actor, "actor");
	const consume = input.consume !== false;
	const cursor = input.fromCursor === true ? getCursor(root, actor) : null;
	let messages = listMessages(root, { to: actor, pendingOnly: true })
		.filter((message) => (cursor ? message.id > cursor : true));
	if (typeof input.limit === "number" && input.limit > 0) messages = messages.slice(0, input.limit);
	let watermark = cursor;
	for (const message of messages) {
		if (message.id > (watermark ?? "")) watermark = message.id;
		if (consume) consumeMessage(root, message.id);
	}
	if (consume && watermark) setCursor(root, actor, watermark);
	return { messages: messages.map(({ _pending, _file, ...rest }) => rest), cursor: watermark };
}

/** Move one inbox message into read/. Idempotent; returns whether it moved. */
export function consumeMessage(root, messageId) {
	const from = join(root, "inbox", `${messageId}.json`);
	const to = join(root, "read", `${messageId}.json`);
	if (!existsSync(from)) return false;
	if (existsSync(to)) {
		unlinkSync(from);
		return true;
	}
	renameSync(from, to);
	return true;
}

/** Read one message by id from inbox/, read/, or log/, else null. */
export function getMessage(root, messageId) {
	for (const dir of ["inbox", "read", "log"]) {
		const path = join(root, dir, `${messageId}.json`);
		if (existsSync(path)) return readJson(path);
	}
	return null;
}

/** @returns {string|null} an actor's read watermark (last consumed message id). */
export function getCursor(root, actor) {
	const path = join(root, "state", `${actor}-cursor.json`);
	if (!existsSync(path)) return null;
	return readJson(path).cursor ?? null;
}

/** Persist a watermark, never moving it backwards. */
export function setCursor(root, actor, cursor) {
	const path = join(root, "state", `${actor}-cursor.json`);
	const current = getCursor(root, actor);
	if (current && current >= cursor) return current;
	writeJson(path, { actor, cursor, updatedAt: new Date().toISOString() });
	return cursor;
}

/**
 * Count pending messages for an actor after its watermark.
 *
 * @param {string} root - the bridge root.
 * @param {string} actor - the reader.
 * @returns {number} pending count.
 */
export function pendingCount(root, actor) {
	const cursor = getCursor(root, actor);
	return listMessages(root, { to: actor, pendingOnly: true })
		.filter((message) => (cursor ? message.id > cursor : true)).length;
}

/**
 * A compact rendering used by both the CLI and the tool output.
 *
 * @param {object} message - a stored message.
 * @returns {string} the block rendering.
 */
export function formatMessage(message) {
	const flags = [message.kind, message.expectReply ? "expects-reply" : null].filter(Boolean).join(",");
	const refs = Array.isArray(message.refs) && message.refs.length > 0 ? `\nrefs: ${message.refs.join(", ")}` : "";
	return `[${message.id}] ${message.createdAt} ${message.from} -> ${message.to} (${flags}) thread=${message.threadId} topic=${message.topic}${message.replyTo ? ` replyTo=${message.replyTo}` : ""}\n${message.body}${refs}`;
}

/**
 * Bridge statistics for a status report.
 *
 * @param {string} root - the bridge root.
 * @returns {object} counts, cursors, and the last modification time.
 */
export function bridgeStatus(root) {
	const pending = readAll(join(root, "inbox"));
	const byActor = {};
	for (const message of pending) byActor[message.to] = (byActor[message.to] ?? 0) + 1;
	return {
		root,
		exists: isBridgeRoot(root),
		pendingTotal: pending.length,
		pendingByActor: byActor,
		readTotal: listMessageFiles(join(root, "read")).length,
		logTotal: listMessageFiles(join(root, "log")).length,
		lastModified: existsSync(root) ? statSync(root).mtime.toISOString() : null,
		cursors: Object.fromEntries(ACTORS.map((actor) => [actor, getCursor(root, actor)]))
	};
}

/** Absolute path of something inside the bridge root. */
export function bridgePath(root, ...parts) {
	return join(root, ...parts);
}

/** Directory of this module, for locating sibling files. */
export function moduleDir() {
	return dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));
}
