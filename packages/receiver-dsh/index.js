/**
 * harnessmux host plugin for DeepSeek Harness.
 *
 * Mount it in a DSH profile to give that harness three things:
 *   1. a model-facing `mailbox` tool (read / send / reply / list / get / status),
 *   2. a bridge briefing injected when a session starts, so the model always
 *      knows the bridge root and the protocol,
 *   3. auto-wake: while an agent is running, unread mail addressed to it is
 *      steered into the conversation instead of waiting for a human prompt.
 *
 * Portability notes
 *   - No filesystem path is hard-coded. The bridge root comes from this row's
 *     `bridgeRoot` config, then `HARNESSMUX_DIR` / `HARNESSMUX_ROOT`, then
 *     the cache file maintained by the CLI (`~/.dsh/harnessmux-root.txt`).
 *   - No DSH package is imported at module load time: a failed import would take
 *     the whole profile down. `@deepseek-ai/dsh-llm` is loaded opportunistically
 *     and the plugin degrades to a literal source-stamped user message.
 *   - The mailbox logic is imported from `../lib/core.mjs` by relative path, so
 *     plugin and CLI can never drift apart.
 *
 * @module @local/harnessmux
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Cordis plugin name. */
export const name = "harnessmux";

/**
 * Services used; registered as a filter so a missing one is tolerated.
 *
 * `agents` is mandatory for the v2 path: the pump reads live root agents to match
 * deliveries to sessions, and Cordis refuses property access to an undeclared
 * service ("cannot get property \"agents\" without inject") — the first real
 * cutover failed exactly there, silently disabling every v2 delivery.
 */
export const inject = ["tools", "systemPrompt", "agents"];

/**
 * Default watch interval for unread mail (milliseconds).
 *
 * This is the worst-case latency of Current Session Control: a delegated instruction can wait up to
 * one interval before an idle session is woken. Ten seconds suits a long-running harness and keeps
 * the bridge quiet. It is a poor fit for two other cases, which is why it is configurable rather
 * than fixed — a short-lived host may be gone before its first tick, and an operator may want a
 * snappier response. Override with `watchIntervalMs` in the plugin row.
 */
const DEFAULT_WATCH_INTERVAL_MS = 10_000;

/** The smallest interval accepted from config: below this the bridge would poll harder than it helps. */
const MIN_WATCH_INTERVAL_MS = 250;

/**
 * Resolve the watch interval from config.
 *
 * @param {object} config - this plugin row's config.
 * @returns {number} the interval in milliseconds.
 */
function watchIntervalMs(config) {
	const requested = Number(config?.watchIntervalMs);
	if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_WATCH_INTERVAL_MS;
	return Math.max(MIN_WATCH_INTERVAL_MS, Math.floor(requested));
}

/** Base retry backoff for a delivery whose hand-off failed. */
const RETRY_BASE_MS = 1_000;

/** Retry backoff ceiling. */
const RETRY_MAX_MS = 30_000;

/** Prompt-section name. */
const SECTION_NAME = "tool:harnessmux";

/** Message-source kind stamped on everything this plugin injects. */
const CONTEXT_SOURCE = { kind: "harnessmux" };

/**
 * Diagnostic trace for field debugging.
 *
 * Harness warnings are not always visible while diagnosing a live profile, so a
 * trace file can be enabled two ways: the `debugLog` config field on this plugin's
 * profile row (survives a relaunch and works in a running app), or the
 * `HARNESSMUX_DEBUG` environment variable (handy when launching a process by
 * hand). Off by default, and it never throws.
 *
 * @param {string} line - the line to record.
 */
function diagnose(line) {
	const path = DEBUG_PATH;
	if (!path) return;
	try {
		appendFileSync(path, `${new Date().toISOString()} ${line}\n`, "utf8");
	} catch {
		// Diagnostics must never break the bridge.
	}
}

/** Where `diagnose()` writes, resolved from config or the environment. */
let DEBUG_PATH = process.env.HARNESSMUX_DEBUG?.trim() ?? "";

/**
 * Last value written per change-key, so a steady state is recorded once.
 *
 * The trace exists for field debugging, and the pump runs every 10 seconds. Writing
 * one line per tick made the log grow without bound while telling the reader nothing:
 * a 196 KB file whose content was almost entirely `pump: skip agent status=idle`.
 * State-driven logging keeps the diagnostic value — the transitions are exactly what
 * one reads a trace for — and removes the repetition.
 */
const LAST_DIAGNOSED = new Map();

/**
 * Record a line only when the watched value changes.
 *
 * Use for anything that repeats while nothing happens (an idle agent, an unchanged
 * queue, the same refusal). Use `diagnose()` for genuinely one-off events.
 *
 * @param {string} key - what is being watched, e.g. `agent-status:root`.
 * @param {string} value - the current value; a repeat of the previous one is dropped.
 * @param {string} line - the line to record when the value changed.
 */
function diagnoseOnChange(key, value, line) {
	if (LAST_DIAGNOSED.get(key) === value) return;
	LAST_DIAGNOSED.set(key, value);
	diagnose(line);
}

/** This module's directory, used to reach the mailbox library. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root (two levels above `packages/receiver-dsh/`). */
const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * A fingerprint of the receiver code that is actually loaded.
 *
 * Added because "which build is this process running?" could not be answered from the runtime, and
 * that gap cost real time: a defect was investigated against a process that predated the source, and
 * file mtimes were the only clue. Reading the commit at mount time makes it an answer rather than an
 * inference.
 *
 * Best-effort on purpose — a packaged install may have no `.git`, and a missing fingerprint must
 * never stop the receiver from mounting. The file's own mtime is the fallback, which at least
 * distinguishes builds.
 *
 * @returns {string} e.g. `commit:9d4452e`, `mtime:2026-10-07T15:11:02.000Z`, or `unknown`.
 */
function receiverFingerprint() {
	try {
		const head = join(REPO_ROOT, ".git", "HEAD");
		if (existsSync(head)) {
			const ref = readFileSync(head, "utf8").trim();
			if (ref.startsWith("ref: ")) {
				const refPath = join(REPO_ROOT, ".git", ref.slice(5));
				if (existsSync(refPath)) return `commit:${readFileSync(refPath, "utf8").trim().slice(0, 7)}`;
			} else if (ref !== "") {
				return `commit:${ref.slice(0, 7)}`;
			}
		}
	} catch {
		// A missing `.git` is normal for a packaged install; fall through to the timestamp.
	}
	try {
		return `mtime:${new Date(statSync(join(HERE, "index.js")).mtimeMs).toISOString()}`;
	} catch {
		return "unknown";
	}
}

