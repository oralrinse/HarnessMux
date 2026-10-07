/**
 * Delivery ↔ turn mapping, and the final-text accumulator it feeds.
 *
 * This suite exists because a probe of mine once attributed a turn to the wrong dispatch: I read the
 * frames of turn 1 and believed they were my own task, because my actual turn had failed. That is the
 * failure mode M3/M4 below are written to make impossible, and they are the reason this file tests
 * *rejection* as carefully as it tests success.
 *
 * The two halves are deliberately separate concerns, matching how the host exposes them:
 *
 *   session.log `turn/end` + `finish.reason`   lifecycle: did it finish, and did it succeed
 *   `block-end` where `block.type === "text"`  content:  what the user-visible answer says
 *   `end` frame `outcome`                      anchor:   which persisted message it became
 *
 * Nothing here touches Protocol v2: no delivery state is modified, and the invariant check must be
 * unaffected by any of these records existing.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as capture from "../packages/core/final-capture.mjs";
import * as execution from "../packages/core/execution.mjs";
import * as core from "../packages/core/core-v2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Run one isolated case. @param {(root: string) => void} fn - the case. */
const withRoot = (fn) => {
	const root = mkdtempSync(join(tmpdir(), "hxmux-mapping-"));
	try {
		core.ensureBridge(root, { remember: false });
		return fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
};

/**
 * Replay a recorded frame sequence into an accumulator.
 *
 * @param {string} sessionId - the session.
 * @param {string} attemptId - the attempt.
 * @param {object[]} frames - the frames.
 * @returns {object} the accumulator.
 */
const replay = (sessionId, attemptId, frames) => {
	const record = capture.createAccumulator({ sessionId, attemptId });
	for (const frame of frames) capture.accumulateFrame(record, frame);
	return record;
};

/** A completed turn with one reasoning block and one text block, as measured on a real host. */
const PLAIN_TURN = [
	{ type: "chunk", chunk: { type: "block-start", index: 0, blockType: "reasoning" } },
	{ type: "chunk", chunk: { type: "reasoning-delta", index: 0, text: "just reply" } },
	{ type: "chunk", chunk: { type: "block-end", index: 0, block: { type: "reasoning", text: "just reply" } } },
	{ type: "chunk", chunk: { type: "block-start", index: 1, blockType: "text" } },
	{ type: "chunk", chunk: { type: "text-delta", index: 1, text: "FINAL" } },
	{ type: "chunk", chunk: { type: "text-delta", index: 1, text: "_CAPTURE" } },
	{ type: "chunk", chunk: { type: "block-end", index: 1, block: { type: "text", text: "FINAL_CAPTURE" } } },
	{ type: "chunk", chunk: { type: "finish", reason: { kind: "completed" } } },
	{ type: "end", outcome: { kind: "committed", eventType: "assistant/message", seq: 28 } }
];

// --- M1. a delegated idle session dispatched with followup maps correctly ------
withRoot((root) => {
	const begun = execution.beginExecution(root, {
		deliveryId: "D1",
		originMessageId: "M1",
		threadId: "T1",
		originActor: "codex",
		endpointId: "dsh-endpoint",
		sessionId: "session-S1",
		dispatchKind: "followup"
	});
	// Before the hand-off: the record exists and claims no attempt yet.
	assert.equal(begun.state, "dispatching", "the record is written before the host is touched");
	assert.equal(begun.attemptId, null, "and asserts nothing about an attempt it has not seen");
	assert.equal(begun.dispatchKind, "followup", "the kind of hand-off is recorded");

	execution.markRunning(root, begun.executionId);
	execution.attachAttempt(root, begun.executionId, { attemptId: "session-S1:4", turn: 4 });
	const acc = replay("session-S1", "session-S1:4", PLAIN_TURN);
	execution.completeExecution(root, begun.executionId, {
		finalText: capture.finalTextOf(acc),
		reason: acc.reason,
		assistantMessageSeq: acc.assistantMessageSeq
	});

	const found = execution.executionForAttempt(root, "session-S1:4");
	assert.equal(found.deliveryId, "D1", "the attempt resolves back to its delivery");
	assert.equal(found.originMessageId, "M1", "and to the message to reply to");
	assert.equal(found.threadId, "T1", "and to the thread");
	assert.equal(found.originActor, "codex", "and to the actor waiting for the answer");
	assert.equal(found.finalText, "FINAL_CAPTURE", "with the final text attached");
	assert.equal(found.assistantMessageSeq, 28, "and the persisted message anchor");
	assert.equal(found.state, "turn_completed", "and a state that is not yet 'replied'");
});

// --- M2. a running session dispatched with steer maps correctly ---------------
withRoot((root) => {
	const begun = execution.beginExecution(root, {
		deliveryId: "D2",
		originMessageId: "M2",
		threadId: "T2",
		originActor: "codex",
		sessionId: "session-S2",
		dispatchKind: "steer"
	});
	assert.equal(begun.dispatchKind, "steer", "steering a running session is recorded as such");
	execution.markRunning(root, begun.executionId);
	execution.attachAttempt(root, begun.executionId, { attemptId: "session-S2:7" });
	assert.equal(execution.executionForAttempt(root, "session-S2:7")?.deliveryId, "D2", "a steer maps by the same route as a follow-up");
});

// --- M3. a concurrent turn in an unrelated session must not be bound ----------
withRoot((root) => {
	const mine = execution.beginExecution(root, { deliveryId: "D3", originMessageId: "M3", threadId: "T3", sessionId: "session-S3", dispatchKind: "followup" });
	// Another session is busier and finishes first.
	const other = execution.beginExecution(root, { deliveryId: "D-other", originMessageId: "M-other", threadId: "T-other", sessionId: "session-S9", dispatchKind: "followup" });
	execution.attachAttempt(root, other.executionId, { attemptId: "session-S9:1" });
	execution.attachAttempt(root, mine.executionId, { attemptId: "session-S3:5" });

	assert.equal(execution.executionForAttempt(root, "session-S9:1")?.deliveryId, "D-other", "the unrelated turn resolves to its own delivery");
	assert.equal(execution.executionForAttempt(root, "session-S3:5")?.deliveryId, "D3", "and the target turn resolves to its own, not the other's");
	assert.notEqual(execution.executionForAttempt(root, "session-S9:1")?.deliveryId, "D3", "a turn in another session is never bound to this delivery");
});

// --- M4. a pre-existing turn must not be mistaken for the new task ------------
withRoot((root) => {
	// A turn that finished before the dispatch existed. Its frames are readable, and an implementation
	// that simply took "the most recent attempt for this session" would grab them — the exact mistake
	// made during reconnaissance.
	const stale = capture.createAccumulator({ sessionId: "session-S4", attemptId: "session-S4:1" });
	for (const frame of PLAIN_TURN) capture.accumulateFrame(stale, frame);

	const begun = execution.beginExecution(root, { deliveryId: "D4", originMessageId: "M4", threadId: "T4", sessionId: "session-S4", dispatchKind: "followup" });
	// Before any attempt is attached, the old attempt must resolve to nothing at all.
	assert.equal(execution.executionForAttempt(root, "session-S4:1"), null, "an attempt from before this dispatch belongs to no execution");
	assert.equal(capture.finalTextOf(stale), "FINAL_CAPTURE", "even though its text is perfectly readable");

	execution.attachAttempt(root, begun.executionId, { attemptId: "session-S4:2" });
	assert.equal(execution.executionForAttempt(root, "session-S4:1"), null, "and the stale attempt stays unbound");
	assert.equal(execution.executionForAttempt(root, "session-S4:2")?.deliveryId, "D4", "while only the new attempt binds");
});

// --- M5. finalText is the ordered text blocks, never the reasoning ------------
withRoot(() => {
	const acc = replay("session-S5", "session-S5:1", PLAIN_TURN);
	assert.equal(capture.finalTextOf(acc), "FINAL_CAPTURE", "the visible answer is captured");
	assert.equal(capture.finalTextOf(acc).includes("just reply"), false, "and reasoning is excluded");
	assert.equal(acc.reason.kind, "completed", "the host's own completion reason is kept");
	assert.equal(capture.completionOf(acc).complete, true, "and reads as complete");

	// One turn, several visible blocks. Storing a single value would lose the first half.
	const multi = replay("session-S5", "session-S5:2", [
		{ type: "chunk", chunk: { type: "block-end", index: 0, block: { type: "text", text: "FIRST HALF" } } },
		{ type: "chunk", chunk: { type: "block-end", index: 1, block: { type: "text", text: "SECOND HALF" } } },
		{ type: "chunk", chunk: { type: "finish", reason: { kind: "completed" } } }
	]);
	assert.equal(capture.finalTextOf(multi), "FIRST HALF\n\nSECOND HALF", "both blocks survive, in host order");

	// Re-delivering a block must replace it, not duplicate it.
	capture.accumulateFrame(multi, { type: "chunk", chunk: { type: "block-end", index: 0, block: { type: "text", text: "FIRST HALF" } } });
	assert.equal(capture.finalTextOf(multi), "FIRST HALF\n\nSECOND HALF", "re-applying a block is idempotent");

	// Deltas are counted for diagnostics and never concatenated.
	assert.equal(multi.deltaCount, 0, "no deltas were fed here");
	const counted = replay("session-S5", "session-S5:3", [
		{ type: "chunk", chunk: { type: "text-delta", index: 0, text: "Hel" } },
		{ type: "chunk", chunk: { type: "text-delta", index: 0, text: "lo" } }
	]);
	assert.equal(counted.deltaCount, 2, "deltas are counted");
	assert.equal(capture.finalTextOf(counted), "", "and contribute no text of their own, so partial streams cannot fabricate an answer");
});

// --- M6. an errored turn must not be dressed as a success ---------------------
withRoot((root) => {
	const acc = replay("session-S6", "session-S6:1", [
		{ type: "chunk", chunk: { type: "block-end", index: 0, block: { type: "text", text: "half an answer" } } },
		{ type: "chunk", chunk: { type: "finish", reason: { kind: "error", error: { message: "boom" } } } },
		{ type: "end", outcome: { kind: "failed" } }
	]);
	const verdict = capture.completionOf(acc);
	assert.equal(verdict.reason, "error", "the host's error reason is preserved verbatim");
	assert.equal(verdict.complete, false, "an errored turn is not complete even though text exists");
	assert.equal(verdict.hasText, true, "and the partial text is still visible as partial");

	const begun = execution.beginExecution(root, { deliveryId: "D6", originMessageId: "M6", threadId: "T6", sessionId: "session-S6", dispatchKind: "followup" });
	execution.markDispatchFailed(root, begun.executionId, "session cannot be woken");
	const failed = execution.getExecution(root, begun.executionId);
	assert.equal(failed.state, "dispatch_failed", "a failed hand-off is recorded as failed");
	assert.notEqual(failed.state, "running", "and never left looking like a live execution");
	assert.equal(execution.outstandingExecution(root, "session-S6")?.state, undefined, "so it does not count as outstanding work");
});

// --- M7. none of this changes Protocol v2 -------------------------------------
withRoot((root) => {
	const before = core.verifyInvariants(root);
	assert.equal(before.ok, true, "invariants hold on an empty bridge");

	execution.beginExecution(root, { deliveryId: "D7", originMessageId: "M7", threadId: "T7", sessionId: "session-S7", dispatchKind: "steer" });
	replay("session-S7", "session-S7:1", PLAIN_TURN);
	assert.equal(core.verifyInvariants(root).ok, true, "and still hold with execution records and accumulators present");

	const message = core.postMessage(root, { from: "codex", topic: "t", kind: "instruction", body: "x" });
	const delivery = core.enqueueDelivery(root, { messageId: message.messageId });
	const after = core.verifyInvariants(root);
	assert.equal(after.ok, true, "and with a real delivery alongside them");
	assert.equal(after.violations.length, 0, "inventing no violations");

	// The execution store never becomes protocol state.
	const raw = readFileSync(join(root, "executions", `${execution.listExecutions(root)[0].executionId}.json`), "utf8");
	assert.equal(raw.includes("claimOwner"), false, "an execution record carries no claim field");
	assert.equal(raw.includes("leaseUntil"), false, "and no lease field");
	assert.equal(existsSync(join(root, "queue", "D7.json")), false, "and never lands in the delivery queue");
	assert.equal(core.getDelivery(root, delivery.deliveryId).state, "queued", "the real delivery is untouched by any of it");
});

// --- M8. a stale pending record is recognisable, not silently rebound ---------
withRoot((root) => {
	const begun = execution.beginExecution(root, { deliveryId: "D8", originMessageId: "M8", threadId: "T8", sessionId: "session-S8", dispatchKind: "followup" });
	// A record written moments ago is not stale — the age test has to mean something.
	assert.equal(execution.staleExecutions(root, 300_000).length, 0, "a fresh record is not stale");
	// A crash means the process died and time passed. A negative age models "any existing record", which
	// is the state a restart actually faces: the record is there and nothing has completed it.
	const stale = execution.staleExecutions(root, -1);
	assert.equal(stale.length, 1, "the unresolved record is identifiable after the fact");
	assert.equal(stale[0].deliveryId, "D8", "and names the delivery it was dispatched for");
	assert.equal(stale[0].attemptId, null, "and admits it never learned which attempt that was");

	// A record already completed or already failed is not stale: it is answered or explained.
	execution.markDispatchFailed(root, begun.executionId, "nope");
	assert.equal(execution.staleExecutions(root, -1).length, 0, "an explained failure is not left looking unresolved");

	// Rebinding an execution to a different attempt is refused rather than quietly accepted.
	const other = execution.beginExecution(root, { deliveryId: "D8b", originMessageId: "M8b", threadId: "T8b", sessionId: "session-S8b", dispatchKind: "steer" });
	execution.attachAttempt(root, other.executionId, { attemptId: "session-S8b:1" });
	assert.throws(
		() => execution.attachAttempt(root, other.executionId, { attemptId: "session-S8b:2" }),
		/already bound to attempt/u,
		"an execution cannot be moved to a different attempt"
	);
});

// --- M9. text is never reconstructed from deltas -----------------------------
{
	const source = readFileSync(join(HERE, "..", "packages", "core", "final-capture.mjs"), "utf8");
	assert.match(source, /block\.text/u, "the block's own assembled text is the source");
	assert.equal(/delta`?\]?\s*\+=/u.test(source), false, "and no delta is ever concatenated into it");
	assert.match(source, /textBlocks/u, "visible blocks are collected, not overwritten");
	assert.match(source, /attemptKey|attemptId/u, "attempt identity comes from the host");
	// The `:<n>` suffix is explicitly diagnostics-only; it must not be the lookup key.
	assert.match(source, /turnFromAttemptId/u, "the numeric suffix is parsed only for diagnostics");
	assert.match(source, /diagnostics/iu, "which the module says out loud");
}

// --- M10. the receiver wires the mapping in the load-bearing order ------------
{
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	// The record must be written before the host is driven, on both hand-off paths. Reading the order out
	// of the source is the only way to stop a later refactor from quietly reversing it — and reversing it
	// is precisely what makes the crash window unrecoverable.
	const steerBegin = source.indexOf('beginDispatchRecord(delivery, claim, message, binding, "steer", sessionId)');
	const steerCall = source.indexOf("agent.steer(makeUserMessage(deliveryText(");
	assert.notEqual(steerBegin, -1, "the steer path records the mapping");
	assert.notEqual(steerCall, -1, "and then steers");
	assert.equal(steerBegin < steerCall, true, "the record is persisted before the host is steered");

	const wakeBegin = source.indexOf('beginDispatchRecord(delivery, claim, message, binding, "followup"');
	const wakeCall = source.indexOf("wakeAgent(targetSessionId, text)");
	assert.notEqual(wakeBegin, -1, "the wake path records the mapping");
	assert.equal(wakeBegin < wakeCall, true, "and persists it before the session is resumed");

	// A failed hand-off must be explained, never left looking live.
	assert.match(source, /markExecutionFailed/u, "a failed dispatch is recorded as failed");
	// Frames are captured only for an attempt some execution is actually waiting on, which is what stops
	// an unrelated or pre-existing turn from being adopted.
	assert.match(source, /outstandingExecution\(root, sessionId\)/u, "capture is gated on an outstanding execution");
	assert.match(source, /ctx\.on\("agent\/assistant-stream", captureAssistantFrame\)/u, "and the stream is subscribed once");
}

console.log("mapping.test.mjs: all assertions passed");
