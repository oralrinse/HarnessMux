/**
 * harnessmux protocol v2 — messages, deliveries, and the claim/ack state machine.
 *
 * Why v2 exists
 *   v1 treated "the file left inbox/" as "the peer consumed it" and let a
 *   monotonic cursor decide consumption. Both are wrong under crashes and
 *   concurrency: a crash between the move and the hand-off loses the message,
 *   and a cursor derived from a random-suffixed id can skip a message forever.
 *
 *   v2 separates two things that v1 conflated:
 *     - the **message**: what was said. Immutable, one file, never rewritten.
 *     - the **delivery**: who it is being handed to, and how far that got.
 *
 * Layout
 *   bridge.json                        manifest + policy (audit, defaultMode, leaseMs)
 *   messages/<messageId>.json          immutable body (from/to/topic/threadId/kind/refs)
 *   queue/<deliveryId>.json            a delivery waiting to be claimed
 *   claims/<deliveryId>.json           a delivery claimed under a lease
 *   acks/<deliveryId>.json             the host accepted this delivery
 *   bindings/<threadId>.json           thread -> (actor, endpointId, sessionId, mode)
 *   endpoints/<endpointId>.json        {actor, endpointId, transport, sessions[]}
 *   audit/YYYY-MM-DD.jsonl             append-only audit stream (retention configurable)
 *
 * Delivery guarantee
 *   AT-LEAST-ONCE. A crash after a successful hand-off but before `ack` must be
 *   re-delivered, because the bridge cannot know whether the host really took
 *   it. Consumers therefore MUST tolerate duplicate deliveryIds. Exactly-once
 *   needs a host-side transaction or idempotency key; this file protocol cannot
 *   provide it, and pretending otherwise would trade duplicates for data loss.
 *
 * @module harnessmux/core-v2
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Protocol version this module implements. */
export const PROTOCOL_VERSION = 2;

/** Directories that make up a v2 bridge root. */
export const DIRS = ["messages", "queue", "claims", "acks", "bindings", "endpoints", "audit", "state"];

/** Delivery trust levels. `delegated` work may be executed; `advisory` may not. */
export const MODES = ["advisory", "delegated"];

/** Message kinds. */
export const KINDS = ["instruction", "question", "answer", "report", "note"];

/** Default lease for a claim: long enough for a host turn, short enough to recover. */
export const DEFAULT_LEASE_MS = 120_000;

/** Default audit retention. */
export const DEFAULT_AUDIT = { enabled: true, retentionDays: 30, maxBytes: 100 * 1024 * 1024 };

/** Environment variables consulted when no explicit root is given. */
const ROOT_ENV_KEYS = ["HARNESSMUX_DIR", "HARNESSMUX_ROOT"];

/** File that remembers the chosen root so later calls need no --root. */
export const ROOT_CACHE = join(homedir(), ".dsh", "harnessmux-root.txt");

/**
 * Resolve the bridge root: explicit argument, `HARNESSMUX_DIR`,
 * `HARNESSMUX_ROOT`, the cached root, then `$DSH_HOME/harnessmux`.
 *
 * @param {string} [explicit] - an explicit bridge root.
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
	return resolve(join(home, "harnessmux"));
}

/**
 * Create the v2 layout if needed and read the manifest.
 *
 * @param {string} root - the bridge root.
 * @param {object} [options] - `remember` (default true) records the root.
 * @returns {object} the manifest.
 */
export function ensureBridge(root, options = {}) {
	for (const dir of DIRS) mkdirSync(join(root, dir), { recursive: true });
	const manifestPath = join(root, "bridge.json");
	if (!existsSync(manifestPath)) {
		writeJson(manifestPath, {
			version: PROTOCOL_VERSION,
			createdAt: new Date().toISOString(),
			protocol: "harnessmux/v2",
			delivery: "at-least-once",
			defaultMode: "advisory",
			leaseMs: DEFAULT_LEASE_MS,
			audit: { ...DEFAULT_AUDIT }
		});
	}
	// Never let a test/sandbox root overwrite the user's remembered root.
	if (options.remember !== false && !isEphemeralRoot(root)) rememberRoot(root);
	return readManifest(root);
}

/**
 * Whether a root is throwaway test state (inside the project's own checkout).
 *
 * The root cache is a convenience for real bridges. Tests create and delete
 * bridge roots constantly; without this guard a test run silently repoints the
 * cache at a directory it is about to delete, which is exactly what happened
 * during the first real cutover.
 *
 * @param {string} root - candidate root.
 * @returns {boolean} true when the root must not be cached.
 */
