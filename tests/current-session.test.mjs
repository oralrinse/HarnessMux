/**
 * Current Session Control — receiver behaviour.
 *
 * The stage's whole point is one decision: may an **idle** session be woken? These tests pin that
 * decision, and the negative cases matter more than the positive one — an advisory note to someone's
 * ordinary conversation must never seize their session, and nothing may be guessed from ordering.
 *
 * The pump's hand-off is observed through a fake context whose agent records what was done to it, so
 * the assertions are about behaviour rather than about the trace text.
 *
 * Run: node tests/current-session.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../packages/core/core-v2.mjs";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");
const PLUGIN = pathToFileURL(join(HERE, "..", "packages", "receiver-dsh", "index.js")).href;
/** The client's own pickup hook, run as the client runs it. */
const HOOK = join(HERE, "..", "packages", "adapter-codex", "scripts", "pending.mjs");

/** The watch interval the plugin uses; the tests wait a little longer than one tick. */
const TICK_MS = 10_000;

/**
 * Load the receiver plugin.
 *
 * @returns {Promise<object>} the module.
 */
const plugin = await import(PLUGIN);

/**
 * Flatten a message object into searchable text, whatever shape it has.
 *
 * A real user message is `{content: [...], source: {...}}`, not a bare string, so assertions look at
 * the flattened text rather than one assumed field.
 *
 * @param {object} message - the message a hand-off passed to the host.
 * @returns {string} its textual content.
 */
function messageText(message) {
	const parts = [];
	const walk = (value, depth) => {
		if (depth > 6 || value === null || value === undefined) return;
		if (typeof value === "string") {
			parts.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry, depth + 1);
			return;
		}
		if (typeof value === "object") for (const entry of Object.values(value)) walk(entry, depth + 1);
	};
	walk(message, 0);
	return parts.join("\n");
}

/**
 * Build a fake context around one agent.
 *
 * @param {object} agent - the agent the watcher will see.
 * @param {object} [options] - `extraSessions` are published by the endpoint but not live.
 * @returns {object} the context, the agent, and everything done to it.
 */
function mockContext(agent, options = {}) {
	const effects = [];
	const steered = [];
	const followups = [];
	const resumed = [];
	const live = [agent];
	return {
		agent,
		steered,
		followups,
		resumed,
		ctx: {
			logger: { warn() {}, info() {} },
			systemPrompt: { getSectionOrder: () => 5000, section: () => {} },
			tools: { register: () => {} },
			agents: {
				roots: () => live,
				resume: async (input) => {
					resumed.push(input);
					const resumedAgent = {
						status: "idle",
						session: { header: { id: input.resumeSessionId } },
						followup: (message) => followups.push({ sessionId: input.resumeSessionId, message }),
						steer: (message) => steered.push({ sessionId: input.resumeSessionId, message })
					};
					live.push(resumedAgent);
					return { agent: resumedAgent, dispose: () => {} };
				}
			},
			on: () => {},
			effect: (factory) => {
				const disposer = factory();
				if (typeof disposer === "function") effects.push(disposer);
			}
		},
		dispose() {
			for (const disposer of effects.splice(0)) disposer();
		},
		/**
		 * Wait one watch tick plus a margin, then report.
		 *
		 * @returns {Promise<void>} resolves after the pump has had a chance to run.
		 */
		async tick() {
			await new Promise((resolve) => setTimeout(resolve, TICK_MS + 1_500));
		}
	};
}

/**
 * Create a bridge with one delivery addressed to a session.
 *
 * @param {string} root - bridge root.
 * @param {object} input - `sessionId`, `mode` (delivery mode), `bindingMode` (or null for no binding).
 * @returns {object} the identifiers.
 */
function seedDelivery(root, input) {
	const message = core.postMessage(root, { from: "codex", topic: "csc", kind: "instruction", body: `Reply with exactly: ${input.body ?? "MARKER"}` });
	if (input.bindingMode !== null && input.bindingMode !== undefined) {
		core.bindThread(root, { threadId: message.threadId, endpointId: "dsh-endpoint", sessionId: input.sessionId, mode: input.bindingMode });
	}
	const delivery = core.enqueueDelivery(root, {
		messageId: message.messageId,
		actor: "dsh",
		endpointId: "dsh-endpoint",
		sessionId: input.sessionId,
		...(input.mode ? { mode: input.mode } : {})
	});
	return { message, delivery };
}

