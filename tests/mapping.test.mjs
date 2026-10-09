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

	// An attempt id does not create a turn. Measured on a real host, a tool call ends a *step* and the same
	// turn continues, so a changed attempt id is not evidence of a new turn — turns come from the session's
	// own `turn/start`. M20 owns that rule; here the point is that attempts are held without inventing a turn.
	const other = execution.beginExecution(root, { deliveryId: "D8b", originMessageId: "M8b", threadId: "T8b", sessionId: "session-S8b", dispatchKind: "steer" });
	execution.attachAttempt(root, other.executionId, { attemptId: "session-S8b:1" });
	execution.attachAttempt(root, other.executionId, { attemptId: "session-S8b:2" });
	assert.equal(execution.getExecution(root, other.executionId).turns.length, 0, "attempts alone invent no turn");
	assert.equal(execution.getExecution(root, other.executionId).pendingAttempts.length, 2, "they are held until a turn is known");
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
	const wakeCall = source.indexOf("wakeAgent(targetSessionId, text");
	assert.notEqual(wakeBegin, -1, "the wake path records the mapping");
	assert.equal(wakeBegin < wakeCall, true, "and persists it before the session is resumed");

	// A failed hand-off must be explained, never left looking live.
	assert.match(source, /markExecutionFailed/u, "a failed dispatch is recorded as failed");
	// Frames are captured only for an attempt some execution is actually waiting on, which is what stops
	// an unrelated or pre-existing turn from being adopted. Resolution is by identity — see M12, which
	// asserts the absence of the uniqueness inference this used to rely on.
	assert.match(source, /executionForAttempt\(root, attemptId\)/u, "capture can resolve an execution already bound to the attempt");
	// `not binding` came from the attempt-mismatch refusal, which was removed on purpose: a following attempt
	// is a continuation turn (M20), so the phrase now only appears in the unowned-frame diagnostic.
	assert.match(source, /has no dispatched agent and no bound execution/u, "an unowned frame is still refused");
	assert.match(source, /ctx\.on\("agent\/assistant-stream", captureAssistantFrame\)/u, "and the stream is subscribed once");
}

// --- M11. a wake that fails to open a turn must not be acked as success ------
// Observed on a real host as "the delivery was ACKed but no turn ever opened": `followup()` is
// asynchronous, and its promise was discarded, so a rejected attempt to open the turn became an
// unhandled rejection while the wake still resolved. The delivery was acknowledged, the execution
// record stayed at `dispatching`, and nothing anywhere reported a problem.
{
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	// The call must be awaited. A bare `agent.followup(` preceded by `await` is what makes the
	// difference, so the assertion is on the awaited form rather than on the word alone.
	assert.match(source, /await agent\.followup\(makeUserMessage\(text\)\)/u, "the wake awaits the turn boundary it opens");
	assert.equal(
		/(?<!await )\bagent\.followup\(makeUserMessage\(text\)\)/u.test(source.replace(/await agent\.followup\(makeUserMessage\(text\)\)/gu, "")),
		false,
		"and no discarded followup promise remains"
	);
}