function isEphemeralRoot(root) {
	// This module is packages/core/core-v2.mjs, so the project root is three levels
	// up: file -> packages/core -> packages -> repo. `resolve()` normalises the
	// Windows drive letter on both sides, because `fileURLToPath` yields "h:\…" while
	// callers pass "H:\…" and a raw comparison silently misses.
	const modulePath = resolve(fileURLToPath(import.meta.url));
	const projectRoot = dirname(dirname(dirname(modulePath)));
	const normalized = resolve(root);
	if (normalized === projectRoot || normalized.startsWith(`${projectRoot}${sep}`)) return true;
	// A scratch bridge is usually built in the system temp directory rather than inside the
	// checkout, and the first version of this guard only knew about the checkout. An installation
	// test using a temp `DSH_HOME` therefore repointed the real root cache at a bridge it then
	// deleted, and every client resolving through that cache reported "no receiver has registered
	// yet" while a healthy receiver published to the real bridge. Matching the temp roots closes it,
	// compared the same normalised way.
	for (const temp of [process.env.TEMP, process.env.TMP, tmpdir()]) {
		if (typeof temp !== "string" || temp.trim() === "") continue;
		const normalizedTemp = resolve(temp);
		if (normalized === normalizedTemp || normalized.startsWith(`${normalizedTemp}${sep}`)) return true;
	}
	return false;
}

/** Read the manifest with defaults filled in. */
export function readManifest(root) {
	const manifest = readJson(join(root, "bridge.json"));
	const audit = { ...DEFAULT_AUDIT, ...(manifest.audit ?? {}) };
	return {
		...manifest,
		version: manifest.version ?? PROTOCOL_VERSION,
		defaultMode: MODES.includes(manifest.defaultMode) ? manifest.defaultMode : "advisory",
		leaseMs: Number.isFinite(manifest.leaseMs) ? manifest.leaseMs : DEFAULT_LEASE_MS,
		audit
	};
}

/** Persist a manifest change (policy updates). */
export function writeManifest(root, patch) {
	const next = { ...readManifest(root), ...patch };
	writeJson(join(root, "bridge.json"), next);
	return next;
}

/**
 * Remember a root for later invocations without `--root`.
 *
 * The ephemeral-root check lives here as well as in `ensureBridge`, because this is the
 * one function that writes the cache. A caller that forgets `{ remember: false }` — the
 * CLI's own `init` did — could otherwise point every later invocation at a throwaway
 * directory, and the damage only surfaces once that directory is gone. Keeping the guard
 * at the write site makes that impossible regardless of the caller.
 *
 * @param {string} root - the bridge root to remember.
 * @returns {boolean} whether the cache was written.
 */
export function rememberRoot(root) {
	if (isEphemeralRoot(root)) return false;
	try {
		mkdirSync(join(homedir(), ".dsh"), { recursive: true });
		writeFileSync(ROOT_CACHE, root, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** @returns {boolean} whether the root already holds a bridge. */
export function isBridgeRoot(root) {
	return existsSync(join(root, "bridge.json"));
}

/** Atomically write JSON (temp file in the same directory, then rename). */
function writeJson(path, value) {
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 6)}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/**
 * Create a file only if it does not exist. This is the atomic primitive behind
 * claiming: `wx` fails with EEXIST for every loser of a concurrent claim.
 *
 * @param {string} path - target path.
 * @param {object} value - JSON value.
 * @returns {boolean} true when this caller created the file.
 */
function writeJsonExclusive(path, value) {
	const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 6)}`;
	try {
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		removeQuietly(tmp);
		if (error?.code === "EEXIST") return false;
		throw error;
	}
	try {
		// Link-free atomic publish: rename over a non-existent target.
		renameSync(tmp, path);
		return true;
	} catch (error) {
		removeQuietly(tmp);
		throw error;
	}
}

/** Read and parse JSON, rethrowing with the file named. */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`harnessmux: cannot read ${path}: ${String(error)}`);
	}
}

/** Remove a file if present, ignoring failures. */
function removeQuietly(path) {
	try {
		unlinkSync(path);
	} catch {
		// Already gone or held by another process: either way nothing to do.
	}
}

/** Every `*.json` file in a directory, sorted by name. */
function listJson(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort();
}

/** Read every record in a directory; a corrupt file is reported, never fatal. */
function readAll(dir) {
	const records = [];
	for (const entry of listJson(dir)) {
		try {
			records.push({ ...readJson(join(dir, entry)), _file: entry });
		} catch (error) {
			records.push({ _file: entry, _corrupt: String(error?.message ?? error) });
		}
	}
	return records;
}

/** Validate an actor/endpoint name (used in filenames). */
function requireName(value, field) {
	const name = String(value ?? "").trim();
	if (!/^[A-Za-z0-9._-]{1,64}$/u.test(name)) {
		throw new Error(`harnessmux: "${field}" must be 1-64 characters of [A-Za-z0-9._-] (got ${JSON.stringify(value)})`);
	}
	return name;
}

/**
 * Validate a claim owner. Owners are free-form identities (`dsh:session-a`,
 * `worker.7@host`) that never become filenames, so `:` and `@` are allowed.
 */
function requireOwner(value) {
	const owner = String(value ?? "").trim();
	if (!/^[A-Za-z0-9._:@-]{1,80}$/u.test(owner)) {
		throw new Error(`harnessmux: "owner" must be 1-80 characters of [A-Za-z0-9._:@-] (got ${JSON.stringify(value)})`);
	}
	return owner;
}

/** Append one audit line, honouring the audit policy. */
function audit(root, event) {
	try {
		const { audit: policy } = readManifest(root);
		if (policy.enabled !== true) return;
		const day = new Date().toISOString().slice(0, 10);
		writeFileSync(join(root, "audit", `${day}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { encoding: "utf8", flag: "a" });
	} catch {
		// Audit must never break delivery.
	}
}