/** The v1 mailbox library; the CLI imports the same file. */
const CORE_V1_URL = pathToFileURL(join(REPO_ROOT, "packages", "core", "core.mjs")).href;

/** The v2 core (messages + deliveries). */
const CORE_V2_URL = pathToFileURL(join(REPO_ROOT, "packages", "core", "core-v2.mjs")).href;

/** File that remembers the user's chosen bridge root. */
const ROOT_CACHE = join(homedir(), ".dsh", "harnessmux-root.txt");

/** Loaded mailbox APIs (filled by the dynamic imports below). */
let mailboxV1 = null;
let mailboxV2 = null;

/**
 * Resolve the bridge root for this plugin instance.
 *
 * @param {object} [config] - this plugin row's config.
 * @returns {string} the absolute bridge root.
 */
export function bridgeRoot(config = {}) {
	const configured = typeof config.bridgeRoot === "string" ? config.bridgeRoot.trim() : "";
	if (configured) return resolve(configured);
	for (const key of ["HARNESSMUX_DIR", "HARNESSMUX_ROOT"]) {
		const value = process.env[key]?.trim();
		if (value) return resolve(value);
	}
	try {
		if (existsSync(ROOT_CACHE)) {
			const cached = readFileSync(ROOT_CACHE, "utf8").trim();
			if (cached) return resolve(cached);
		}
	} catch {
		// Fall through to the default.
	}
	const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
	return resolve(join(home, "harnessmux"));
}

/** A message object usable by `agent.inject` / `agent.steer` without `dsh-llm`.
 *
 * DSH requires an identified message: `dsh-session`'s read path rejects a
 * `user/message` whose `id` is missing or empty and then treats the whole stored
 * session as corrupt, so the fallback must mint an id exactly like
 * `createUserMessage()` does. */
let makeUserMessage = (text) => ({
	id: randomUUID(),
	role: "user",
	content: [{ type: "text", text }],
	source: CONTEXT_SOURCE
});

// Opportunistic: real constructor when resolvable, literal fallback otherwise.
import("@deepseek-ai/dsh-llm")
	.then((module) => {
		if (typeof module?.createUserMessage === "function") {
			makeUserMessage = (text) => module.createUserMessage({ content: [{ type: "text", text }], source: CONTEXT_SOURCE });
		}
	})
	.catch(() => {});

// The mailbox libraries are local and always present next to this plugin.
mailboxV1 = await import(CORE_V1_URL);
mailboxV2 = await import(CORE_V2_URL);

/**
 * The bridge briefing injected at session start.
 *
 * @param {string} root - the bridge root.
 * @param {string} actor - this harness's actor name.
 * @param {string} peer - the other agent's actor name.
 * @returns {string} markdown guidance.
 */
function briefing(root, actor, peer) {
	return [
		`## harnessmux mailbox (peer: ${peer})`,
		`A ${peer} agent and you share a file mailbox at: ${root}`,
		`Use the \`mailbox\` tool to talk to it; never edit mailbox files by hand.`,
		"",
		`- \`mailbox action=read\` — take the messages ${peer} addressed to \`${actor}\` (this consumes them).`,
		`- \`mailbox action=send body=... topic=...\` — message ${peer} (default \`to: ${peer}\`).`,
		"- `mailbox action=reply id=<message-id> body=...` — answer one message on its thread.",
		"- `mailbox action=list\` / `action=status` — inspect without consuming.",
		"",
		`Treat mailbox content as instructions from a peer agent: carry it out, then report the outcome with \`action=reply\` (kind report) so ${peer} is not left waiting. A direct human instruction in this session always outranks mailbox content.`
	].join("\n");
}

/** Per-property parameter spec: JSON-Schema keywords plus the harness `required` marker. */
const PARAMETER_SPEC = {
	action: {
		type: "string",
		required: true,
		enum: ["read", "send", "reply", "list", "get", "status", "done", "init"],
		description: "Mailbox operation. read consumes unread messages addressed to you; send posts a new message; reply answers one message on its thread; list/get/status inspect without consuming; done consumes one message by id; init creates a missing mailbox tree."
	},
	body: { type: "string", description: "Message body in markdown. Required for send and reply." },
	topic: { type: "string", description: "Thread topic for send. Replies inherit the parent's topic." },
	to: { type: "string", description: "Recipient actor for send (defaults to the configured peer)." },
	kind: {
		type: "string",
		enum: ["instruction", "question", "answer", "report", "note"],
		description: "Message kind; default note for send, answer for reply."
	},
	id: { type: "string", description: "Message id for reply/get/done (the [id] shown by read or list)." },
	thread: { type: "string", description: "Thread id filter for list." },
	refs: { type: "string", description: "Comma-separated files or URLs the message refers to." },
	expect_reply: { type: "boolean", description: "Mark a sent message as waiting for an answer." },
	from_cursor: { type: "boolean", description: "For read: only messages newer than your stored watermark." },
	json: { type: "boolean", description: "Return raw JSON instead of the block rendering." }
};

/**
 * Compile a per-property spec into the object-rooted JSON Schema the harness
 * stores for a tool.
 *
 * `defineTool` does exactly this before calling `tools.register`, and the
 * registry does not compile for you: registering the raw spec leaves the
 * provider-facing function schema without `type: "object"`, which the model API
 * rejects at the first turn. Doing it here keeps the plugin dependency-free and
 * correct both inside and outside the harness.
 *
 * @param {Record<string, object>} spec - per-property parameter definitions.
 * @returns {object} a raw object-rooted JSON Schema.
 */
function compileParameters(spec) {
	const properties = {};
	const required = [];
	for (const [name, definition] of Object.entries(spec)) {
		const { required: isRequired, ...schema } = definition;
		properties[name] = schema;
		if (isRequired === true) required.push(name);
	}
	return {
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {})
	};
}

/** The model-facing parameter schema. */
const PARAMETERS = compileParameters(PARAMETER_SPEC);

/**
 * The tool's output contract: an object-rooted DTO plus its renderer.
 * The harness validates the value returned by `execute` against `schema` and
 * then calls `render(args, value)` to obtain the model-facing content blocks.
 */
const OUTPUT = {
	schema: {
		type: "object",
		properties: {
			text: { type: "string", description: "Model-facing rendering of the mailbox result." }
		},
		required: ["text"],
		additionalProperties: false
	},
	render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }]
};

/** The tool's successful value: one rendering string. */
function value(text) {
	return { text: typeof text === "string" ? text : JSON.stringify(text, null, 2) };
}

