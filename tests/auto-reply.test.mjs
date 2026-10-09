/**
 * Automatic final reply — the return leg.
 *
 * The stage this pins is the one that makes "the executor finished" become "the Commander has the
 * result". Capture was already measured to work; what is new here is that the captured answer travels
 * back **exactly once**, and that the two halves of the trip are distinguishable facts:
 *
 *   completed      the work is done
 *   reply_pending  an answer is owed and not yet recorded as sent
 *   replied        the answer has left for the Commander
 *
 * The dangerous window is between posting the reply and recording that it was posted. A process that
 * dies there leaves a message the Commander can already read and a record that does not know about it,
 * so a naive retry sends a second one. The reply's request id is derived from the execution and the
 * answer's sequence for exactly that reason: the retry computes the same key, the mailbox returns the
 * message that exists, and nothing is sent twice.
 *
 * Run: node tests/auto-reply.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../packages/core/core-v2.mjs";
import * as execution from "../packages/core/execution.mjs";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");
const plugin = await import(pathToFileURL(join(HERE, "..", "packages", "receiver-dsh", "index.js")).href);

/** Wait longer than one watch tick, so the pump has certainly run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 1_200));

/**
 * A fake host context around one session, as the receiver sees it.
 *
 * @param {string} sessionId - the session.
 * @returns {object} the context, the session, and what was done to it.
 */
function mockContext(sessionId) {
	const effects = [];
	const followups = [];
	const resumed = [];
	const session = {
		header: { id: sessionId },
		// A real session's log is never empty: the host records its own setup first. Seeding those two
		// events matters, because the dispatch baseline is the last sequence present, and events below it
		// are deliberately not attributed to a delivery.
		log: [
			{ type: "permission/preset", seq: 0, data: { preset: "standard" } },
			{ type: "sandbox/mode", seq: 1, data: { mode: "workspace-write" } }
		]
	};
	const agent = {
		status: "idle",
		session,
		steer: (message) => steered.push(message),
		followup: (message) => followups.push(message)
	};
	const steered = [];
	const live = [agent];
	return {
		agent,
		session,
		followups,
		steered,
		ctx: {
			logger: { warn() {}, info() {} },
			systemPrompt: { getSectionOrder: () => 5000, section: () => {} },
			tools: { register: () => {} },
			agents: {
				roots: () => live,
				resume: async (input) => {
					resumed.push(input);
					return { agent, dispose: () => {} };
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
		}
	};
}

/** The delegating message: the execution's origin, thread and reply target all come from it. */
function seedInstruction(root, sessionId, body) {
	const message = core.postMessage(root, { from: "codex", topic: `auto-reply-${sessionId}`, kind: "instruction", body });
	core.bindThread(root, { threadId: message.threadId, endpointId: "dsh-endpoint", sessionId, mode: "delegated" });
	const delivery = core.enqueueDelivery(root, {
		messageId: message.messageId,
		actor: "dsh",
		endpointId: "dsh-endpoint",
		sessionId,
		mode: "delegated"
	});
	return { message, delivery };
}

/**
 * Append the turn a host would have run for the delivered work.
 *
 * @param {object} session - the mock session.
 * @param {string} text - the visible answer, or "" for a turn that produced none.
 * @param {number} turn - the turn number.
 * @returns {{startSeq: number, endSeq: number, messageSeq: number|null}} where the events landed.
 */
function appendTurn(session, text, turn) {
	let seq = session.log.length;
	const push = (type, data) => {
		session.log.push({ type, seq, data });
		return seq++;
	};
	const startSeq = push("turn/start", { turn });
	push("step/start", { turn, step: 1 });
	push("user/message", { id: `user-${turn}`, role: "user", content: [{ type: "text", text: "do the work" }] });
	const messageSeq = push("assistant/message", {
		turn,
		step: 1,
		message: { role: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text }] }
	});
	push("step/end", { turn, step: 1 });
	const endSeq = push("turn/end", { turn, reason: { kind: "completed" } });
	return { startSeq, endSeq, messageSeq: text === "" ? null : messageSeq };
}

/** Every automatic reply on the bridge, oldest first. */
const automaticReplies = (root) =>
	core.listMessages(root).filter((message) => message.from === "dsh" && String(message.clientRequestId ?? "").startsWith("auto-final:"));