// ---------------------------------------------------------------------------
// messages — immutable
// ---------------------------------------------------------------------------

/**
 * Post an immutable message. Routing and trust intentionally do NOT live here.
 *
 * @param {string} root - the bridge root.
 * @param {object} input - message fields.
 * @param {string} input.from - sender actor.
 * @param {string} [input.topic] - thread topic.
 * @param {string} input.body - markdown body.
 * @param {string} [input.kind] - one of {@link KINDS}.
 * @param {string} [input.threadId] - explicit thread; defaults to a hash of the topic.
 * @param {string} [input.replyTo] - messageId this answers.
 * @param {string[]} [input.refs] - referenced files/URLs.
 * @param {string} [input.messageId] - explicit id (tests, imports).
 * @returns {object} the stored message.
 */
export function postMessage(root, input) {
	ensureBridge(root, { remember: false });
	const body = String(input.body ?? "").trim();
	if (!body) throw new Error("harnessmux: a message needs a non-empty body");
	const kind = KINDS.includes(input.kind) ? input.kind : "note";
	const topic = String(input.topic ?? "").trim() || "(no topic)";
	const messageId = input.messageId ? requireName(input.messageId, "messageId") : randomUUID();
	const message = {
		messageId,
		createdAt: new Date().toISOString(),
		from: requireName(input.from, "from"),
		topic,
		threadId: input.threadId?.trim() || `${slug(topic)}-${shortHash(topic)}`,
		kind,
		...(input.replyTo ? { replyTo: requireName(input.replyTo, "replyTo") } : {}),
		// Recorded so a repeat submission can be recognised rather than duplicated. Descriptive
		// metadata on an immutable record: it never affects routing, claiming or delivery.
		...(typeof input.clientRequestId === "string" && input.clientRequestId.trim() !== ""
			? { clientRequestId: input.clientRequestId.trim() }
			: {}),
		...(Array.isArray(input.refs) && input.refs.length > 0 ? { refs: input.refs } : {}),
		body
	};
	writeJsonExclusive(join(root, "messages", `${messageId}.json`), message);
	audit(root, { event: "message.posted", messageId, from: message.from, kind, threadId: message.threadId });
	return message;
}

/**
 * Find a message by the client's own request id, scoped to its author and thread.
 *
 * The second line of defence against a duplicate task. The first is the client behaving correctly,
 * but a client that times out and resends is a real failure mode observed in practice: a commander
 * sent a task, waited, decided it had not been picked up, and sent the same task again — so the
 * executor ran it twice. **A pending delivery is not a failed delivery**, and no timeout should be
 * able to create a second one.
 *
 * The scope is deliberately narrow. `from` + `threadId` + `clientRequestId` identifies one logical
 * submission, so the same key in a different thread or from a different actor is a different task and
 * is not suppressed. The body is never hashed: two genuinely different tasks may legitimately carry
 * identical text, and suppressing on content would silently drop real work.
 *
 * @param {string} root - bridge root.
 * @param {object} input - `from`, `clientRequestId`, and optional `threadId`.
 * @returns {object|null} the already-posted message, or null.
 */
export function findMessageByRequestId(root, input = {}) {
	const requestId = typeof input.clientRequestId === "string" ? input.clientRequestId.trim() : "";
	if (requestId === "") return null;
	const from = typeof input.from === "string" ? input.from.trim() : "";
	const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
	for (const message of listMessages(root)) {
		if (message.clientRequestId !== requestId) continue;
		if (message.from !== from) continue;
		if (threadId !== "" && message.threadId !== threadId) continue;
		return message;
	}
	return null;
}