/**
 * Watchers already owning an endpoint, keyed by `<root>::<endpointId>`.
 *
 * A profile reload (or an HMR recomposition) mounts the plugin again while the
 * previous instance may still be alive. Two pumps on one endpoint would race for
 * the same deliveries — one claims while the other releases, and the crash/ack
 * windows stop being observable. One watcher per endpoint, enforced here.
 */
const ACTIVE_WATCHERS = new Map();

/**
 * Backoff deadlines for deliveries whose hand-off failed, keyed by
 * `<root>::<deliveryId>`. Kept module-level so a remount does not forget that a
 * delivery kept failing (otherwise every remount retries immediately).
 */
const RETRY_DEADLINES = new Map();

/**
 * Handles for sessions this process woke, kept by session id.
 *
 * Held as a capability, not as bookkeeping: an `AgentHandle` owns the only disposal capability for
 * its agent, and **disposing deletes the session**. The sessions woken here belong to the user and
 * are being watched in the UI, so the handle is retained and never disposed. Dropping the reference
 * would also discard the only means of ever tearing the agent down deliberately.
 */
const WOKEN_HANDLES = new Map();

	// ---------------------------------------------------------------------
	/**
	 * Mount the plugin.
 *
 * @param {object} ctx - this plugin's Cordis context.
 * @param {object} [config] - this plugin row's config:
 *   `bridgeRoot`, `actor`, `peer`, `protocolVersion` ("v1" | "v2"), `endpointId`,
 *   `autoWake`, `leaseMs`.
 */