// --- M12. a frame is attributed by identity or not at all ---------------------
// This reproduces a real misbinding. On a live host two sessions produced assistant-stream frames at the
// same time: the host's own session and the session a delivery was dispatched to. The capture path then
// resolved the owner by asking "is exactly one execution outstanding? then it must be that one" — and
// bound the *host's* turn to the delivery. Nothing failed loudly; the record simply held another
// session's answer.
//
// The inference is now gone. Attribution is by the agent object that was handed the delivery, or by an
// execution already bound to the arriving attempt id. There is no third rule, because a missed frame
// costs a wait while a misattributed frame costs correctness.
{
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");

	// The inference must be absent, in any spelling.
	assert.equal(
		/outstanding\.length === 1/u.test(source),
		false,
		"there is no 'exactly one outstanding, so it must be this' fallback"
	);
	// `outstandingExecutions` is used, but by the session-log watcher to iterate whose log to read — never by
	// frame attribution. The inference that must stay absent is the one that picked an owner from the *count*
	// of outstanding executions.
	assert.equal(
		/outstanding\.length === 1/u.test(source),
		false,
		"the count of outstanding executions still never picks an owner"
	);
	assert.match(source, /for \(const record of outstanding\)/u, "it iterates sessions to read their logs instead");

	// Attribution must be anchored on the dispatched agent object.
	assert.match(source, /DISPATCHED_AGENTS = new WeakMap\(\)/u, "the dispatcher is tracked by object identity");
	assert.match(source, /DISPATCHED_AGENTS\.get\(payload\?\.agent\)/u, "a frame is attributed from its own agent object");
	assert.match(source, /const candidate = dispatched \?\? bound;/u, "identity first, then an execution already bound to this attempt");
	assert.match(source, /ignored rather than guessed/u, "and an unowned frame is ignored and reported");

	// The registration must precede the wake, because the first frame can arrive while followup is pending.
	const wakeStart = source.indexOf("async function wakeAgent(");
	assert.notEqual(wakeStart, -1, "the wake path exists");
	const registration = source.indexOf("DISPATCHED_AGENTS.set(agent, executionId);", wakeStart);
	const wake = source.indexOf("await agent.followup(makeUserMessage(text));", wakeStart);
	assert.notEqual(registration, -1, "the wake path registers the agent it will use");
	assert.notEqual(wake, -1, "and then wakes");
	assert.equal(registration < wake, true, "registering before the wake, because the first frame can arrive while followup is pending");

	// Identity is recorded, not conflated: the attempt joins the execution as a turn, and a host-side
	// session id is never invented for it (M14 removed the derivation that used to claim one).
	assert.match(source, /attachAttempt\(root, open\.executionId/u, "the attempt is recorded as a turn of the execution");
	const executionSource = readFileSync(join(HERE, "..", "packages", "core", "execution.mjs"), "utf8");
	assert.match(executionSource, /targetSessionId: String\(input\.sessionId/u, "while the delivery keeps the address it was given");
}

// --- M13. the identity rule itself, exercised --------------------------------
// A deterministic stand-in for the live pair: EA is bound to agent A, B has no execution at all.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-mapping-identity-"));
	core.ensureBridge(root, { remember: false });
	try {
		const ea = execution.beginExecution(root, {
			deliveryId: "D-A",
			originMessageId: "M-A",
			threadId: "T-A",
			sessionId: "session-A",
			dispatchKind: "followup"
		});
		// Frames from an unrelated agent/attempt must leave EA untouched: this is the misbinding.
		const unrelated = execution.executionForAttempt(root, "session-B:1");
		assert.equal(unrelated, null, "an attempt nobody dispatched for resolves to no execution");
		const untouched = execution.getExecution(root, ea.executionId);
		assert.equal(untouched.attemptId, null, "so the dispatched execution keeps an empty attempt");
		assert.equal(untouched.finalText, "", "and no text");
		assert.equal(untouched.hostSessionId, "", "and no host identity");

		// Only the dispatched attempt binds, and it freezes both identities.
		const bound = execution.bindHostIdentity(root, ea.executionId, { hostSessionId: "session-<uuid>", attemptId: "session-<uuid>:2" });
		assert.equal(bound.attemptId, "session-<uuid>:2", "the arriving attempt is recorded");
		assert.equal(bound.hostSessionId, "session-<uuid>", "and the host's own session id with it");
		assert.equal(bound.targetSessionId, "session-A", "while the delivered address is preserved");
		assert.equal(execution.executionForAttempt(root, "session-<uuid>:2")?.deliveryId, "D-A", "and the attempt then resolves to its delivery");

		// A second host session claiming the same execution is refused, not silently accepted.
		assert.throws(
			() => execution.bindHostIdentity(root, ea.executionId, { hostSessionId: "session-other", attemptId: "session-other:1" }),
			/already bound to host session/u,
			"one delivery cannot belong to two host sessions"
		);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- M14. an attempt id is not a session id -----------------------------------
// Measured on a real host: a turn opened on the session `session-sim-align` produced frames whose
// attempt id was `session-<the boot session's uuid>:1`. The leading segment of an attempt id therefore
// does **not** name the session the turn belongs to — the host appears to stamp its own id. Any code
// that derives a session from that prefix records a wrong session and then makes every later lookup wrong
// with it, silently.
{
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	assert.equal(
		/sessionIdFromAttemptId/u.test(source),
		false,
		"the receiver does not derive a session from an attempt id prefix"
	);
	assert.equal(
		/hostSessionId: sessionIdFromAttemptId/u.test(source),
		false,
		"and never stores one as the host session"
	);
	// The attempt id itself is still recorded — it is a real host key, just not a session name.
	assert.match(source, /attachAttempt\(root, open\.executionId, \{ attemptId, turn: finalCapture\.turnFromAttemptId\(attemptId\) \}\)/u, "the attempt id alone is recorded, `:<n>` used only as a diagnostic turn number");
}

// --- M15. a created session is never given an invented model route ------------
// Measured on a real host: a session created without a route dies at `turn/start` with
// `prompt variable "{{model}}" has no value for this assembly`, so its turn never produces an
// assistant/message and nothing can be captured. A hardcoded default looked like configuration while
// producing a session that could never run. The route must be inherited from a live session.
{
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	assert.equal(
		/"deepseek-chat"/u.test(source),
		false,
		"no model name is invented in the receiver"
	);
	assert.equal(
		/provider = .*: "deepseek"/u.test(source),
		false,
		"and no provider is defaulted to a guess"
	);
	assert.match(source, /live\?\.options\?\.provider/u, "the live session's provider is inherited instead");
	assert.match(source, /live\?\.options\?\.model/u, "and its model");
}

// --- M16. the created-session assembly gap is a known, recorded limitation ----
// Measured on a real host, a session from `ctx.agents.create()` is a complete session but not yet an
// assembled agent: it has `systemPrompt` like any other, yet its first step fails with
//
//   prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")
//
// because the values the assembly needs live on the agent (`options.provider`, `options.model`) and the
// session header (`cwd`), and the create path leaves all three empty. Passing `cwd` as a create option
// was measured and does not populate the header either, so this is not fixed by supplying more
// arguments. `agentOptionsFromConfig` inherits what it can; the rest is an open product question, and
// this test exists so the gap cannot be mistaken for working capture later.
{
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	// The receiver must not pretend the problem away by inventing the missing values.
	assert.equal(/"deepseek-chat"/u.test(source), false, "no model is invented to satisfy the assembly");
	assert.equal(/cwd:\s*"[A-Za-z]:/u.test(source), false, "and no working directory is invented either");
	assert.match(source, /live\?\.options\?\.provider/u, "only a value the host already resolved is reused");
}

// --- M17. the materialize path a created session misses ----------------------
// A working session's own persisted header is:
//
//   {"version":4,"id":"session-…","createdAt":…,
//    "cwd":"<workspace>","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
//
// while a session from `ctx.agents.create()` carries only `{version,id,createdAt,isSeeded}`. The missing
// pair is exactly what the assembly needs: `cwd` is a prompt variable, and `agentPreset` selects the
// composition.
//
// The host documents the mechanism in two packages:
//   dsh-agent-preset          "Declare several presets and let sessions select one. `config.id` is the
//                             preset identity saved by sessions."
//   dsh-agent-preset-registry "`default` | required | Preset ID used when none is requested"
//
// So the missing step is preset resolution plus workspace context, performed by whoever builds a session
// definition — not by `create()`, and not by passing `cwd` to it (measured: it does not reach the header).
// This test records the shape of the gap so a later "just set the field" patch has to argue with it.
{
	// Nothing in the receiver may fabricate the header fields that make a session assembled.
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	assert.equal(/agentPreset\s*:/u.test(source), false, "the receiver does not write an agent preset into a session itself");
	assert.equal(/header\.cwd\s*=/u.test(source), false, "nor patch a session header's working directory");
}

// --- M18. where the preset/composition step lives, as far as it was traced ----
// Read-only reconnaissance, recorded so the next pass starts where this one stopped.
//
// Established:
//   * a real persisted session header carries `cwd`, `isSeeded`, `delegationDepth` and
//     `agentPreset:"standard"`; a session from `ctx.agents.create({ agentPreset })` gets none of them —
//     the option is accepted and dropped, header still `{version,id,createdAt,isSeeded}`;
//   * `dsh-agent-preset` is a registrar, not a resolver: it registers a named list of child plugins into
//     the injected `agentPresets` service, and its own docs say "`config.id` is the preset identity saved
//     by sessions";
//   * `agentPresets` is **not registered in the headless profile** — injecting it fails the plugin
//     silently — so the `standard` preset comes from a bundle layer that a headless host does not load;
//   * the desktop profile's patch holds an `agent-default-model` row with `provider` and `model`, which
//     is where a working agent's route comes from, while neither `<profile>/cordis.yml` (an empty list) nor
//     the patch mentions a preset row at all.
//
// Not established: which bundle registers `standard`, which function expands a preset into sections and
// tools, which builder writes the real session header, and whether a plugin can reach that path.
{
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	// The receiver must not try to stand in for the preset/composition layer. The check is on access
	// syntax rather than the bare word, because the refusal message legitimately names the service.
	assert.equal(/ctx\.agentPresets|ctx\[.agentPresets.\]/u.test(source), false, "the receiver does not read the preset registry");
	assert.equal(/require(Factory|Initiator)\(/u.test(source), false, "nor drive the agent factory directly");
}

// --- M19. what a real working session proved about the capture path -----------
// Two runs against the host's own session — built by the normal CLI path, so `cwd`, `agentPreset` and a
// resolved route are all present. Recorded because these are the first live results where an execution
// reached `turn_completed` at all.
//
//   capture: frame …:1 has no dispatched agent and no bound execution; ignored rather than guessed
//   capture: bound execution … to host attempt …:2
//   capture: attempt …:2 finished reason=tool-calls text=0chars
//
// so identity attribution works on a real session: the attempt that was not dispatched to is refused, and
// the one that was is bound. The empty text is explained by the reason rather than by a capture failure —
// a turn that ends in `tool-calls` has not produced its visible answer yet, so the answer lands in a later
// turn. The first run additionally showed why the scenario must wait for idle: a delivery arriving while
// the boot turn is still running is steered into *that* turn, and the captured attempt is then the boot
// task rather than the delivered one.
{
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	// A turn that ended by calling a tool must not be reported as a finished answer.
	assert.match(source, /completionOf/u, "completion is judged by the host's own reason, not by reaching an end frame");
	const captureSource = readFileSync(join(HERE, "..", "packages", "core", "final-capture.mjs"), "utf8");
	assert.match(captureSource, /kind === "completed"/u, "and only a completed reason counts as complete");
	assert.match(captureSource, /hasText/u, "with text presence reported separately, so 'completed but empty' stays visible");
}

// --- M20. turns come from the session log; attempts never invent one ---------
// Corrected model. A real host showed a tool call ending a *step*, with the same turn continuing:
//
//   turn/start#5 -> step/start -> assistant/message + tool/call + tool/result -> step/end
//                -> step/start -> assistant/message + tool/call + tool/result -> step/end
//                -> step/start -> assistant/message (the answer) -> step/end
//                -> turn/end#36 reason={"kind":"completed"}
//
// so "a new attempt" is not "a new turn". The earlier reading of `attempt :2 -> :3` as two turns was wrong,
// and this test exists to keep the corrected rule.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-turns-"));
	core.ensureBridge(root, { remember: false });
	try {
		const ex = execution.beginExecution(root, {
			deliveryId: "D-turns",
			originMessageId: "M-turns",
			threadId: "T-turns",
			sessionId: "session-A",
			dispatchKind: "steer"
		});
		// Attempts before any turn is known: held, and no turn invented.
		execution.attachAttempt(root, ex.executionId, { attemptId: "session-X:2", turn: 2 });
		execution.attachAttempt(root, ex.executionId, { attemptId: "session-X:3", turn: 2 });
		let current = execution.getExecution(root, ex.executionId);
		assert.equal(current.turns.length, 0, "an attempt id never creates a turn");
		assert.deepEqual(current.pendingAttempts, ["session-X:2", "session-X:3"], "both attempts are held as diagnostics");

		// Only the log's own turn/start opens one, and the held attempts join it.
		execution.openTurn(root, ex.executionId, { turn: 1, turnStartSeq: 5 });
		current = execution.getExecution(root, ex.executionId);
		assert.equal(current.turns.length, 1, "turn/start opens exactly one turn");
		assert.deepEqual(current.turns[0].attempts, ["session-X:2", "session-X:3"], "and both attempts are recorded inside it");
		assert.equal(current.turns[0].turnStartSeq, 5, "with the sequence it opened at");
		assert.equal(current.state, "running", "the execution is running while the turn is open");

		// Opening the same turn twice is idempotent: the log can be read more than once.
		execution.openTurn(root, ex.executionId, { turn: 1, turnStartSeq: 5 });
		assert.equal(execution.getExecution(root, ex.executionId).turns.length, 1, "re-reading the same turn/start does not duplicate it");

		// The turn's own reason decides the outcome, not the attempt's.
		const done = execution.endTurn(root, ex.executionId, { turn: 1, reason: { kind: "completed" }, turnEndSeq: 36 });
		assert.equal(done.state, "completed", "turn/end completed finishes the execution");
		assert.equal(done.turns[0].turnEndSeq, 36, "and records where it ended");

		// An errored turn is terminal failure.
		const bad = execution.beginExecution(root, { deliveryId: "D-err", sessionId: "session-B", dispatchKind: "followup" });
		execution.openTurn(root, bad.executionId, { turn: 1, turnStartSeq: 1 });
		assert.equal(execution.endTurn(root, bad.executionId, { turn: 1, reason: { kind: "error" } }).state, "failed", "an errored turn fails the execution");

		// The final answer is the last text-bearing assistant message of the completed turn, never a join.
		const events = [
			{ type: "assistant/message", seq: 21, data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "interim" }] } } },
			{ type: "assistant/message", seq: 28, data: { turn: 1, message: { role: "assistant", content: [{ type: "reasoning", text: "thinking" }] } } },
			{ type: "assistant/message", seq: 34, data: { turn: 1, message: { role: "assistant", content: [{ type: "reasoning", text: "" }, { type: "text", text: "the answer" }] } } }
		];
		const answer = capture.finalAnswerOf(events, 1);
		assert.equal(answer.seq, 34, "the last text-bearing assistant message is chosen");
		assert.equal(answer.text, "the answer", "and reasoning is excluded rather than concatenated");
		assert.equal(answer.text.includes("interim"), false, "earlier per-step messages are not joined in");
		assert.equal(capture.finalAnswerOf(events, 2), null, "a turn with no text-bearing message has no answer");

		execution.setFinalAnswer(root, ex.executionId, { finalText: answer.text, assistantMessageSeq: answer.seq, turn: 1 });
		const finished = execution.getExecution(root, ex.executionId);
		assert.equal(finished.finalText, "the answer", "the answer is recorded on the execution");
		assert.equal(finished.finalAssistantMessageSeq, 34, "with the sequence it came from");
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}
// --- M21. the target session's own event list is the content authority --------
// Measured on a real WORKING session with the receiver mounted. `session.snapshotEvents()` returned the
// complete ordered chain for the task, and every `assistant/message` in it carried its own text:
//
//   agent/inbox/spliced#3  target=next-step
//   agent/inbox/spliced#4  target=next-turn
//   turn/start#5           {"turn":1}
//   step/start#8  system/message#9  user/message#10..13  request/header#14  request/context#15
//   assistant/message#21   texts="P3-HOST"
//   tool/call#22  tool/result#23  step/end#24
//   step/start#25  assistant/message#28  tool/call#29  tool/result#30  step/end#31
//   step/start#32  assistant/message#34  texts="P3-HOST\n\nMailbox is empty — …invariants=ok"
//   step/end#35    turn/end#36 reason={"kind":"completed"}
//
// So the session's own record answers lifecycle *and* content, which is a stronger position than
// attributing text through `assistant-stream`: the stream's `payload.agent` was measured to be the boot
// agent even for another session's turn, so it cannot be the authority.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-authority-"));
	core.ensureBridge(root, { remember: false });
	try {
		// The shape the reader must cope with: text nested inside a message inside an event.
		const event = {
			type: "assistant/message",
			seq: 34,
			data: { turn: 1, step: 3, message: { role: "assistant", content: [{ type: "reasoning", text: "" }, { type: "text", text: "the answer" }] } }
		};
		const texts = [];
		const walk = (v) => {
			if (v === null || typeof v !== "object") return;
			if (Array.isArray(v)) {
				for (const item of v) walk(item);
				return;
			}
			if (v.type === "text" && typeof v.text === "string") texts.push(v.text);
			for (const value of Object.values(v)) walk(value);
		};
		walk(event);
		assert.deepEqual(texts, ["the answer"], "the visible text is reachable from the event without knowing the nesting");
		assert.equal(event.type, "assistant/message", "and the event names itself");
		assert.equal(Number.isInteger(event.seq), true, "with a sequence to correlate against");
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- M22. Commander delegated execution requires turn ownership ---------------
// Decided rule, and the reason for it: if a delivery is steered into a turn somebody else started, the
// final assistant message answers that work *and* this task, so a reply could not honestly claim to be this
// execution's result. Waiting for idle costs a moment and buys a turn that can be attributed. This is a
// scheduling rule of the Commander workflow; `running -> steer` stays a general receiver capability for
// explicit follow-ups, advisory traffic, and continuations.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-ownership-"));
	core.ensureBridge(root, { remember: false });
	try {
		// A session whose log shows an open turn, started before any dispatch.
		const bootEvents = [
			{ type: "turn/start", seq: 5, data: { turn: 1 } },
			{ type: "step/start", seq: 6, data: { turn: 1, step: 1 } }
		];
		const openTurn = execution.openTurnIn(bootEvents);
		assert.equal(openTurn.open, true, "a turn/start with no turn/end is an open turn");
		assert.equal(openTurn.turnStartSeq, 5, "and its position is knowable");

		// A closed turn is not open.
		const closed = execution.openTurnIn([...bootEvents, { type: "turn/end", seq: 9, data: { turn: 1, reason: { kind: "completed" } } }]);
		assert.equal(closed.open, false, "once turn/end arrives the session is free");
		// A later turn reopens it, and only its own end closes it.
		const reopened = execution.openTurnIn([...bootEvents, { type: "turn/end", seq: 9, data: { turn: 1 } }, { type: "turn/start", seq: 12, data: { turn: 2 } }]);
		assert.equal(reopened.turn, 2, "the newest open turn is the one reported");

		// An execution that never opened this turn does not own it.
		const ex = execution.beginExecution(root, { deliveryId: "D-own", sessionId: "session-A", dispatchKind: "followup", baselineLogSeq: 26 });
		assert.equal(execution.ownsOpenTurn(ex, openTurn), false, "an execution cannot claim a turn it never opened");
		assert.equal(execution.ownsOpenTurn(null, openTurn), false, "and no execution owns nothing");

		// A turn this execution did open is its own continuation.
		execution.openTurn(root, ex.executionId, { turn: 1, turnStartSeq: 5 });
		assert.equal(execution.ownsOpenTurn(execution.getExecution(root, ex.executionId), openTurn), true, "a turn it opened is its own");

		// Once that turn has ended, it is no longer an open turn it owns.
		execution.endTurn(root, ex.executionId, { turn: 1, reason: { kind: "completed" }, turnEndSeq: 9 });
		assert.equal(execution.ownsOpenTurn(execution.getExecution(root, ex.executionId), openTurn), false, "an ended turn is not an owned open turn");
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- M23. the receiver defers rather than steering into a foreign turn --------
{
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	assert.match(source, /ownsOpenTurn/u, "the wake path consults turn ownership");
	assert.match(source, /waiting-for-idle/u, "and defers the delivery when the turn is not its own");
	// Deferral must not ack: the host accepted nothing, so claiming acceptance would be false.
	const deferBlock = source.slice(source.indexOf("const ownership = sessionTurnState"), source.indexOf("const text = deliveryText"));
	assert.match(deferBlock, /releaseDelivery/u, "deferral releases the delivery back to the queue");
	assert.equal(/ackDelivery/u.test(deferBlock), false, "and never acks it, because the host accepted nothing");
	// Turn state is read from the durable log. Both sources were measured to carry the same events, including
	// `turn/start` and `turn/end`, so this is a choice of authority rather than a workaround.
	assert.match(source, /Array\.isArray\(session\.log\) \? session\.log : \[\]/u, "turn state is read from the session log");
}

console.log("mapping.test.mjs: all assertions passed");