/** Read one immutable message by id. */
export function getMessage(root, messageId) {
	const path = join(root, "messages", `${requireName(messageId, "messageId")}.json`);
	return existsSync(path) ? readJson(path) : null;
}

/** All messages, oldest first. */
export function listMessages(root) {
	return readAll(join(root, "messages"))
		.filter((record) => record._corrupt === undefined)
		.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.messageId < b.messageId ? -1 : 1));
}

/** Filename-friendly ASCII slug. */
function slug(text) {
	const ascii = text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
	return ascii.slice(0, 24) || "thread";
}

/** Stable short digest, used to derive a thread id from a topic. */
export function shortHash(text) {
	let hash = 0n;
	for (const byte of new TextEncoder().encode(text)) {
		hash = (hash * 1099511628211n) ^ BigInt(byte);
		hash &= 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, "0").slice(0, 16);
}

// ---------------------------------------------------------------------------
// bindings and endpoints — routing state
// ---------------------------------------------------------------------------

/**
 * Register an endpoint (a running bridge participant that can receive deliveries).
 *
 * The root cache is deliberately not touched by default: an endpoint is
 * registered by a long-running participant that already has its root from
 * configuration, and rewriting a global convenience file from inside a process is
 * how a test bridge once became the machine's remembered bridge.
 *
 * @param {string} root - the bridge root.
 * @param {object} input - endpoint fields.
 * @param {string} input.actor - the actor this endpoint belongs to.
 * @param {string} input.endpointId - stable endpoint name.
 * @param {string} [input.transport] - free-form transport label (in-process, mcp, acp, …).
 * @param {string[]} [input.sessions] - currently live session ids.
 * @param {boolean} [input.remember] - opt in to updating the shared root cache.
 * @returns {object} the stored endpoint.
 */
export function registerEndpoint(root, input) {
	ensureBridge(root, { remember: input.remember === true });
	const endpoint = {
		actor: requireName(input.actor, "actor"),
		endpointId: requireName(input.endpointId, "endpointId"),
		transport: String(input.transport ?? "in-process"),
		sessions: Array.isArray(input.sessions) ? input.sessions.map((session) => requireName(session, "sessionId")) : [],
		updatedAt: new Date().toISOString()
	};
	writeJson(join(root, "endpoints", `${endpoint.endpointId}.json`), endpoint);
	audit(root, { event: "endpoint.registered", endpointId: endpoint.endpointId, actor: endpoint.actor });
	return endpoint;
}

/** Read one endpoint, or null. */
export function getEndpoint(root, endpointId) {
	const path = join(root, "endpoints", `${requireName(endpointId, "endpointId")}.json`);
	return existsSync(path) ? readJson(path) : null;
}

/** All registered endpoints. */
export function listEndpoints(root) {
	return readAll(join(root, "endpoints")).filter((record) => record._corrupt === undefined);
}

/**
 * Bind a thread to one endpoint/session and a trust mode. This is the fix for
 * "actor ≠ session": without a binding, a delivery is never auto-routed.
 *
 * @param {string} root - the bridge root.
 * @param {object} input - binding fields.
 * @param {string} input.threadId - the logical conversation.
 * @param {string} input.endpointId - the endpoint that owns it.
 * @param {string} [input.sessionId] - the host session that owns it.
 * @param {string} [input.mode] - `advisory` (default) or `delegated`.
 * @returns {object} the stored binding.
 */
export function bindThread(root, input) {
	ensureBridge(root, { remember: false });
	const mode = MODES.includes(input.mode) ? input.mode : readManifest(root).defaultMode;
	const binding = {
		threadId: requireName(input.threadId, "threadId"),
		endpointId: requireName(input.endpointId, "endpointId"),
		...(input.sessionId ? { sessionId: requireName(input.sessionId, "sessionId") } : {}),
		mode,
		boundAt: new Date().toISOString()
	};
	writeJson(join(root, "bindings", `${binding.threadId}.json`), binding);
	audit(root, { event: "thread.bound", threadId: binding.threadId, endpointId: binding.endpointId, mode });
	return binding;
}

/** Read a thread binding, or null when unbound. */
export function getBinding(root, threadId) {
	const path = join(root, "bindings", `${requireName(threadId, "threadId")}.json`);
	return existsSync(path) ? readJson(path) : null;
}

/** All bindings. */
export function listBindings(root) {
	return readAll(join(root, "bindings")).filter((record) => record._corrupt === undefined);
}

// ---------------------------------------------------------------------------
// deliveries — the state machine
// ---------------------------------------------------------------------------