// --- 1. delegated + explicitly bound + idle  ->  woken ---------------------------
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-csc-wake-"));
	const sessionId = "session-csc-wake";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { delivery } = seedDelivery(root, { sessionId, mode: "delegated", bindingMode: "delegated", body: "CSC_WAKE_MARKER" });

	// The agent exists and is idle: this is the case the stage exists for.
	const idle = { status: "idle", steer: () => {}, followup: (message) => mock.followups.push({ sessionId, message }), session: { header: { id: sessionId } } };
	const mock = mockContext(idle);
	plugin.apply(mock.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", debugLog: join(root, "trace.log") });
	try {
		await mock.tick();
		assert.equal(mock.followups.length, 1, "an idle bound session is woken exactly once");
		assert.equal(mock.steered.length, 0, "nothing is steered into an idle session");
		const text = messageText(mock.followups[0].message);
		assert.match(text, /CSC_WAKE_MARKER/u, "the delivery body reaches the model");
		assert.match(text, /delegated/u, "and it is presented as delegated work");

		const state = core.getDelivery(root, delivery.deliveryId);
		assert.equal(state.state, "acked", "the delivery is acked once the host accepted it");
		assert.equal(state.attempt, 1, "on the first attempt");
		assert.equal(state.note, "woken", "and the ack records how it was handed over");
		assert.equal(core.listDeliveries(root, "claimed").length, 0, "no claim is left dangling");

		const dispatches = core.listDispatches(root);
		assert.equal(dispatches.length, 1, "the delivery is correlated with the work it caused");
		assert.equal(dispatches[0].deliveryId, delivery.deliveryId, "by delivery id");
		assert.equal(dispatches[0].sessionId, sessionId, "and the session it landed in");
		assert.equal(dispatches[0].disposition, "woken", "recording which hand-off was used");
		assert.equal(dispatches[0].threadId, core.getMessage(root, dispatches[0].messageId).threadId, "and the thread to answer on");
	} finally {
		mock.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- 2. advisory + bound + idle  ->  NOT woken ----------------------------------
// The security boundary: a peer's note must not take over a conversation the human is having.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-csc-advisory-"));
	const sessionId = "session-csc-advisory";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { delivery } = seedDelivery(root, { sessionId, mode: "advisory", bindingMode: "advisory" });

	const idle = { status: "idle", steer: () => {}, session: { header: { id: sessionId } } };
	const mock = mockContext(idle);
	plugin.apply(mock.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", debugLog: join(root, "trace.log") });
	try {
		await mock.tick();
		assert.equal(mock.followups.length, 0, "an advisory delivery never opens a turn");
		assert.equal(mock.resumed.length, 0, "and never resumes the session");
		const state = core.getDelivery(root, delivery.deliveryId);
		assert.equal(state.state, "queued", "it waits in the queue for the human instead");
		assert.equal(core.listDispatches(root).length, 0, "with no dispatch record, because nothing was dispatched");
	} finally {
		mock.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- 3. delegated delivery but NO binding  ->  NOT woken ------------------------
// The delivery is delegated, yet nothing says which session authorizes it. Guessing is forbidden.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-csc-unbound-"));
	const sessionId = "session-csc-unbound";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { delivery } = seedDelivery(root, { sessionId, mode: "delegated", bindingMode: null });

	const idle = { status: "idle", steer: () => {}, session: { header: { id: sessionId } } };
	const mock = mockContext(idle);
	plugin.apply(mock.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", debugLog: join(root, "trace.log") });
	try {
		await mock.tick();
		assert.equal(mock.followups.length, 0, "a delegated delivery without an explicit binding is not woken");
		assert.equal(core.getDelivery(root, delivery.deliveryId).state, "queued", "it stays queued until a binding names a session");
	} finally {
		mock.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- 4. running agent  ->  steered, never woken ---------------------------------
// A session already working keeps its turn: the wake path must not open a second one.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-csc-running-"));
	const sessionId = "session-csc-running";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { delivery } = seedDelivery(root, { sessionId, mode: "delegated", bindingMode: "delegated", body: "CSC_RUNNING_MARKER" });

	const steered = [];
	const running = {
		status: "running",
		steer: (message) => steered.push(message),
		session: { header: { id: sessionId } }
	};
	const mock = mockContext(running);
	plugin.apply(mock.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", debugLog: join(root, "trace.log") });
	try {
		await mock.tick();
		assert.equal(steered.length, 1, "a running session is steered into its current turn");
		assert.equal(mock.followups.length, 0, "and never woken with a follow-up");
		assert.match(messageText(steered[0]), /CSC_RUNNING_MARKER/u, "the body reaches the running turn");
		const state = core.getDelivery(root, delivery.deliveryId);
		assert.equal(state.state, "acked", "the delivery is acked");
		assert.equal(state.note, "steered", "recording the steering hand-off");
		assert.equal(core.getDispatch(root, delivery.deliveryId)?.disposition, "steered", "and the correlation says the same");
	} finally {
		mock.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- 5. the wake switch restores the old behaviour ------------------------------
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-csc-off-"));
	const sessionId = "session-csc-off";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { delivery } = seedDelivery(root, { sessionId, mode: "delegated", bindingMode: "delegated" });

	const idle = { status: "idle", steer: () => {}, session: { header: { id: sessionId } } };
	const mock = mockContext(idle);
	plugin.apply(mock.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", currentSessionControl: false, debugLog: join(root, "trace.log") });
	try {
		await mock.tick();
		assert.equal(mock.followups.length, 0, "with the switch off, an idle session is not woken");
		assert.equal(core.getDelivery(root, delivery.deliveryId).state, "queued", "and the delivery waits as it used to");
	} finally {
		mock.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- 6. the correlation store is descriptive only -------------------------------
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-csc-record-"));
	core.ensureBridge(root, { remember: false });
	try {
		core.recordDispatch(root, {
			deliveryId: "d-1",
			messageId: "m-1",
			threadId: "t-1",
			originActor: "codex",
			originMessageId: "m-1",
			endpointId: "dsh-endpoint",
			sessionId: "s-1",
			bindingMode: "delegated",
			deliveryMode: "delegated",
			disposition: "woken"
		});
		const record = core.getDispatch(root, "d-1");
		assert.equal(record.turnId, null, "an absent host turn identity is recorded as absent, not invented");
		assert.equal(record.threadId, "t-1", "the thread to answer on is recorded");
		assert.equal(core.listDispatches(root).length, 1, "and the record is listable");

		// A dispatch record is not a delivery: it must not appear in the delivery state machine.
		assert.equal(core.listDeliveries(root, "queued").length, 0, "no delivery is invented by recording a dispatch");
		assert.equal(core.listDeliveries(root, "acked").length, 0, "and none is acked by it");
		assert.equal(core.verifyInvariants(root).ok, true, "the bridge invariants are untouched");
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- 7. the return leg does not depend on how the thread is bound ----------------
// Observed before this existed: a delegated thread stays bound to the DSH session, so binding-first
// routing sent the answer *back into the session that had just produced it* — the sender never saw
// it. Addressing the reply by actor fixes that without touching the binding, and both halves are
// asserted so a future change cannot quietly reintroduce the loop.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-csc-return-"));
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "codex", endpointId: "codex-endpoint", transport: "mcp-stdio", sessions: ["session-cx"], remember: false });
	try {
		core.bindThread(root, { threadId: "t-return", endpointId: "dsh-endpoint", sessionId: "session-dsh", mode: "delegated" });
		const instruction = core.postMessage(root, { from: "codex", threadId: "t-return", topic: "x", kind: "instruction", body: "do it" });
		const answer = core.postMessage(root, { from: "dsh", threadId: "t-return", topic: "x", kind: "report", replyTo: instruction.messageId, body: "done" });

		// What the receiver's `reply` now does.
		const addressed = core.enqueueDelivery(root, { messageId: answer.messageId, target: { actor: "codex" } });
		assert.equal(addressed.target.actor, "codex", "the answer is addressed to the peer that asked");
		assert.equal(addressed.target.endpointId, undefined, "by actor, not by this harness's own endpoint");

		// The binding is untouched, so anything else on the thread still resolves through it.
		assert.equal(core.getBinding(root, "t-return").endpointId, "dsh-endpoint", "the delegated binding is not rewritten by replying");
		const other = core.enqueueDelivery(root, { messageId: instruction.messageId });
		assert.equal(other.target.endpointId, "dsh-endpoint", "other posts on the thread still follow the binding");

		assert.equal(core.verifyInvariants(root).ok, true, "the bridge invariants hold");
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- 8. the whole loop, without a human ------------------------------------------
// The point of the feature is a round trip nobody has to push along, so it is asserted as one:
// the receiver wakes an idle bound session, the session's answer is addressed to the asker, and the
// client's own pickup hook surfaces it — the same hook Codex runs on SessionStart/UserPromptSubmit.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-csc-loop-"));
	const codexHome = mkdtempSync(join(tmpdir(), "hxmux-csc-loop-home-"));
	core.ensureBridge(root, { remember: false });
	const sessionId = "session-csc-loop";
	const marker = "LOOP_MARKER_1";
	core.registerEndpoint(root, { actor: "codex", endpointId: "codex-endpoint", transport: "mcp-stdio", sessions: ["session-cx"], remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });

	// The waking agent answers exactly the way the receiver's `reply` does, so the assertion covers
	// the real shape of an answer rather than a hand-built one.
	let answered = null;
	// Declared before the plugin is mounted: the pump runs from the first tick, and a callback that
	// references this binding would otherwise hit the temporal dead zone and fail inside a promise
	// chain — which looks like "the session was not woken" rather than like a test bug.
	const instructions = core.postMessage(root, { from: "codex", topic: "loop", kind: "instruction", body: "check the receiver" });
	const agent = {
		status: "idle",
		steer: () => {},
		session: { header: { id: sessionId } },
		followup: () => {
			// What the receiver's `reply` does, expressed through the core so the answer has the real
			// shape rather than a hand-built one.
			answered = core.postMessage(root, {
				from: "dsh",
				topic: "loop",
				threadId: instructions.threadId,
				kind: "report",
				replyTo: instructions.messageId,
				body: `${marker} — the session woke itself and answered.`
			});
			core.enqueueDelivery(root, { messageId: answered.messageId, target: { actor: "codex" } });
		}
	};
	const mock = mockContext(agent);
	plugin.apply(mock.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", debugLog: join(root, "trace.log") });
	try {
		core.bindThread(root, { threadId: instructions.threadId, endpointId: "dsh-endpoint", sessionId, mode: "delegated" });
		const delivery = core.enqueueDelivery(root, { messageId: instructions.messageId, actor: "dsh", endpointId: "dsh-endpoint", sessionId, mode: "delegated" });

		await mock.tick();

		// The waking agent's `followup` is the answer itself, so the wake is proven by the answer
		// existing — checking an array it does not push to would assert the wrong thing.
		assert.notEqual(answered, null, "nobody touched the harness: the idle session was woken");
		assert.equal(core.getDelivery(root, delivery.deliveryId).state, "acked", "the instruction is acked");
		assert.notEqual(answered, null, "the session answered on the thread");

		const hook = execFileSync(process.execPath, [HOOK, "--actor", "codex"], {
			encoding: "utf8",
			env: { ...process.env, HARNESSMUX_DIR: root, CODEX_HOME: codexHome }
		});
		assert.match(hook, new RegExp(marker, "u"), "the client's pickup hook surfaces the answer");
		assert.match(hook, new RegExp(instructions.threadId, "u"), "and names the thread to answer on");
		assert.equal(hook.trim() === "", false, "a waiting answer produces context, not silence");

		// Discovery is not consumption: the answer is still there for the tools to read.
		const stillQueued = core.listDeliveries(root, "queued").filter((entry) => entry.messageId === answered.messageId);
		assert.equal(stillQueued.length, 1, "reading via the hook does not consume the answer");
		assert.equal(core.verifyInvariants(root).ok, true, "and the bridge invariants hold after a full loop");
	} finally {
		mock.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
		rmSync(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- 9. the plugin file itself stays tied to the documented contract -------------
{
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	assert.match(source, /resumeSessionId/u, "the wake path uses resume's own option name");
	assert.equal(source.includes("handle.dispose()"), false, "and never disposes the handle it holds, because that would delete the user's session");
	assert.match(source, /target: \{ actor: peer \}/u, "the reply addresses the peer by actor rather than trusting the binding");
	assert.match(source, /currentSessionControl=\$\{allowWake\}/u, "the mount line reports the capability, so a stale deployment is distinguishable from a bug");
	assert.equal(existsSync(join(HERE, "..", "packages", "receiver-dsh", "index.js")), true, "the receiver exists where the tests expect it");
}

console.log("current-session.test.mjs: all assertions passed");