// --- A1. the reply's identity is derived, not generated -----------------------
// A random id would make every crash a second reply, which is the failure this design exists to stop.
{
	const id = execution.autoReplyRequestId("exec-1", 28);
	assert.equal(id, "auto-final:exec-1:28", "the request id names the execution and the answer's sequence");
	assert.equal(execution.autoReplyRequestId("exec-1", 28), id, "and is stable across calls");
	assert.notEqual(execution.autoReplyRequestId("exec-1", 29), id, "a different answer is a different reply");
	assert.notEqual(execution.autoReplyRequestId("exec-2", 28), id, "and a different execution is too");
	assert.equal(execution.autoReplyRequestId("exec-1", null), "", "no sequence means no reply id, rather than a guessable one");
	assert.equal(execution.autoReplyRequestId("", 28), "", "and no execution means no reply id either");
}

// --- A2. only a completed turn with a real answer owes a reply ----------------
// Everything else stays a diagnosable state. An empty message must never be sent, and an errored turn
// must never be dressed up as a result.
{
	const base = {
		executionId: "exec-x",
		state: "completed",
		reason: { kind: "completed" },
		finalText: "the answer",
		finalAssistantMessageSeq: 28,
		automaticReplyMessageId: null,
		explicitFinalReplyMessageId: null,
		threadId: "T1",
		originActor: "codex"
	};
	assert.equal(execution.owesAutomaticReply(base), true, "a completed turn with text and a reply target owes a reply");
	assert.equal(execution.owesAutomaticReply({ ...base, finalText: "" }), false, "completed with no visible text owes nothing");
	assert.equal(execution.owesAutomaticReply({ ...base, finalText: "   " }), false, "and neither does whitespace dressed up as an answer");
	assert.equal(execution.owesAutomaticReply({ ...base, finalAssistantMessageSeq: null }), false, "an answer with no message anchor cannot be replied to");
	assert.equal(execution.owesAutomaticReply({ ...base, state: "running" }), false, "a running turn owes nothing yet");
	assert.equal(execution.owesAutomaticReply({ ...base, state: "failed" }), false, "an errored turn is not a result");
	assert.equal(execution.owesAutomaticReply({ ...base, reason: { kind: "error" } }), false, "and its reason is checked as well as its state");
	assert.equal(execution.owesAutomaticReply({ ...base, reason: { kind: "tool-calls" } }), false, "an unknown terminal reason is not evidence of success");
	assert.equal(execution.owesAutomaticReply({ ...base, automaticReplyMessageId: "M-already" }), false, "an already answered execution owes nothing");
	assert.equal(execution.owesAutomaticReply({ ...base, explicitFinalReplyMessageId: "M-explicit" }), false, "and neither does one the executor already answered itself");
	assert.equal(execution.owesAutomaticReply({ ...base, threadId: "" }), false, "a reply with no thread to answer on is refused rather than guessed");
	assert.equal(execution.owesAutomaticReply({ ...base, originActor: "" }), false, "and one with nobody to answer");
	assert.equal(execution.owesAutomaticReply(null), false, "and nothing owes nothing");
}