/**
 * Create a delivery: hand one message to one actor/endpoint/session.
 *
 * Routing rules (frozen design, §0.3.4):
 *   - `target: {…}`        an explicit target always wins;
 *   - `target: null`       explicitly unrouted — stays queued until a binding
 *                          exists, and no endpoint may auto-claim it;
 *   - `target` omitted     resolve the thread binding, else stay unrouted.
 *
 * The bridge never guesses a session, and it never invents a delivery the caller
 * did not ask for: an unrouted record is created only when delivery was
 * requested without a usable route.
 *
 * @param {string} root - the bridge root.
 * @param {object} input - delivery fields.
 * @param {string} input.messageId - the immutable message to deliver.
 * @param {object|null} [input.target] - `{actor, endpointId?, sessionId?}`, or null for unrouted.
 * @param {string} [input.mode] - trust mode; defaults to the binding or manifest.
 * @param {string} [input.deliveryId] - explicit id (tests, idempotent re-delivery).
 * @returns {object} the queued delivery.
 */
export function enqueueDelivery(root, input) {
	ensureBridge(root, { remember: false });
	const message = getMessage(root, input.messageId);
	if (!message) throw new Error(`harnessmux: unknown messageId ${JSON.stringify(input.messageId)}`);
	const binding = getBinding(root, message.threadId);
	const manifest = readManifest(root);
	const explicit = Object.hasOwn(input, "target") ? input.target : undefined;
	const target = explicit === null
		? null
		: explicit
			? {
				actor: requireName(explicit.actor, "target.actor"),
				...(explicit.endpointId ? { endpointId: requireName(explicit.endpointId, "target.endpointId") } : {}),
				...(explicit.sessionId ? { sessionId: requireName(explicit.sessionId, "target.sessionId") } : {})
			}
			: binding
				? {
					actor: binding.endpointId ? (getEndpoint(root, binding.endpointId)?.actor ?? binding.endpointId) : binding.endpointId,
					endpointId: binding.endpointId,
					...(binding.sessionId ? { sessionId: binding.sessionId } : {})
				}
				: null;
	const delivery = {
		deliveryId: input.deliveryId ? requireName(input.deliveryId, "deliveryId") : randomUUID(),
		messageId: message.messageId,
		target,
		threadId: message.threadId,
		mode: MODES.includes(input.mode) ? input.mode : (binding?.mode ?? manifest.defaultMode),
		attempt: 0,
		createdAt: new Date().toISOString()
	};
	const created = writeJsonExclusive(join(root, "queue", `${delivery.deliveryId}.json`), delivery);
	if (!created) throw new Error(`harnessmux: deliveryId ${delivery.deliveryId} already exists`);
	// A deliveryId is unique across queue/claims/acks for its whole lifetime: reusing
	// an acked id would rewrite history instead of creating a new attempt.
	if (existsSync(join(root, "claims", `${delivery.deliveryId}.json`)) || existsSync(join(root, "acks", `${delivery.deliveryId}.json`))) {
		removeQuietly(join(root, "queue", `${delivery.deliveryId}.json`));
		throw new Error(`harnessmux: deliveryId ${delivery.deliveryId} was already used (retry with a new deliveryId so the attempt history stays intact)`);
	}
	audit(root, { event: "delivery.enqueued", deliveryId: delivery.deliveryId, messageId: delivery.messageId, routed: target !== null, mode: delivery.mode });
	return delivery;
}

/** Read a delivery from whichever state it is in. */
export function getDelivery(root, deliveryId) {
	const id = requireName(deliveryId, "deliveryId");
	for (const dir of ["queue", "claims", "acks"]) {
		const path = join(root, dir, `${id}.json`);
		if (existsSync(path)) return { ...readJson(path), state: dir === "queue" ? "queued" : dir === "claims" ? "claimed" : "acked" };
	}
	return null;
}