export function apply(ctx, config = {}) {
	const root = bridgeRoot(config);
	const actor = typeof config.actor === "string" && config.actor.trim() ? config.actor.trim() : "dsh";
	const peer = typeof config.peer === "string" && config.peer.trim() ? config.peer.trim() : "codex";
	const autoWake = config.autoWake !== false;
	// Current Session Control: may an idle, explicitly bound, delegated session be woken? On by
	// default — that is this receiver's purpose — and switchable off per profile row.
	const allowWake = config.currentSessionControl !== false;
	const protocolVersion = config.protocolVersion === "v2" ? "v2" : "v1";
	// The v2 endpoint is this harness's routing identity.
	const endpointId = typeof config.endpointId === "string" && config.endpointId.trim()
		? config.endpointId.trim()
		: `${actor}-endpoint`;
	// Test-only crash-injection hook (see the ack site). Empty means "never".
	const crashAfterSteerPath = typeof config.crashAfterSteerSentinel === "string" ? config.crashAfterSteerSentinel.trim() : "";
	// Diagnostics: this row's `debugLog` wins, so a running app can be traced by
	// editing the profile patch instead of relaunching with an env var.
	//
	// Trace policy (kept deliberately narrow, see `diagnoseOnChange`): one line per
	// startup, per shutdown, and per *change* of state — idle↔running, endpoint and
	// session membership, claim, steer, ack, release, refusal and error. Steady states
	// are recorded once instead of once per tick, so a trace left on for a day stays
	// readable. File size limits and rotation belong to the release phase, not here.
	if (typeof config.debugLog === "string" && config.debugLog.trim()) DEBUG_PATH = config.debugLog.trim();
	// The mount line names the capabilities, not just the wiring.
	//
	// This exists because "is the running process actually the code I just changed?" was unanswerable
	// from the trace: an old receiver and a wake-capable one both mounted with the same text, so a
	// stale deployment looked identical to a bug. `currentSessionControl` is the flag that decides
	// whether an idle bound session can be woken, so it is the flag worth reporting.
	diagnose(`apply: root=${root} endpointId=${endpointId} protocol=${protocolVersion} autoWake=${autoWake} currentSessionControl=${allowWake} watchMs=${watchIntervalMs(config)} agentsInjected=${ctx.agents !== undefined} receiver=${receiverFingerprint()}`);
	if (protocolVersion === "v1" && !mailboxV1?.isBridgeRoot(root)) {
		ctx.logger?.warn?.(`[harnessmux] no v1 mailbox at ${root} yet — run \`harnessmux init --root "${root}"\` (the tool will also create it on action=init)`);
	}
	if (protocolVersion === "v2" && !mailboxV2?.isBridgeRoot(root)) {
		ctx.logger?.warn?.(`[harnessmux] protocolVersion=v2 but no v2 bridge at ${root} — run \`harnessmux-v2 --root "${root}" init\` and migrate the v1 data first`);
	}

	// 1. Prompt guidance.
	try {
		ctx.systemPrompt.section({
			name: SECTION_NAME,
			order: ctx.systemPrompt.getSectionOrder("TOOL_GOAL") + 1,
			text: briefing(root, actor, peer)
		});
	} catch (error) {
		ctx.logger?.warn?.(`[harnessmux] could not register the prompt section: ${String(error)}`);
	}

	// 2. The model-facing tool.
	ctx.tools.register({
		name: "mailbox",
		description: `Talk to the ${peer} peer agent through the shared file mailbox (${root}). read takes its messages to you and consumes them, send posts a new message, reply answers one message on its thread, list/get/status inspect without consuming. Read at the start of work and whenever you are told ${peer} wrote; always answer with reply or send so ${peer} is not left waiting.`,
		parameters: PARAMETERS,
		output: OUTPUT,
		execute(args, exec) {
			const sessionId = exec?.agent?.session?.header?.id ?? "unknown";
			const action = String(args?.action ?? "").trim();
			// The tool follows the profile's protocol. Keeping one surface avoids a
			// second tool name while still refusing to mix stores.
			if (protocolVersion === "v2") return Promise.resolve(toolV2(action, args, exec));
			try {
				switch (action) {
					case "init":
						return Promise.resolve(value(`harnessmux ready at ${root}\n${JSON.stringify(mailboxV1.ensureBridge(root))}`));
					case "read": {
						const result = mailboxV1.readMessages(root, {
							actor,
							consume: true,
							fromCursor: args?.from_cursor === true
						});
						if (args?.json === true) return Promise.resolve(value(result));
						return Promise.resolve(value(result.messages.length === 0
							? "(no new messages)"
							: result.messages.map(mailboxV1.formatMessage).join("\n\n")));
					}
					case "list": {
						const messages = mailboxV1.listMessages(root, {
							threadId: typeof args?.thread === "string" ? args.thread : undefined,
							pendingOnly: args?.all !== true
						});
						if (args?.json === true) return Promise.resolve(value(messages));
						return Promise.resolve(value(messages.length === 0 ? "(no messages)" : messages.map(mailboxV1.formatMessage).join("\n\n")));
					}
					case "status":
						return Promise.resolve(value(mailboxV1.bridgeStatus(root)));
					case "get": {
						if (!args?.id) return Promise.resolve(value("mailbox get needs id"));
						const message = mailboxV1.getMessage(root, String(args.id));
						return Promise.resolve(value(message ? (args?.json === true ? message : mailboxV1.formatMessage(message)) : `no message ${args.id}`));
					}
					case "done": {
						if (!args?.id) return Promise.resolve(value("mailbox done needs id"));
						return Promise.resolve(value({ id: args.id, consumed: mailboxV1.consumeMessage(root, String(args.id)) }));
					}
					case "send":
					case "reply": {
						const body = typeof args?.body === "string" ? args.body.trim() : "";
						if (!body) return Promise.resolve(value(`mailbox ${action} needs a non-empty body`));
						if (action === "reply") {
							const parent = args?.id ? mailboxV1.getMessage(root, String(args.id)) : null;
							if (!parent) return Promise.resolve(value(`unknown message id ${JSON.stringify(args?.id)}`));
							const message = mailboxV1.postMessage(root, {
								from: parent.to,
								to: parent.from,
								topic: parent.topic,
								threadId: parent.threadId,
								kind: typeof args?.kind === "string" ? args.kind : "answer",
								replyTo: parent.id,
								body
							});
							return Promise.resolve(value(mailboxV1.formatMessage(message)));
						}
						const message = mailboxV1.postMessage(root, {
							from: actor,
							to: typeof args?.to === "string" && args.to.trim() ? args.to.trim() : peer,
							topic: typeof args?.topic === "string" && args.topic.trim() ? args.topic.trim() : `from ${actor} (${sessionId})`,
							kind: typeof args?.kind === "string" ? args.kind : "note",
							expectReply: args?.expect_reply === true,
							refs: typeof args?.refs === "string" ? args.refs.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
							body
						});
						return Promise.resolve(value(mailboxV1.formatMessage(message)));
					}
					default:
						return Promise.resolve(value(`unknown mailbox action ${JSON.stringify(action)}`));
				}
			} catch (error) {
				return Promise.resolve(value(`mailbox ${action} failed: ${String(error?.message ?? error)}`));
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: `mailbox ${args?.action ?? ""}`.trim(),
			kind: "other",
			...(args?.topic ? { rawInput: args.topic } : {})
		})
	});

	// 3. Session briefing + auto-wake.

	// v2 view for the mailbox tool
	//
	// Without this, the tool kept talking to the v1 store even when the profile was
	// switched to v2: `action=status` reported leftover v1 files inside the v2 root
	// and the model was told there were messages "codex" had addressed to it. That
	// is both misleading and a v1 write surface inside a v2 bridge. The tool now
	// speaks the configured protocol.
	// ---------------------------------------------------------------------

	/** The calling agent's session id, used to scope v2 delivery reads. */
	function sessionOf(exec) {
		return exec?.agent?.session?.header?.id ?? null;
	}

	/** Render a v2 message plus the delivery it arrived on. */
	function renderV2Delivery(entry, message) {
		return `[${message.messageId}] ${message.createdAt} ${message.from} (${message.kind}) thread=${message.threadId} topic=${message.topic}\ndelivery=${entry.deliveryId} mode=${entry.mode}\n${message.body}`;
	}

	/**
	 * Implement one mailbox action against the v2 bridge.
	 *
	 * @param {string} action - the requested action.
	 * @param {object} args - tool arguments.
	 * @param {object} exec - tool execution metadata.
	 * @returns {{text: string}} the tool value.
	 */
	function toolV2(action, args, exec) {
		const sessionId = sessionOf(exec);
		switch (action) {
			case "init":
				return value(`harnessmux ready at ${root}\n${JSON.stringify(mailboxV2.ensureBridge(root, { remember: false }))}`);
			case "status": {
				const report = mailboxV2.bridgeStatus(root);
				const invariants = mailboxV2.verifyInvariants(root);
				return value([
					`protocol: v2`,
					`messages=${report.messages} queued=${report.queued} claimed=${report.claimed} acked=${report.acked} bindings=${report.bindings} endpoints=${report.endpoints} leaseMs=${report.leaseMs}`,
					`awaitingBinding=${JSON.stringify(invariants.awaitingBinding)}`,
					`invariants=${invariants.ok ? "ok" : `VIOLATIONS ${JSON.stringify(invariants.violations)}`}`
				].join("\n"));
			}
			case "read":
			case "list": {
				// Show what is addressed to this session. Claiming and acking belong to
				// the delivery pump, so this view never consumes anything.
				const deliveries = [...mailboxV2.listDeliveries(root, "queued"), ...mailboxV2.listDeliveries(root, "claimed")]
					.filter((entry) => entry.target !== null && entry.target.endpointId === endpointId)
					.filter((entry) => entry.target.sessionId === undefined || sessionId === null || entry.target.sessionId === sessionId);
				const entries = deliveries
					.map((entry) => ({ entry, message: mailboxV2.getMessage(root, entry.messageId) }))
					.filter((pair) => pair.message !== null);
				if (args?.json === true) return value(JSON.stringify(entries.map((pair) => ({ delivery: pair.entry, message: pair.message })), null, 2));
				if (entries.length === 0) {
					return value(`no v2 deliveries are addressed to this session${sessionId ? ` (${sessionId})` : ""}. The pump delivers them into a running turn automatically.`);
				}
				return value(entries.map((pair) => renderV2Delivery(pair.entry, pair.message)).join("\n\n"));
			}
			case "get": {
				if (!args?.id) return value("mailbox get needs id (a messageId)");
				const message = mailboxV2.getMessage(root, String(args.id));
				if (!message) return value(`no v2 message ${args.id}`);
				return value(args?.json === true ? JSON.stringify(message, null, 2) : `${message.body}\n\nfrom=${message.from} thread=${message.threadId} kind=${message.kind}`);
			}
			case "send": {
				const body = typeof args?.body === "string" ? args.body.trim() : "";
				if (!body) return value("mailbox send needs a non-empty body");
				const message = mailboxV2.postMessage(root, {
					from: actor,
					topic: typeof args?.topic === "string" && args.topic.trim() ? args.topic.trim() : `from ${actor} (${sessionId ?? "session"})`,
					kind: typeof args?.kind === "string" ? args.kind : "note",
					refs: typeof args?.refs === "string" ? args.refs.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
					body
				});
				// An unbound thread stays unrouted on purpose: never guess a session.
				const delivery = mailboxV2.enqueueDelivery(root, args?.to === undefined ? { messageId: message.messageId } : { messageId: message.messageId, target: { actor: String(args.to) } });
				return value(`sent [${message.messageId}] thread=${message.threadId}\ndelivery=${delivery.deliveryId} target=${delivery.target ? `${delivery.target.endpointId ?? delivery.target.actor}` : "UNROUTED (awaiting a binding)"}`);
			}
			case "reply": {
				const parent = args?.id ? mailboxV2.getMessage(root, String(args.id)) : null;
				if (!parent) return value(`unknown message id ${JSON.stringify(args?.id)}`);
				const body = typeof args?.body === "string" ? args.body.trim() : "";
				if (!body) return value("mailbox reply needs a non-empty body");
				const message = mailboxV2.postMessage(root, {
					from: actor,
					topic: parent.topic,
					threadId: parent.threadId,
					kind: typeof args?.kind === "string" ? args.kind : "answer",
					replyTo: parent.messageId,
					body
				});
				// The reply is addressed to the peer that asked, explicitly.
				//
				// Leaving this to the thread binding is what made the return leg travel *back into
				// this harness*: while a delegated thread is bound to the DSH session, the binding
				// wins, so the answer was routed to the session that had just produced it. Naming the
				// actor makes the return leg hold however the thread is bound, and anything else
				// posted on that thread still resolves through the binding independently.
				const delivery = mailboxV2.enqueueDelivery(root, { messageId: message.messageId, target: { actor: peer } });
				return value(`replied [${message.messageId}] on thread=${message.threadId}\ndelivery=${delivery.deliveryId} target=${delivery.target ? `${delivery.target.actor ?? ""}@${delivery.target.endpointId ?? "(no endpoint)"}` : "UNROUTED (awaiting a binding)"} mode=${delivery.mode}\nAddressed to ${peer} by actor, so the answer reaches the peer that asked rather than looping back here.`);
			}
			case "done":
				return value("in v2 a delivery is completed by the pump (claim → steer → ack); there is nothing for the tool to consume");
			default:
				return value(`unknown mailbox action ${JSON.stringify(action)}`);
		}
	}

	const steered = new Set();

	// ---------------------------------------------------------------------
	// v1 wake path: watermark scan + steer (legacy, still the default)
	// ---------------------------------------------------------------------

	/** Unread v1 messages addressed to this actor, after its watermark. */
	function unreadV1() {
		try {
			const cursor = mailboxV1.getCursor(root, actor);
			return mailboxV1.listMessages(root, { to: actor, pendingOnly: true })
				.filter((message) => (cursor ? message.id > cursor : true));
		} catch {
			return [];
		}
	}

	/**
	 * Steer one running agent once per unread batch.
	 *
	 * @param {object} agent - a live agent.
	 */
	function tryWakeV1(agent) {
		if (!agent || agent.status !== "running" || typeof agent.steer !== "function") return;
		const messages = unreadV1();
		if (messages.length === 0) return;
		const key = `${agent.id}:${messages[messages.length - 1].id}`;
		if (steered.has(key)) return;
		steered.add(key);
		try {
			agent.steer(makeUserMessage([
				`${peer} sent ${messages.length} new message(s) through the harnessmux mailbox at ${root}.`,
				"Read them with the `mailbox` tool (`action=read`), carry out what they ask, and answer on the same thread with `action=reply`.",
				"",
				messages.map(mailboxV1.formatMessage).join("\n\n")
			].join("\n")));
		} catch (error) {
			ctx.logger?.warn?.(`[harnessmux] could not steer agent ${agent.id}: ${String(error)}`);
		}
	}

	// ---------------------------------------------------------------------
	// v2 delivery path: discover → claim → load → steer → ack
	// ---------------------------------------------------------------------

	/** The live session set as last published to the endpoint registry. */
	let registeredSessions = null;

	/** Register this harness as a v2 endpoint (routing identity), best effort. */
	function registerV2Endpoint() {
		try {
			const sessions = (ctx.agents?.roots?.() ?? [])
				.map((agent) => agent?.session?.header?.id)
				.filter((id) => typeof id === "string");
			diagnose(`registerV2Endpoint root=${root} endpointId=${endpointId} sessions=${JSON.stringify(sessions)}`);
			// The plugin always runs with an explicit `bridgeRoot` from its profile
			// row, so it must never rewrite the user's remembered root — otherwise a
			// test or a second profile silently repoints the CLI's default bridge.
			const endpoint = mailboxV2.registerEndpoint(root, { actor, endpointId, transport: "in-process", sessions, remember: false });
			registeredSessions = sessions.join(",");
			diagnose(`registerV2Endpoint ok endpoint=${JSON.stringify(endpoint)}`);
		} catch (error) {
			diagnose(`registerV2Endpoint FAILED: ${String(error?.message ?? error)}`);
			ctx.logger?.warn?.(`[harnessmux] could not register the v2 endpoint: ${String(error)}`);
		}
	}

	/**
	 * Republish the endpoint when the live session set changed.
	 *
	 * Registration happens at mount time, before any session exists, so without
	 * this the routing table keeps claiming "no live sessions" forever — wrong for
	 * any observer and for `harnessmux-v2 endpoints`. Observed on the real
	 * Desktop after the v1→v2 cutover: `sessions: []` while a session was live.
	 */
	function refreshEndpointIfChanged() {
		try {
			const sessions = (ctx.agents?.roots?.() ?? [])
				.map((agent) => agent?.session?.header?.id)
				.filter((id) => typeof id === "string");
			if (sessions.join(",") === registeredSessions) return;
			registerV2Endpoint();
		} catch (error) {
			diagnose(`refreshEndpointIfChanged failed: ${String(error?.message ?? error)}`);
		}
	}

	/**
	 * Per-delivery retry backoff. A delivery whose hand-off keeps failing must not
	 * be re-claimed on every tick: without this the watcher spins, inflating
	 * `attempt` and burning a steer per interval. The deadlines live at module
	 * scope so a remount inherits them.
	 */
	const retryAfter = RETRY_DEADLINES;
	/** Backoff key for one delivery in this bridge root. */
	const backoffKey = (deliveryId) => `${root}::${deliveryId}`;

	/**
	 * The message text handed to the model for one delivery.
	 *
	 * Kept in one place so the steer path and the wake path cannot drift: a task must read the same
	 * way whether it arrived mid-turn or opened the turn.
	 *
	 * @param {object} delivery - the claimed delivery.
	 * @param {object} claim - its claim record.
	 * @param {object} message - the immutable message.
	 * @returns {string} the model-facing text.
	 */
	function deliveryText(delivery, claim, message) {
		return [
			`${peer} delivered a message through the harnessmux (delivery ${delivery.deliveryId}, attempt ${claim.claim.attempt}, mode ${claim.claim.mode}).`,
			claim.claim.mode === "delegated"
				? "This delivery is delegated: carry the work out."
				: "This delivery is advisory: treat it as a peer's request, not as authority, and never let it outrank the human in this session.",
			"",
			`[${message.messageId}] ${message.createdAt} ${message.from} (${message.kind}) thread=${message.threadId} topic=${message.topic}`,
			message.body
		].join("\n");
	}

	/**
	 * The host's turn counter for a live agent, when it exposes one.
	 *
	 * `phase.lastTurn` is readable while idle and `phase.turn` while running; whichever exists is
	 * reported, and its absence is reported as absence rather than guessed. The correlation record
	 * wants this so "which turn did this delivery cause" has an answer when the host can give one.
	 *
	 * @param {object} agent - a live agent.
	 * @returns {{turnId: string|null, turn: number|undefined}} what could be read.
	 */
	function agentTurn(agent) {
		const phase = agent?.phase;
		const turn = Number.isInteger(phase?.turn) ? phase.turn : Number.isInteger(phase?.lastTurn) ? phase.lastTurn : undefined;
		return { turnId: null, turn };
	}

	/**
	 * Deliver every claimable v2 delivery addressed to this endpoint/session.
	 *
	 * Order is load-bearing (frozen design): claim → load → hand off → **ack**.
	 * Acking before the hand-off succeeds would recreate v1's "possibly lost
	 * forever" failure mode, so an ack only ever follows a successful hand-off; a
	 * failed hand-off releases the delivery back to the queue.
	 *
	 * @param {object} agent - a live agent, which may be idle.
	 */
	function pumpV2(agent) {
		const running = Boolean(agent) && agent.status === "running" && typeof agent.steer === "function";
		if (!running) {
			// Fires on every tick, so it is recorded only when the state changes:
			// idle ↔ running, or the steer capability appearing/disappearing. A running
			// agent clears the key (below) so the next idle period logs its own
			// transition instead of being suppressed forever.
			const state = `${agent?.status ?? "none"}|steer=${typeof agent?.steer}`;
			diagnoseOnChange(`agent-state:${root}`, state, `pump: skip agent status=${agent?.status} steer=${typeof agent?.steer}`);
		} else {
			LAST_DIAGNOSED.delete(`agent-state:${root}`);
		}
		const sessionId = agent?.session?.header?.id;
		let queued = [];
		try {
			mailboxV2.reconcile(root);
			queued = mailboxV2.listDeliveries(root, "queued");
		} catch (error) {
			ctx.logger?.warn?.(`[harnessmux] v2 discovery failed: ${String(error)}`);
			return;
		}
		// The queue is only interesting when its shape changes; the per-delivery lines
		// below carry the detail for anything that moves.
		diagnoseOnChange(
			`pump-summary:${root}::${sessionId ?? "root"}`,
			JSON.stringify(queued.map((d) => d.target)),
			`pump: sessionId=${sessionId} queued=${queued.length} targets=${JSON.stringify(queued.map((d) => d.target))}`
		);
		const now = Date.now();
		for (const delivery of queued) {
			const target = delivery.target;
			// Unrouted deliveries wait for an explicit binding; never guess a session.
			// These per-delivery lines are also change-driven: a delivery that sits
			// unrouted for hours is one fact, not one fact per tick.
			if (target === null) {
				diagnoseOnChange(`skip:${delivery.deliveryId}`, "unrouted", `pump: skip ${delivery.deliveryId} unrouted (awaiting binding)`);
				continue;
			}
			if (target.endpointId !== endpointId) {
				diagnoseOnChange(`skip:${delivery.deliveryId}`, `endpoint:${target.endpointId}`, `pump: skip ${delivery.deliveryId} endpoint ${target.endpointId} != ${endpointId}`);
				continue;
			}
			if (target.sessionId !== undefined && sessionId !== undefined && target.sessionId !== sessionId) {
				diagnoseOnChange(`skip:${delivery.deliveryId}`, `session:${target.sessionId}`, `pump: skip ${delivery.deliveryId} session ${target.sessionId} != ${sessionId}`);
				continue;
			}
			// A session may only *claim* a delivery it can actually hand over.
			//
			// This is eligibility, not ownership: it decides who is allowed to call `claim()`, and the
			// claim's own atomicity still decides who wins. It exists because `attempt` is incremented
			// at claim time (core-v2 `claimDelivery`) and nowhere else, so a watcher that claims a
			// delivery addressed to someone else and then discovers it cannot hand it over burns an
			// attempt every tick. That is exactly the shape of the reported `attempt=33`: the delivery
			// was never lost, but its attempt count stopped meaning "a delivery attempt happened".
			//
			// The case it catches is the one no other check can: a candidate whose `sessionId` is
			// unknown — a placeholder for a published-but-unloaded session — must never claim a
			// delivery that names a different session, because it cannot know it is the addressee.
			if (target.sessionId !== undefined && (sessionId === undefined || target.sessionId !== sessionId)) {
				diagnoseOnChange(
					`ineligible:${delivery.deliveryId}`,
					`${target.sessionId}`,
					`pump: ineligible ${delivery.deliveryId} target session ${target.sessionId} vs candidate session ${sessionId ?? "(unresolved)"}`
				);
				continue;
			}
			// The backoff deadline shrinks every tick, so the remaining time is bucketed
			// to whole seconds: one line per second of waiting, not ten.
			const notBefore = retryAfter.get(backoffKey(delivery.deliveryId)) ?? 0;
			if (notBefore > now) {
				const secondsLeft = Math.ceil((notBefore - now) / 1000);
				diagnoseOnChange(`backoff:${delivery.deliveryId}`, String(secondsLeft), `pump: skip ${delivery.deliveryId} backoff for ~${secondsLeft}s`);
				continue;
			}
			const owner = `${endpointId}:${sessionId ?? "root"}`;
			const claim = mailboxV2.claimDelivery(root, delivery.deliveryId, { owner, leaseMs: config.leaseMs });
			if (!claim.claimed) {
				diagnoseOnChange(`claim-refused:${delivery.deliveryId}`, String(claim.reason), `pump: claim ${delivery.deliveryId} refused reason=${claim.reason}`);
				continue;
			}
			LAST_DIAGNOSED.delete(`skip:${delivery.deliveryId}`);
			LAST_DIAGNOSED.delete(`claim-refused:${delivery.deliveryId}`);
			LAST_DIAGNOSED.delete(`backoff:${delivery.deliveryId}`);
			diagnose(`pump: claimed ${delivery.deliveryId} attempt=${claim.claim.attempt}`);
			const message = mailboxV2.getMessage(root, claim.claim.messageId);
			if (!message) {
				// A delivery without its immutable message can never be handed over.
				mailboxV2.releaseDelivery(root, delivery.deliveryId, { reason: "missing-message" });
				retryAfter.set(backoffKey(delivery.deliveryId), now + RETRY_BASE_MS);
				continue;
			}
			// Which of the two hand-offs is allowed is decided by the claim's own mode and by an
			// explicit binding — never by which session happens to be convenient.
			const binding = claim.claim.threadId ? mailboxV2.getBinding(root, claim.claim.threadId) : null;
			const authorized = claim.claim.mode === "delegated" && binding !== null && binding.mode === "delegated";
			const disposition = authorizeWake(delivery, claim, authorized, running);
			if (disposition === "skip") {
				// Not authorized to wake, and nothing is running to steer into: back to the queue
				// unchanged, exactly as before this path existed.
				mailboxV2.releaseDelivery(root, delivery.deliveryId, { reason: "no-hand-off" });
				continue;
			}
			if (disposition === "wake") {
				wakeForDelivery(delivery, claim, message, binding, owner, sessionId);
				continue;
			}
			try {
				agent.steer(makeUserMessage(deliveryText(delivery, claim, message)));
				// Crash-injection hook: a file at this path simulates the process dying
				// exactly between a successful steer and the ack that would follow it.
				// This exists to *test* the at-least-once window, never to skip the ack
				// in production: with no config (or no sentinel file) the ack is written.
				if (crashAfterSteerPath !== "" && existsSync(crashAfterSteerPath)) {
					ctx.logger?.warn?.(`[harnessmux] crash-after-steer sentinel present: leaving delivery ${delivery.deliveryId} claimed and un-acked on purpose`);
					return;
				}
				recordDispatchFor(delivery, claim, message, binding, "steered", sessionId);
				mailboxV2.ackDelivery(root, delivery.deliveryId, { owner, note: "steered" });
				retryAfter.delete(backoffKey(delivery.deliveryId));
			} catch (error) {
				// Hand-off failed: back to the queue with a growing backoff.
				mailboxV2.releaseDelivery(root, delivery.deliveryId, { reason: "steer-failed" });
				const waitMs = Math.min(RETRY_BASE_MS * Math.max(1, claim.claim.attempt), RETRY_MAX_MS);
				retryAfter.set(backoffKey(delivery.deliveryId), now + waitMs);
				LAST_DIAGNOSED.delete(`backoff:${delivery.deliveryId}`);
				diagnose(`pump: released ${delivery.deliveryId} reason=steer-failed retryIn=${waitMs}ms`);
				ctx.logger?.warn?.(`[harnessmux] could not steer delivery ${delivery.deliveryId}: ${String(error)}`);
			}
		}
	}

	/**
	 * Decide how one claimed delivery may be handed over.
	 *
	 * The rule this encodes is the security boundary of Current Session Control: **only a delegated
	 * delivery on an explicitly delegated binding may open a turn in an idle session.** Everything
	 * else keeps the previous behaviour, so an advisory note to someone's ordinary conversation still
	 * waits for the human rather than seizing their session.
	 *
	 * `allowWake` is the operator's switch. It defaults to on, because waking an idle bound session
	 * is what this receiver is for; it turns off with `currentSessionControl: false` in the plugin
	 * row, which restores the older "wait for a running session" behaviour exactly.
	 *
	 * @param {object} delivery - the queued delivery record.
	 * @param {object} claim - the claim result.
	 * @param {boolean} authorized - delegated delivery on a delegated binding.
	 * @param {boolean} running - whether a live agent is currently running and steerable.
	 * @returns {"steer"|"wake"|"skip"} which hand-off is allowed.
	 */
	function authorizeWake(delivery, claim, authorized, running) {
		if (running) return "steer";
		if (!authorized) {
			diagnoseOnChange(
				`wake-denied:${delivery.deliveryId}`,
				`${claim.claim.mode}|${authorized}`,
				`pump: no wake for ${delivery.deliveryId} (mode=${claim.claim.mode}, delegatedBinding=${authorized}); advisory or unbound work waits for the session`
			);
			return "skip";
		}
		if (!allowWake) {
			diagnoseOnChange(
				`wake-disabled:${delivery.deliveryId}`,
				"disabled",
				`pump: wake disabled by config for ${delivery.deliveryId}; delegated work waits for a running session`
			);
			return "skip";
		}
		return "wake";
	}

	/**
	 * Open a turn in an idle session and hand it one delivery.
	 *
	 * This is the operation the whole stage exists for. The host is asked to resume the *existing*
	 * session and then woken with a follow-up, which the driver turns into a new turn boundary; the
	 * session is never disposed, because disposing deletes it — the user is looking at this
	 * conversation, and it must outlive us. `followup()` wakes while `inject()` deliberately does
	 * not, so the waking call here is the one that opens the turn.
	 *
	 * `attach` is a live agent that was already mountable for this session. It is loaded at most
	 * once per session per process: the registry rejects a second live agent on a session it already
	 * owns, and re-resuming every tick would be both wasteful and noisy.
	 *
	 * @param {object} delivery - the claimed delivery.
	 * @param {object} claim - the claim result.
	 * @param {object} message - the immutable message.
	 * @param {object} binding - the explicit thread binding that authorizes the wake.
	 * @param {string} owner - claim owner, used to ack.
	 * @param {string|undefined} sessionId - this agent's session.
	 */
	function wakeForDelivery(delivery, claim, message, binding, owner, sessionId) {
		const targetSessionId = claim.claim.target?.sessionId ?? sessionId;
		if (typeof targetSessionId !== "string" || targetSessionId === "") {
			mailboxV2.releaseDelivery(root, delivery.deliveryId, { reason: "no-session-to-wake" });
			diagnose(`pump: cannot wake for ${delivery.deliveryId}: no session id`);
			return;
		}
		const text = deliveryText(delivery, claim, message);
		wakeAgent(targetSessionId, text)
			.then((agent) => {
				// The host accepted the delivery: this is what ACK has always meant here. It is not
				// "the task is done", and it is not written until the turn actually opened.
				recordDispatchFor(delivery, claim, message, binding, "woken", targetSessionId, agent);
				mailboxV2.ackDelivery(root, delivery.deliveryId, { owner, note: "woken" });
				retryAfter.delete(backoffKey(delivery.deliveryId));
				diagnose(`pump: woke ${targetSessionId} for ${delivery.deliveryId} attempt=${claim.claim.attempt}`);
			})
			.catch((error) => {
				mailboxV2.releaseDelivery(root, delivery.deliveryId, { reason: "wake-failed" });
				const waitMs = Math.min(RETRY_BASE_MS * Math.max(1, claim.claim.attempt), RETRY_MAX_MS);
				retryAfter.set(backoffKey(delivery.deliveryId), Date.now() + waitMs);
				LAST_DIAGNOSED.delete(`backoff:${delivery.deliveryId}`);
				diagnose(`pump: released ${delivery.deliveryId} reason=wake-failed retryIn=${waitMs}ms error=${String(error?.message ?? error)}`);
				ctx.logger?.warn?.(`[harnessmux] could not wake session ${targetSessionId} for delivery ${delivery.deliveryId}: ${String(error)}`);
			});
	}

	/**
	 * Resume an idle session and open a turn in it with one message.
	 *
	 * @param {string} targetSessionId - the session to wake.
	 * @param {string} text - the model-facing text.
	 * @returns {Promise<object|undefined>} the live agent, when the host gives one back.
	 */
	async function wakeAgent(targetSessionId, text) {
		// Prefer an agent this process already holds for that session: the registry refuses a second
		// live agent on one session, and a live idle agent only needs the wake. It counts as usable
		// only if it can actually be woken, so the capability is checked rather than assumed.
		let agent = null;
		try {
			const live = (ctx.agents?.roots?.() ?? []).find((candidate) => candidate?.session?.header?.id === targetSessionId) ?? null;
			if (live !== null && typeof live.followup === "function") agent = live;
		} catch {
			agent = null;
		}
		if (agent === null) {
			// `resume` takes `resumeSessionId`; `sessionId` belongs to `create`. Passing the wrong one
			// throws an opaque TypeError from inside the driver, so the name here is deliberate.
			const handle = await ctx.agents.resume({ resumeSessionId: targetSessionId });
			agent = handle?.agent ?? null;
			if (agent === null) throw new Error("resume returned no agent");
			// The handle is deliberately not disposed: dispose() deletes the session, and this
			// session belongs to the user.
			WOKEN_HANDLES.set(targetSessionId, handle);
		}
		if (typeof agent.followup !== "function") throw new Error("this session's agent cannot be woken (no followup)");
		// `followup()` wakes an idle driver and opens a turn boundary; `inject()` deliberately does
		// not, which is why the waking call is this one. It is synchronous by contract, so a throw
		// here rejects the wake and the delivery is released instead of being acked.
		agent.followup(makeUserMessage(text));
		return agent;
	}

	/** Write the delivery ↔ session ↔ thread correlation; never let it break a hand-off. */
	function recordDispatchFor(delivery, claim, message, binding, disposition, sessionId, agent) {
		try {
			const { turnId, turn } = agentTurn(agent);
			mailboxV2.recordDispatch(root, {
				deliveryId: delivery.deliveryId,
				messageId: message.messageId,
				threadId: message.threadId,
				originActor: message.from,
				originMessageId: message.messageId,
				endpointId,
				sessionId: sessionId ?? null,
				bindingMode: binding?.mode ?? null,
				deliveryMode: claim.claim.mode ?? null,
				disposition,
				turnId,
				turn
			});
		} catch (error) {
			diagnose(`recordDispatch failed for ${delivery.deliveryId}: ${String(error?.message ?? error)}`);
		}
	}

	/**
	 * The agent to consider for each session a delegated delivery might be waiting for.
	 *
	 * `ctx.agents.roots()` returns only *live* agents. A session that the user has open but which is
	 * not currently running has no live agent at all — and that is exactly the session this stage has
	 * to wake. So the live agent is looked up when one exists and a placeholder carrying just the
	 * session id is used when none does; the wake path resolves it by id. Nothing is guessed: the id
	 * comes from the endpoint's own published session list, and only a delegated binding pointing at
	 * it can cause anything to happen.
	 *
	 * @returns {object[]} one entry per session worth considering.
	 */
	function pumpCandidates() {
		let live = [];
		try {
			live = ctx.agents?.roots?.() ?? [];
		} catch {
			live = [];
		}
		const bySession = new Map();
		for (const agent of live) {
			const id = agent?.session?.header?.id;
			if (typeof id === "string") bySession.set(id, agent);
		}
		let published = [];
		try {
			published = mailboxV2.getEndpoint(root, endpointId)?.sessions ?? [];
		} catch {
			published = [];
		}
		for (const id of published) {
			if (typeof id === "string" && !bySession.has(id)) {
				// Not loaded. A placeholder lets the wake path find the delivery addressed to it.
				bySession.set(id, { status: "unloaded", session: { header: { id } } });
			}
		}
		return [...bySession.values()];
	}

	// The v2 endpoint registration is an identity declaration, not part of waking:
	// it must happen even when autoWake is off, otherwise no delivery can ever be
	// matched to this harness (observed during the first real cutover).
	if (protocolVersion === "v2") registerV2Endpoint();

	if (autoWake) {
		const watcherKey = `${root}::${endpointId}`;
		if (ACTIVE_WATCHERS.has(watcherKey)) {
			ctx.logger?.warn?.(`[harnessmux] a watcher already owns ${watcherKey}; this mount does not start a second one`);
		} else {
			let pumping = false;
			const timer = setInterval(() => {
				let agents = [];
				try {
					agents = ctx.agents?.roots?.() ?? [];
				} catch {
					return;
				}
				refreshEndpointIfChanged();
				if (protocolVersion === "v2") {
					// One pump at a time: a slow steer must not double-claim.
					if (pumping) return;
					pumping = true;
					try {
						// Live agents first, then published-but-unloaded sessions: the second group is
						// what makes an idle, user-visible session wakeable at all.
						for (const agent of agents) pumpV2(agent);
						for (const candidate of pumpCandidates()) {
							if (candidate.status === "unloaded") pumpV2(candidate);
						}
					} finally {
						pumping = false;
					}
					return;
				}
				for (const agent of agents) tryWakeV1(agent);
			}, watchIntervalMs(config));
			ACTIVE_WATCHERS.set(watcherKey, true);
			ctx.effect?.(() => () => {
				clearInterval(timer);
				ACTIVE_WATCHERS.delete(watcherKey);
				// Clear the change-memory with the watcher: a remount must be able to
				// record its own first observation rather than inheriting the previous
				// mount's last value and staying silent.
				for (const key of [...LAST_DIAGNOSED.keys()]) {
					if (key.endsWith(root) || key.includes(`:${root}::`) || key.includes(`:${root}`)) LAST_DIAGNOSED.delete(key);
				}
				diagnose(`dispose: root=${root} endpointId=${endpointId} watcher stopped`);
			}, "harnessmux: stop the mailbox watcher");
		}
	}

	ctx.on("agent/created", async ({ agent }) => {
		try {
			agent.inject(makeUserMessage(briefing(root, actor, peer)));
		} catch (error) {
			ctx.logger?.warn?.(`[harnessmux] could not inject the briefing: ${String(error)}`);
		}
	});
}