// --- A3. the two halves of the trip are separate states -----------------------
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-reply-states-"));
	core.ensureBridge(root, { remember: false });
	try {
		const record = execution.beginExecution(root, {
			deliveryId: "D-reply",
			originMessageId: "M-reply",
			threadId: "T-reply",
			originActor: "codex",
			sessionId: "session-reply",
			dispatchKind: "followup",
			baselineLogSeq: 4
		});
		execution.openTurn(root, record.executionId, { turn: 1, turnStartSeq: 5 });
		execution.attachAttempt(root, record.executionId, { attemptId: "session-reply:1", turn: 1 });
		execution.endTurn(root, record.executionId, { turn: 1, reason: { kind: "completed" }, turnEndSeq: 12 });
		execution.setFinalAnswer(root, record.executionId, { finalText: "the answer", assistantMessageSeq: 10, turn: 1 });
		let current = execution.getExecution(root, record.executionId);
		assert.equal(current.state, "completed", "a finished turn is completed, not yet replied");
		assert.equal(execution.owesAutomaticReply(current), true, "and now owes the answer back");
		assert.equal(execution.outstandingExecution(root, "session-reply")?.executionId, record.executionId, "a completed-but-unreplied execution is still this session's outstanding work, so its turn can still be attributed");
		assert.equal(execution.pendingAutoReplies(root).length, 1, "and it is listed as owing a reply");

		// Owed, then sent. The id is only recorded by the write-back, which is the window that crashes.
		execution.markReplyPending(root, record.executionId, { requestId: "auto-final:x:10" });
		current = execution.getExecution(root, record.executionId);
		assert.equal(current.state, "reply_pending", "an owed reply is pending rather than completed");
		assert.equal(current.automaticReplyMessageId, null, "with nothing recorded as sent");
		assert.equal(execution.owesAutomaticReply(current), true, "so a restart would retry it");
		assert.equal(execution.pendingAutoReplies(root).length, 1, "and a restart would find it");

		execution.setAutomaticReply(root, record.executionId, { messageId: "M-reply-1", requestId: "auto-final:x:10" });
		current = execution.getExecution(root, record.executionId);
		assert.equal(current.state, "replied", "recording the message completes the return leg");
		assert.equal(current.automaticReplyMessageId, "M-reply-1", "with the message that carried it");
		assert.equal(current.automaticReplyRequestId, "auto-final:x:10", "and the key it was posted under");
		assert.equal(execution.owesAutomaticReply(current), false, "and it owes nothing more");
		assert.equal(execution.pendingAutoReplies(root).length, 0, "so no reconciler will touch it again");

		// A turn that errored is an explained outcome, not unresolved work.
		const failed = execution.beginExecution(root, { deliveryId: "D-failed", sessionId: "session-reply", dispatchKind: "followup" });
		execution.openTurn(root, failed.executionId, { turn: 2, turnStartSeq: 20 });
		execution.endTurn(root, failed.executionId, { turn: 2, reason: { kind: "error" }, turnEndSeq: 24 });
		assert.equal(execution.getExecution(root, failed.executionId).state, "failed", "an errored turn fails the execution");
		assert.equal(execution.staleExecutions(root, -1).some((entry) => entry.executionId === failed.executionId), false, "and a failed turn is not reported as unresolved forever");
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- A4. an explicit final reply is the answer; a progress one is not ---------
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-reply-explicit-"));
	core.ensureBridge(root, { remember: false });
	try {
		const record = execution.beginExecution(root, { deliveryId: "D-explicit", originMessageId: "M-origin", threadId: "T-explicit", originActor: "codex", sessionId: "session-e", dispatchKind: "followup" });
		execution.openTurn(root, record.executionId, { turn: 1, turnStartSeq: 5 });
		execution.endTurn(root, record.executionId, { turn: 1, reason: { kind: "completed" }, turnEndSeq: 12 });
		execution.setFinalAnswer(root, record.executionId, { finalText: "the answer", assistantMessageSeq: 10, turn: 1 });

		execution.recordExplicitReply(root, record.executionId, { messageId: "M-progress", disposition: "progress" });
		let current = execution.getExecution(root, record.executionId);
		assert.deepEqual(current.explicitReplyMessageIds, ["M-progress"], "a progress reply is recorded");
		assert.equal(current.explicitFinalReplyMessageId, null, "but is not the result");
		assert.equal(execution.owesAutomaticReply(current), true, "so the result still has to come back");

		// The same message recorded twice is one fact.
		execution.recordExplicitReply(root, record.executionId, { messageId: "M-progress", disposition: "progress" });
		assert.deepEqual(execution.getExecution(root, record.executionId).explicitReplyMessageIds, ["M-progress"], "recording the same reply again does not duplicate it");

		execution.recordExplicitReply(root, record.executionId, { messageId: "M-final", disposition: "final" });
		current = execution.getExecution(root, record.executionId);
		assert.deepEqual(current.explicitReplyMessageIds, ["M-progress", "M-final"], "the final reply is recorded too");
		assert.equal(current.explicitFinalReplyMessageId, "M-final", "and marked as the result");
		assert.equal(execution.owesAutomaticReply(current), false, "so the automatic reply is suppressed: one final answer, not two");
		assert.equal(execution.pendingAutoReplies(root).length, 0, "and nothing is owed");

		// An unknown or absent disposition is treated as progress: a forgotten flag costs a duplicate,
		// never a silently missing result.
		const other = execution.beginExecution(root, { deliveryId: "D-default", originMessageId: "M-origin", threadId: "T-explicit", originActor: "codex", sessionId: "session-e2", dispatchKind: "followup" });
		execution.recordExplicitReply(root, other.executionId, { messageId: "M-default", disposition: undefined });
		assert.equal(execution.getExecution(root, other.executionId).explicitFinalReplyMessageId, null, "a reply with no disposition is not treated as the result");
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- A5. the whole return leg, through the receiver ---------------------------
// Idle bound session → delegated delivery → its own turn → the answer goes back on the thread it came
// from, addressed to the actor that asked, once.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-reply-e2e-"));
	const sessionId = "session-auto-reply";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { message, delivery } = seedInstruction(root, sessionId, "AUTO_REPLY_TASK: do the work");
	const mock = mockContext(sessionId);
	plugin.apply(mock.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", actor: "dsh", peer: "codex", watchIntervalMs: 250, debugLog: join(root, "trace.log") });
	try {
		await tick();
		assert.equal(mock.followups.length, 1, "the idle bound session is woken with the delegated task");
		assert.equal(core.getDelivery(root, delivery.deliveryId).state, "acked", "and the delivery is acked");

		// The host runs its turn and produces an answer.
		const turn = appendTurn(mock.session, "the delegated answer", 2);
		await tick();

		const replies = automaticReplies(root);
		assert.equal(replies.length, 1, "the captured answer travels back exactly once");
		const reply = replies[0];
		assert.equal(reply.threadId, message.threadId, "on the thread the work arrived on");
		assert.equal(reply.replyTo, message.messageId, "answering the message that asked");
		assert.equal(reply.body, "the delegated answer", "carrying the answer itself, byte for byte");
		assert.equal(reply.from, "dsh", "from this harness");
		const replyDelivery = core.listDeliveries(root, "queued").find((row) => row.messageId === reply.messageId);
		assert.notEqual(replyDelivery, undefined, "with a delivery of its own");
		assert.equal(replyDelivery.target.actor, "codex", "addressed to the actor that asked, so it cannot loop back here");
		assert.equal(replyDelivery.target.sessionId, undefined, "and not to a session");
		assert.equal(replyDelivery.mode, "advisory", "as a result travelling back, not work being handed out");

		const record = execution.listExecutions(root).find((entry) => entry.deliveryId === delivery.deliveryId);
		assert.equal(record.state, "replied", "the execution records the return leg as complete");
		assert.equal(record.automaticReplyMessageId, reply.messageId, "naming the message that carried it");
		assert.equal(record.automaticReplyRequestId, execution.autoReplyRequestId(record.executionId, turn.messageSeq), "posted under the id derived from its own answer");
		assert.equal(record.finalAssistantMessageSeq, turn.messageSeq, "and the answer it sent is the one it captured");
		assert.equal(core.verifyInvariants(root).ok, true, "the protocol invariants hold after a full round trip");

		// Reading the reply is not consuming it, and no second reply appears on a later tick.
		await tick();
		assert.equal(automaticReplies(root).length, 1, "a steady state does not send the answer again");
	} finally {
		mock.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- A6. a crash after posting does not answer the Commander twice -------------
// The dangerous window, exercised for real: the reply is posted, the process is gone before the
// execution records it, and a restarted receiver has only the store. It must find the message by its
// deterministic request id rather than send a second one.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-reply-crash-"));
	const sessionId = "session-reply-crash";
	const sentinel = join(root, "crash-after-auto-reply");
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { delivery } = seedInstruction(root, sessionId, "CRASH_TASK: do the work");

	const first = mockContext(sessionId);
	// The first process is told to die right after the reply is posted.
	writeFileSync(sentinel, "", "utf8");
	plugin.apply(first.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", actor: "dsh", peer: "codex", watchIntervalMs: 250, debugLog: join(root, "trace.log"), crashAfterAutoReplySentinel: sentinel });
	try {
		await tick();
		const turn = appendTurn(first.session, "the answer that was posted before the crash", 2);
		await tick();

		const posted = automaticReplies(root);
		assert.equal(posted.length, 1, "the reply was posted before the crash");
		const record = execution.listExecutions(root).find((entry) => entry.deliveryId === delivery.deliveryId);
		assert.equal(record.state, "reply_pending", "and the execution is left owing it, because the write-back never happened");
		assert.equal(record.automaticReplyMessageId, null, "with nothing recorded as sent");
		assert.equal(record.finalAssistantMessageSeq, turn.messageSeq, "the answer it will be retried from is on disk");
	} finally {
		// A restart: the process is gone, the store is all that is left.
		first.dispose();
	}

	const second = mockContext(sessionId);
	rmSync(sentinel, { force: true });
	plugin.apply(second.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", actor: "dsh", peer: "codex", watchIntervalMs: 250, debugLog: join(root, "trace.log"), crashAfterAutoReplySentinel: sentinel });
	try {
		// Re-adopt the session's log, as a restart would from the durable store.
		second.session.log.push(...first.session.log);
		await tick();

		const after = automaticReplies(root);
		assert.equal(after.length, 1, "the restarted receiver does not answer the Commander a second time");
		assert.equal(after[0].messageId, automaticReplies(root)[0].messageId, "it reconciles to the message that already exists");
		const record = execution.listExecutions(root).find((entry) => entry.deliveryId === delivery.deliveryId);
		assert.equal(record.state, "replied", "and the return leg is finally recorded");
		assert.equal(record.automaticReplyMessageId, after[0].messageId, "naming that same message");
		assert.equal(core.listMessages(root).filter((entry) => String(entry.clientRequestId ?? "").startsWith("auto-final:")).length, 1, "exactly one logical reply exists for this execution");
		assert.equal(core.verifyInvariants(root).ok, true, "and the invariants hold after the crash and the retry");
	} finally {
		second.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- A7. a reply is never empty, and never invented ---------------------------
// "Completed with no visible text" is a real outcome. It must stay diagnosable instead of becoming an
// empty message to the Commander.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-reply-empty-"));
	const sessionId = "session-reply-empty";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { delivery } = seedInstruction(root, sessionId, "EMPTY_TASK: do the work");
	const mock = mockContext(sessionId);
	plugin.apply(mock.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", actor: "dsh", peer: "codex", watchIntervalMs: 250, debugLog: join(root, "trace.log") });
	try {
		await tick();
		// A turn that completed with reasoning only: no visible text anywhere.
		appendTurn(mock.session, "", 2);
		await tick();
		await tick();

		assert.equal(automaticReplies(root).length, 0, "a completed turn with no visible text sends nothing");
		assert.equal(core.listMessages(root).filter((entry) => entry.from === "dsh").length, 0, "and invents no message at all");
		const record = execution.listExecutions(root).find((entry) => entry.deliveryId === delivery.deliveryId);
		assert.equal(record.state, "completed", "the execution stays visibly completed-but-unanswered");
		assert.equal(record.automaticReplyMessageId, null, "with nothing claimed as sent");
		assert.equal(execution.pendingAutoReplies(root).length, 0, "and it is not queued for a reply that can never be produced");
	} finally {
		mock.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- A8. an explicit final reply suppresses the automatic one -----------------
// The scenario P1c exists for: the executor answers the Commander itself, and the automatic path must
// not then send a second "final answer". A progress reply must not have that effect — the result still
// has to come back.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-reply-explicit-live-"));
	const sessionId = "session-explicit-live";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { message, delivery } = seedInstruction(root, sessionId, "EXPLICIT_TASK: do the work");
	const mock = mockContext(sessionId);
	// Capture the tool the receiver registers, so the reply goes through the real handler.
	let tool = null;
	mock.ctx.tools.register = (definition) => {
		tool = definition;
	};
	plugin.apply(mock.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", actor: "dsh", peer: "codex", watchIntervalMs: 250, debugLog: join(root, "trace.log") });
	const callTool = (args) => tool.execute(args, { agent: { session: { header: { id: sessionId } } } });
	try {
		await tick();
		assert.equal(mock.followups.length, 1, "the session is woken with the task");

		// Still inside the turn: a progress note, then the result the executor sends itself.
		const progress = await callTool({ action: "reply", id: message.messageId, body: "working on it", disposition: "progress" });
		assert.match(progress.text, /disposition=progress/u, "a progress reply is reported as such");
		assert.match(progress.text, /recordedOnExecution=true/u, "and recorded against the execution it belongs to");
		const final = await callTool({ action: "reply", id: message.messageId, body: "the answer, sent by the executor", disposition: "final" });
		assert.match(final.text, /disposition=final/u, "a final reply is reported as final");
		assert.match(final.text, /automatic final reply for this execution is suppressed/u, "and says the automatic answer will not follow");

		// The turn then ends with its own answer in the log.
		appendTurn(mock.session, "the answer, sent by the executor", 2);
		await tick();
		await tick();

		const record = execution.listExecutions(root).find((entry) => entry.deliveryId === delivery.deliveryId);
		assert.equal(record.explicitFinalReplyMessageId !== null, true, "the explicit final reply is recorded on the execution");
		assert.equal(record.automaticReplyMessageId, null, "and no automatic reply was sent");
		assert.equal(automaticReplies(root).length, 0, "so the Commander receives exactly one final answer, not two");
		assert.equal(record.state, "replied", "with the return leg recorded as complete");
		// The two replies the executor sent are still there, and they are the only ones.
		assert.equal(core.listMessages(root).filter((entry) => entry.from === "dsh").length, 2, "the progress note and the final reply both survive");
		assert.equal(core.listMessages(root).find((entry) => entry.body === "the answer, sent by the executor").replyTo, message.messageId, "and the final reply answers the message that asked");
		assert.equal(core.getDelivery(root, delivery.deliveryId).state, "acked", "the inbound delivery is unaffected by the return leg");
	} finally {
		mock.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

console.log("auto-reply.test.mjs: all assertions passed");