/** All deliveries in one state ("queued" | "claimed" | "acked"). */
export function listDeliveries(root, state = "queued") {
	const dir = state === "queued" ? "queue" : state === "claimed" ? "claims" : "acks";
	return readAll(join(root, dir))
		.filter((record) => record._corrupt === undefined)
		.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/**
 * Claim a delivery under a lease.
 *
 * Atomicity: a unique `claims/<deliveryId>.json` is created first (a losing
 * concurrent claim fails with EEXIST), and only then is the queue entry removed.
 * A crash between the two leaves both files, which `reconcile()` repairs in the
 * claim's favour — the delivery is never lost and never double-owned.
 *
 * @param {string} root - the bridge root.
 * @param {string} deliveryId - the delivery to claim.
 * @param {object} [input] - `owner` (claim owner), `leaseMs` override.
 * @returns {object} `{claimed, reason?, claim?}`.
 */
export function claimDelivery(root, deliveryId, input = {}) {
	ensureBridge(root, { remember: false });
	const id = requireName(deliveryId, "deliveryId");
	const queuePath = join(root, "queue", `${id}.json`);
	const claimPath = join(root, "claims", `${id}.json`);
	const ackPath = join(root, "acks", `${id}.json`);
	// Order matters for truthful reporting: an ack beats a live claim, and a live
	// claim beats "nothing to claim". Checking the queue first would disguise a
	// held lease as a missing delivery.
	if (existsSync(ackPath)) return { claimed: false, reason: "already-acked" };
	const queued = existsSync(queuePath) ? readJson(queuePath) : null;
	if (queued === null) {
		if (existsSync(claimPath)) return { claimed: false, reason: "lease-held", claim: readJson(claimPath) };
		return { claimed: false, reason: "not-queued" };
	}
	const manifest = readManifest(root);
	const now = Date.now();
	const claim = {
		...queued,
		claimOwner: requireOwner(input.owner ?? `${process.pid}@${hostname()}`),
		claimedAt: new Date(now).toISOString(),
		leaseUntil: new Date(now + (Number.isFinite(input.leaseMs) ? input.leaseMs : manifest.leaseMs)).toISOString(),
		attempt: (queued.attempt ?? 0) + 1
	};
	// Unrouted deliveries must never be auto-claimed: the bridge does not guess a session.
	if (claim.target === null && input.allowUnrouted !== true) {
		return { claimed: false, reason: "unrouted" };
	}
	if (!writeJsonExclusive(claimPath, claim)) {
		const existing = readJson(claimPath);
		return { claimed: false, reason: "lease-held", claim: existing };
	}
	removeQuietly(queuePath);
	audit(root, { event: "delivery.claimed", deliveryId: id, owner: claim.claimOwner, attempt: claim.attempt });
	return { claimed: true, claim };
}

/**
 * Acknowledge a delivery: the host accepted it. This is NOT "the task is done".
 *
 * @param {string} root - the bridge root.
 * @param {string} deliveryId - the delivery to acknowledge.
 * @param {object} [input] - `owner` (must match the claim owner when claiming).
 * @returns {object} `{acked, reason?}`.
 */
export function ackDelivery(root, deliveryId, input = {}) {
	ensureBridge(root, { remember: false });
	const id = requireName(deliveryId, "deliveryId");
	const ackPath = join(root, "acks", `${id}.json`);
	if (existsSync(ackPath)) return { acked: true, reason: "already-acked" };
	const claimPath = join(root, "claims", `${id}.json`);
	const queuePath = join(root, "queue", `${id}.json`);
	if (!existsSync(claimPath) && !existsSync(queuePath)) return { acked: false, reason: "unknown-delivery" };
	const source = existsSync(claimPath) ? readJson(claimPath) : readJson(queuePath);
	if (existsSync(claimPath) && input.owner !== undefined && source.claimOwner !== input.owner) {
		return { acked: false, reason: "not-owner" };
	}
	writeJson(ackPath, {
		deliveryId: id,
		messageId: source.messageId,
		target: source.target,
		mode: source.mode,
		attempt: source.attempt ?? 0,
		ackedAt: new Date().toISOString(),
		...(input.note ? { note: String(input.note) } : {})
	});
	removeQuietly(claimPath);
	removeQuietly(queuePath);
	audit(root, { event: "delivery.acked", deliveryId: id, messageId: source.messageId });
	return { acked: true };
}

/**
 * Correlate one delivery with the host-side work it caused.
 *
 * This answers the question the automatic return path depends on: *which* host turn did this
 * HarnessMux delivery start? The record is deliberately **descriptive, not authoritative** — it
 * lives beside `queue/claims/acks` and never participates in routing, claiming or acking. Losing
 * one costs traceability for that delivery, never a delivery.
 *
 * Written after the host accepted the hand-off and before the ack, so a crash in between leaves an
 * ack missing (which the lease recovers) rather than a correlation claiming work that never began.
 *
 * @param {string} root - bridge root.
 * @param {object} input - the correlation:
 *   `deliveryId`, `messageId`, `threadId`, `originActor`, `originMessageId`, `endpointId`,
 *   `sessionId`, `bindingMode`, `deliveryMode`, `disposition`, and optional `turnId`/`turn` when
 *   the host exposes one.
 * @returns {{path: string, record: object, turnId: string|null}} where it was written.
 */
export function recordDispatch(root, input = {}) {
	ensureBridge(root, { remember: false });
	const deliveryId = requireName(input.deliveryId, "deliveryId");
	const turnId = typeof input.turnId === "string" && input.turnId.trim() !== "" ? input.turnId.trim() : null;
	const record = {
		deliveryId,
		messageId: typeof input.messageId === "string" ? input.messageId : null,
		threadId: typeof input.threadId === "string" ? input.threadId : null,
		originActor: typeof input.originActor === "string" ? input.originActor : null,
		originMessageId: typeof input.originMessageId === "string" ? input.originMessageId : null,
		endpointId: typeof input.endpointId === "string" ? input.endpointId : null,
		sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
		bindingMode: typeof input.bindingMode === "string" ? input.bindingMode : null,
		deliveryMode: typeof input.deliveryMode === "string" ? input.deliveryMode : null,
		disposition: typeof input.disposition === "string" ? input.disposition : null,
		// `null` is meaningful: the host did not expose a turn identity at hand-off time. Recording
		// the absence is how a later reader knows the difference between "not captured" and "none".
		turnId,
		...(Number.isInteger(input.turn) ? { turn: input.turn } : {}),
		recordedAt: new Date().toISOString()
	};
	const dir = join(root, "dispatches");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${deliveryId}.json`);
	writeJson(path, record);
	audit(root, { event: "delivery.dispatched", deliveryId, sessionId: record.sessionId, disposition: record.disposition });
	return { path, record, turnId };
}

/** The correlation record for one delivery, or null when none was written. */
export function getDispatch(root, deliveryId) {
	const path = join(root, "dispatches", `${requireName(deliveryId, "deliveryId")}.json`);
	return existsSync(path) ? readJson(path) : null;
}

/** Every correlation record, newest first. */
export function listDispatches(root) {
	const dir = join(root, "dispatches");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => {
			try {
				return readJson(join(dir, name));
			} catch {
				return null;
			}
		})
		.filter((record) => record !== null)
		.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
}

/**
 * Return a claimed delivery to the queue (hand-off failed). `attempt` is kept so
 * retries stay visible on the same deliveryId.
 *
 * @param {string} root - the bridge root.
 * @param {string} deliveryId - the delivery to release.
 * @returns {object} `{released, reason?}`.
 */
export function releaseDelivery(root, deliveryId, input = {}) {
	ensureBridge(root, { remember: false });
	const id = requireName(deliveryId, "deliveryId");
	const claimPath = join(root, "claims", `${id}.json`);
	if (!existsSync(claimPath)) return { released: false, reason: "not-claimed" };
	const claim = readJson(claimPath);
	const { claimOwner, claimedAt, leaseUntil, ...queued } = claim;
	writeJson(join(root, "queue", `${id}.json`), queued);
	removeQuietly(claimPath);
	audit(root, { event: "delivery.released", deliveryId: id, reason: input.reason ?? "manual" });
	return { released: true, attempt: queued.attempt };
}

/**
 * Repair state and expire stale leases.
 *
 * - claim + queue both present (crash between claim and unlink): drop the queue copy.
 * - claim whose lease expired: return it to the queue, incrementing nothing
 *   (the attempt was already counted at claim time).
 *
 * @param {string} root - the bridge root.
 * @param {object} [input] - `now` override for tests.
 * @returns {object} `{deduplicated: string[], expired: string[]}`.
 */
export function reconcile(root, input = {}) {
	ensureBridge(root, { remember: false });
	const now = Number.isFinite(input.now) ? input.now : Date.now();
	const deduplicated = [];
	const expired = [];
	for (const entry of listJson(join(root, "claims"))) {
		const id = entry.replace(/\.json$/u, "");
		if (existsSync(join(root, "queue", `${id}.json`))) {
			removeQuietly(join(root, "queue", `${id}.json`));
			deduplicated.push(id);
			continue;
		}
		let claim;
		try {
			claim = readJson(join(root, "claims", entry));
		} catch {
			continue;
		}
		const leaseUntil = Date.parse(claim.leaseUntil ?? "");
		if (Number.isFinite(leaseUntil) && leaseUntil <= now) {
			const { claimOwner, claimedAt, leaseUntil: _lease, ...queued } = claim;
			writeJson(join(root, "queue", `${id}.json`), queued);
			removeQuietly(join(root, "claims", entry));
			expired.push(id);
			audit(root, { event: "delivery.lease-expired", deliveryId: id, attempt: queued.attempt });
		}
	}
	return { deduplicated, expired };
}

/**
 * Verify the v2 state invariants. Used by tests and by `harnessmux verify`.
 *
 * Invariants (frozen design §0.3.5):
 *   1. every un-acked delivery is in exactly one of queue/claims;
 *   2. an acked delivery is in neither;
 *   3. every delivery references an existing immutable message;
 *   4. no queue/claim record is corrupt.
 *
 * Unrouted deliveries are **not** a violation: the frozen design requires them
 * to wait in the queue until an explicit binding, so they are reported
 * separately as `awaitingBinding`.
 *
 * @param {string} root - the bridge root.
 * @param {object} [input] - reserved for a `now` override.
 * @returns {{ok: boolean, violations: string[], awaitingBinding: string[], pending: number, claimed: number, acked: number}} the report.
 */
export function verifyInvariants(root, input = {}) {
	const violations = [];
	const awaitingBinding = [];
	const queued = listDeliveries(root, "queued");
	const claimed = listDeliveries(root, "claimed");
	const acked = listDeliveries(root, "acked");
	for (const record of [...readAll(join(root, "queue")), ...readAll(join(root, "claims")), ...readAll(join(root, "messages"))]) {
		if (record._corrupt) violations.push(`corrupt record: ${record._file}`);
	}
	const seen = new Set();
	for (const record of [...queued, ...claimed]) {
		const id = record.deliveryId;
		if (!id) {
			violations.push(`record without deliveryId: ${record._file}`);
			continue;
		}
		if (seen.has(id)) violations.push(`delivery ${id} is in both queue and claims`);
		seen.add(id);
		if (!getMessage(root, record.messageId)) violations.push(`delivery ${id} references missing message ${record.messageId}`);
		if (record.target === null) awaitingBinding.push(id);
		if (existsSync(join(root, "acks", `${id}.json`))) violations.push(`delivery ${id} is both un-acked and acked`);
	}
	for (const record of acked) {
		if (existsSync(join(root, "queue", `${record.deliveryId}.json`))) violations.push(`acked delivery ${record.deliveryId} is still queued`);
		if (existsSync(join(root, "claims", `${record.deliveryId}.json`))) violations.push(`acked delivery ${record.deliveryId} is still claimed`);
	}
	void input;
	return {
		ok: violations.length === 0,
		violations,
		awaitingBinding,
		pending: queued.length,
		claimed: claimed.length,
		acked: acked.length
	};
}

/** Bridge statistics. */
export function bridgeStatus(root) {
	return {
		root,
		exists: isBridgeRoot(root),
		version: existsSync(join(root, "bridge.json")) ? readManifest(root).version : null,
		messages: listJson(join(root, "messages")).length,
		queued: listJson(join(root, "queue")).length,
		claimed: listJson(join(root, "claims")).length,
		acked: listJson(join(root, "acks")).length,
		bindings: listJson(join(root, "bindings")).length,
		endpoints: listJson(join(root, "endpoints")).length,
		leaseMs: existsSync(join(root, "bridge.json")) ? readManifest(root).leaseMs : null
	};
}

/**
 * Apply audit retention. Deletes whole day-files older than `retentionDays` and
 * refuses to keep growing past `maxBytes` by removing the oldest day-files first.
 *
 * @param {string} root - the bridge root.
 * @param {object} [input] - `now` override for tests.
 * @returns {object} `{removed: string[], kept: number}`.
 */
export function gc(root, input = {}) {
	ensureBridge(root, { remember: false });
	const manifest = readManifest(root);
	const now = Number.isFinite(input.now) ? input.now : Date.now();
	const dir = join(root, "audit");
	const files = existsSync(dir) ? readdirSync(dir).filter((entry) => entry.endsWith(".jsonl")).sort() : [];
	const removed = [];
	const cutoff = now - manifest.audit.retentionDays * 24 * 60 * 60 * 1000;
	const kept = [];
	for (const entry of files) {
		const day = entry.replace(/\.jsonl$/u, "");
		const stamp = Date.parse(`${day}T00:00:00.000Z`);
		if (Number.isFinite(stamp) && stamp < cutoff) {
			removeQuietly(join(dir, entry));
			removed.push(entry);
		} else {
			kept.push(entry);
		}
	}
	let total = 0;
	const sizes = new Map();
	for (const entry of kept) {
		const size = readFileSync(join(dir, entry), "utf8").length;
		sizes.set(entry, size);
		total += size;
	}
	for (const entry of kept) {
		if (total <= manifest.audit.maxBytes) break;
		removeQuietly(join(dir, entry));
		removed.push(entry);
		total -= sizes.get(entry) ?? 0;
	}
	audit(root, { event: "audit.gc", removed: removed.length });
	return { removed, kept: kept.length - removed.filter((entry) => kept.includes(entry)).length };
}

/** Absolute path of something inside the bridge root. */
export function bridgePath(root, ...parts) {
	return join(root, ...parts);
}

/** Remove an empty directory (used by migrations). */
export function removeEmptyDir(path) {
	try {
		rmdirSync(path);
		return true;
	} catch {
		return false;
	}
}
