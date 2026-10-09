/**
 * Pending execution mapping — the correlation half of automatic final capture.
 *
 * ## What it is for
 *
 * When the receiver hands a delegated delivery to DeepSeek Harness it must be able to answer, later,
 * "which HarnessMux message did the turn that just finished belong to?" Without that answer a final
 * answer cannot be routed back to the right thread, and the commander waits forever.
 *
 * ## Why the record is written before the hand-off
 *
 * This ordering is the whole point, and it is not a detail:
 *
 * ```text
 *   persist pending execution      <- first
 *   steer / followup               <- second
 *   attach attemptId when it appears
 * ```
 *
 * The reverse order has a crash window with no recovery: if the process dies after `followup()` and
 * before anything recorded that it happened, the model has already run and nothing knows which message
 * caused it. The work is done and unanswerable. Writing first means a crash leaves a record that says
 * "something was dispatched for delivery D and we never saw its turn" — which is a question that can be
 * asked and answered, instead of silence.
 *
 * A record whose dispatch then *fails* is not left as a running execution: it is marked
 * `dispatch_failed`, so "we tried and the try failed" is never confused with "it is running".
 *
 * ## Layering
 *
 * This is workflow state. It lives beside the protocol directories and never inside them: no field
 * here is consulted by the pump, the claim path, or the invariant check, and none of it changes what a
 * delivery *is*. Protocol v2 stays frozen.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where execution records live, beside — never inside — the protocol directories. */
const EXECUTION_DIR = "executions";

/**
 * States an execution may be in.
 *
 * `dispatching` is written before the hand-off; `running` once the host accepted it; `turn_completed`
 * once the turn ended; `replied` once an answer was sent. `dispatch_failed` is separate from every
 * running state on purpose.
 */
export const EXECUTION_STATES = ["dispatching", "running", "turn_completed", "replied", "dispatch_failed"];

/**
 * Path for one execution record.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @returns {string} absolute path.
 */
const executionPath = (root, executionId) => join(root, EXECUTION_DIR, `${executionId}.json`);

/**
 * Read one execution.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @returns {object|null} the record, or null when absent or unreadable.
 */
export function getExecution(root, executionId) {
	const path = executionPath(root, String(executionId));
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * All execution records, oldest first.
 *
 * @param {string} root - bridge root.
 * @returns {object[]} the records.
 */
export function listExecutions(root) {
	const dir = join(root, EXECUTION_DIR);
	if (!existsSync(dir)) return [];
	const records = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			records.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
		} catch {
			// A single unreadable record must not hide the others; these are descriptive records.
		}
	}
	return records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * Write a record, replacing any previous version.
 *
 * @param {string} root - bridge root.
 * @param {object} record - the record.
 * @returns {object} the record.
 */
function writeExecution(root, record) {
	mkdirSync(join(root, EXECUTION_DIR), { recursive: true });
	const updated = { ...record, updatedAt: new Date().toISOString() };
	writeFileSync(executionPath(root, record.executionId), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
	return updated;
}

/**
 * Record that a delivery is **about to be** handed to the host.
 *
 * Call this before `steer`/`followup`, never after. See the module comment for why the order is the
 * feature rather than an implementation detail.
 *
 * @param {string} root - bridge root.
 * @param {object} input - delivery/message/thread identity and the chosen dispatch kind.
 * @returns {object} the persisted record.
 */
export function beginExecution(root, input = {}) {
	const deliveryId = String(input.deliveryId ?? "").trim();
	if (deliveryId === "") throw new Error("harnessmux: an execution needs the delivery it is for");
	const now = new Date().toISOString();
	return writeExecution(root, {
		executionId: typeof input.executionId === "string" && input.executionId.trim() ? input.executionId.trim() : `exec-${randomUUID()}`,
		state: "dispatching",
		// Origin identity: what an answer must be routed back to.
		deliveryId,
		originMessageId: String(input.originMessageId ?? ""),
		threadId: String(input.threadId ?? ""),
		originActor: String(input.originActor ?? ""),
		// Destination identity.
		endpointId: String(input.endpointId ?? ""),
		// The id HarnessMux addresses the delivery with.
		targetSessionId: String(input.sessionId ?? ""),
		// The id the host itself uses, learned from the first frame of the attempt it opens.
		hostSessionId: "",
		sessionId: String(input.sessionId ?? ""),
		dispatchKind: input.dispatchKind === "followup" ? "followup" : "steer",
		// Turns come only from the target session's own `session.log` `turn/start` events. A changing attempt id
		// is **not** evidence of a new turn: measured on a real host, a tool call ends a *step*, not the turn,
		// and the host continues with the next step of the same turn. Attempts are therefore recorded inside
		// the turn they occurred in, as diagnostics, and never create a turn by themselves.
		turns: [],
		// Where the target session's log stood when this delivery was dispatched.
		baselineLogSeq: Number.isInteger(input.baselineLogSeq) ? input.baselineLogSeq : null,
		// The terminal answer, taken from the target session's own event list.
		finalAssistantMessageSeq: null,
		finalText: "",
		finalTurn: null,
		attemptId: null,
		turn: null,
		reason: null,
		assistantMessageSeq: null,
		explicitReplyMessageId: null,
		automaticReplyMessageId: null,
		createdAt: now,
		updatedAt: now
	});
}

/**
 * Mark an execution as accepted by the host.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @returns {object|null} the updated record.
 */
export function markRunning(root, executionId) {
	const record = getExecution(root, executionId);
	if (record === null) return null;
	return writeExecution(root, { ...record, state: "running" });
}

/**
 * Record that the hand-off itself failed, so the record is never mistaken for a live execution.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @param {string} reason - why the dispatch failed.
 * @returns {object|null} the updated record.
 */
export function markDispatchFailed(root, executionId, reason) {
	const record = getExecution(root, executionId);
	if (record === null) return null;
	return writeExecution(root, { ...record, state: "dispatch_failed", reason: String(reason ?? "dispatch failed") });
}

/**
 * Attach the host's attempt identity to an execution.
 *
 * Called when the first frame or turn event for the target session arrives after a dispatch. The id
 * comes from the host; it is stored as given.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @param {object} input - `attemptId` and optional `turn`.
 * @returns {object|null} the updated record.
 */
/**
 * Record that a turn opened on an execution.
 *
 * A second turn on the same execution is expected, not exceptional: when a turn ends with
 * `reason.kind="tool-calls"` the model has called a tool and the host opens the next turn itself, with no
 * new delivery. Refusing that continuation would discard the answer the tool was called for, which is
 * exactly what an earlier version did.
 *
 * The one thing still refused is moving an execution to an attempt that a *different* execution already
 * owns, because that would mean two deliveries claiming one turn.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @param {object} input - `attemptId` and optional `turn`.
 * @returns {object|null} the updated record.
 */
/**
 * Record an attempt as diagnostics inside the turn it belongs to.
 *
 * An attempt id is an opaque host key for one model attempt. It is deliberately **not** allowed to create a
 * turn: measured on a real host, a tool call ends a *step* — the same turn continues with the next step —
 * so treating a changing attempt id as a new turn would invent turns the session never opened. Attempts are
 * attached to the current turn, or held aside until the turn they belong to is known.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @param {object} input - `attemptId` and optional `turn`.
 * @returns {object|null} the updated record.
 */
export function attachAttempt(root, executionId, input = {}) {
	const record = getExecution(root, executionId);
	if (record === null) return null;
	const attemptId = String(input.attemptId ?? "");
	if (attemptId === "") return record;
	const turns = [...(Array.isArray(record.turns) ? record.turns : [])];
	const turnNumber = Number.isInteger(input.turn) ? input.turn : null;

	// Attach to the turn the host says it belongs to when one is given, otherwise to the newest turn.
	let index = turnNumber === null ? turns.length - 1 : turns.findIndex((entry) => entry.turn === turnNumber);
	if (index === -1) index = turns.length - 1;
	if (index < 0) {
		// No turn known yet. Held as pending rather than promoted into a turn.
		const pending = Array.isArray(record.pendingAttempts) ? [...record.pendingAttempts] : [];
		if (!pending.includes(attemptId)) pending.push(attemptId);
		return writeExecution(root, { ...record, pendingAttempts: pending, attemptId });
	}
	const turn = turns[index];
	const attempts = Array.isArray(turn.attempts) ? [...turn.attempts] : [];
	if (!attempts.includes(attemptId)) attempts.push(attemptId);
	turns[index] = { ...turn, attempts };
	return writeExecution(root, { ...record, turns, attemptId, turn: turn.turn });
}

/**
 * Record a turn the target session actually opened.
 *
 * This is the only way a turn enters the record, and it is called from the session's own `turn/start`
 * event. Nothing inferred from an attempt id can reach it.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @param {object} input - `turn`, `turnStartSeq`.
 * @returns {object|null} the updated record.
 */
/**
 * Record the log position this delivery starts reading its turns from.
 *
 * Captured on the first watcher pass after the dispatch, so turns that already existed are never attributed
 * to this delivery.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @param {number} seq - the last sequence present before the dispatch took effect.
 * @returns {object|null} the updated record.
 */
/**
 * Whether a session's log shows a turn that has not yet closed.
 *
 * Derived from the log rather than from `agent.status`, because the log is the authority that decides turn
 * lifecycle (a running turn is a `turn/start` without its `turn/end`). Used as the ownership gate: a
 * delegated Commander task may only start a turn it can claim, so it must not be steered into a turn that
 * belongs to somebody else's work.
 *
 * @param {object[]} events - the session's own log events.
 * @returns {{open: boolean, turn: number|null, turnStartSeq: number|null}} what the log shows.
 */
export function openTurnIn(events) {
	if (!Array.isArray(events)) return { open: false, turn: null, turnStartSeq: null };
	let open = null;
	for (const entry of events) {
		if (entry?.type === "turn/start" && Number.isInteger(entry?.data?.turn)) {
			open = { turn: entry.data.turn, turnStartSeq: Number.isInteger(entry.seq) ? entry.seq : null };
			continue;
		}
		if (entry?.type === "turn/end" && open !== null && entry?.data?.turn === open.turn) open = null;
	}
	return open === null ? { open: false, turn: null, turnStartSeq: null } : { open: true, ...open };
}

/**
 * Whether a running turn demonstrably belongs to this execution.
 *
 * Deliberately strict, and deliberately not a guess: the execution must already have recorded a turn whose
 * `turnStartSeq` matches the turn the session currently has open. Anything else counts as somebody else's
 * work. The Commander loop is serial — at most one active execution per target session — so a running turn
 * that this execution did not open cannot be its own.
 *
 * @param {object} record - the execution.
 * @param {{open: boolean, turnStartSeq: number|null}} openTurn - the session's open turn.
 * @returns {boolean} true only when the open turn is provably this execution's.
 */
export function ownsOpenTurn(record, openTurn) {
	if (record === null || openTurn?.open !== true) return false;
	return (Array.isArray(record.turns) ? record.turns : []).some(
		(turn) => turn.turnStartSeq !== null && turn.turnStartSeq === openTurn.turnStartSeq && turn.turnEndSeq === null
	);
}
export function setBaseline(root, executionId, seq) {
	const record = getExecution(root, executionId);
	if (record === null) return null;
	if (record.baselineLogSeq !== null) return record;
	return writeExecution(root, { ...record, baselineLogSeq: Number.isInteger(seq) ? seq : 0 });
}
export function openTurn(root, executionId, input = {}) {
	const record = getExecution(root, executionId);
	if (record === null) return null;
	const turnNumber = Number.isInteger(input.turn) ? input.turn : null;
	if (turnNumber === null) return record;
	const turns = [...(Array.isArray(record.turns) ? record.turns : [])];
	if (turns.some((entry) => entry.turn === turnNumber)) return record;
	const pending = Array.isArray(record.pendingAttempts) ? record.pendingAttempts : [];
	turns.push({
		turn: turnNumber,
		turnStartSeq: Number.isInteger(input.turnStartSeq) ? input.turnStartSeq : null,
		turnEndSeq: null,
		reason: null,
		attempts: [...pending]
	});
	return writeExecution(root, {
		...record,
		turns,
		turn: turnNumber,
		pendingAttempts: [],
		state: record.state === "dispatching" ? "running" : record.state
	});
}

/**
 * Record how a turn ended, from the target session's own `turn/end` event.
 *
 * `reason` here is the **turn's** reason, which is what decides whether an execution is finished. It is not
 * the reason an assistant-stream attempt finished with — measured, a `tool-calls` finish ends a step inside
 * the turn, and the turn continues.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @param {object} input - `turn`, `reason`, `turnEndSeq`.
 * @returns {object|null} the updated record.
 */
export function endTurn(root, executionId, input = {}) {
	const record = getExecution(root, executionId);
	if (record === null) return null;
	const turnNumber = Number.isInteger(input.turn) ? input.turn : null;
	const reasonKind = String(input.reason?.kind ?? "unknown");
	const terminal = reasonKind === "completed" || reasonKind === "error";
	const turns = (Array.isArray(record.turns) ? record.turns : []).map((entry) =>
		turnNumber === null || entry.turn === turnNumber
			? {
					...entry,
					reason: input.reason ?? null,
					turnEndSeq: Number.isInteger(input.turnEndSeq) ? input.turnEndSeq : (entry.turnEndSeq ?? null)
				}
			: entry
	);
	return writeExecution(root, {
		...record,
		turns,
		reason: input.reason ?? record.reason,
		state: terminal ? (reasonKind === "error" ? "failed" : "completed") : "running"
	});
}

/**
 * Record the terminal answer, taken from the target session's own event list.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @param {object} input - `finalText`, `assistantMessageSeq`, `turn`.
 * @returns {object|null} the updated record.
 */
export function setFinalAnswer(root, executionId, input = {}) {
	const record = getExecution(root, executionId);
	if (record === null) return null;
	return writeExecution(root, {
		...record,
		finalText: String(input.finalText ?? ""),
		finalAssistantMessageSeq: Number.isInteger(input.assistantMessageSeq) ? input.assistantMessageSeq : record.finalAssistantMessageSeq,
		finalTurn: Number.isInteger(input.turn) ? input.turn : record.finalTurn
	});
}
/**
 * Record a completed turn's outcome on an execution.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @param {object} input - `finalText`, `reason`, optional `assistantMessageSeq`.
 * @returns {object|null} the updated record.
 */
export function completeExecution(root, executionId, input = {}) {
	const record = getExecution(root, executionId);
	if (record === null) return null;
	return writeExecution(root, {
		...record,
		state: "turn_completed",
		finalText: String(input.finalText ?? ""),
		reason: input.reason ?? null,
		assistantMessageSeq: Number.isInteger(input.assistantMessageSeq) ? input.assistantMessageSeq : record.assistantMessageSeq
	});
}

/**
 * Executions that were written but never confirmed running.
 *
 * These are the crash-window survivors: a record exists, the dispatch line was reached or nearly
 * reached, and nothing since has completed it. Recognising them is what stops a restart from silently
 * rebinding work to the wrong turn — the alternative to recognising them is guessing.
 *
 * @param {string} root - bridge root.
 * @param {number} [staleMs] - age beyond which a non-terminal record counts as stale.
 * @returns {object[]} the stale records.
 */
export function staleExecutions(root, staleMs = 300_000) {
	const cutoff = Date.now() - staleMs;
	return listExecutions(root).filter((record) => {
		if (record.state === "replied" || record.state === "dispatch_failed") return false;
		const at = Date.parse(record.updatedAt ?? record.createdAt ?? "");
		return Number.isFinite(at) ? at < cutoff : false;
	});
}

/**
 * The one execution currently awaiting a final answer for a session, if any.
 *
 * The commander loop guarantees at most one outstanding delegated round per session: send, wait,
 * review, then send again. Enforcing that as an explicit invariant — rather than assuming it — is what
 * keeps "several deliveries may share one turn" from becoming "several answers race for one turn".
 *
 * @param {string} root - bridge root.
 * @param {string} sessionId - the session.
 * @returns {object|null} the outstanding record, or null.
 */
export function outstandingExecutions(root) {
	const live = listExecutions(root).filter(
		(record) => record.state === "dispatching" || record.state === "running" || record.state === "turn_completed"
	);
	return live;
}

/**
 * Bind an execution to the host's own session id and attempt id.
 *
 * Called once the first frame of the attempt arrives, for an execution whose ownership was already
 * established by object identity. This is the *only* place a session is derived from an attempt id, and
 * it is a corroboration rather than a lookup: the execution is already known, so the id records which
 * host session it corresponds to instead of being asked to find one.
 *
 * A later disagreement is refused, because two different host sessions claiming one delivery is a defect
 * rather than a rebinding.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution id.
 * @param {object} input - `hostSessionId` and `attemptId`.
 * @returns {object|null} the updated record.
 */
export function bindHostIdentity(root, executionId, input = {}) {
	const record = getExecution(root, executionId);
	if (record === null) return null;
	const hostSessionId = String(input.hostSessionId ?? "");
	if (record.hostSessionId !== "" && hostSessionId !== "" && record.hostSessionId !== hostSessionId) {
		throw new Error(
			`harnessmux: execution ${executionId} is already bound to host session ${record.hostSessionId}, refusing ${hostSessionId}`
		);
	}
	return writeExecution(root, {
		...record,
		hostSessionId: record.hostSessionId !== "" ? record.hostSessionId : hostSessionId,
		attemptId: input.attemptId === undefined ? record.attemptId : String(input.attemptId)
	});
}

/**
 * The one execution currently awaiting a final answer for a session, if any.
 *
 * @param {string} root - bridge root.
 * @param {string} sessionId - the session.
 * @returns {object|null} the outstanding record, or null.
 */
export function outstandingExecution(root, sessionId) {
	const live = listExecutions(root).filter(
		(record) => record.sessionId === sessionId && (record.state === "dispatching" || record.state === "running" || record.state === "turn_completed")
	);
	return live.length === 0 ? null : live[live.length - 1];
}

/**
 * Find the execution an attempt belongs to.
 *
 * @param {string} root - bridge root.
 * @param {string} attemptId - the attempt id from the host.
 * @returns {object|null} the matching record, or null.
 */
export function executionForAttempt(root, attemptId) {
	if (typeof attemptId !== "string" || attemptId === "") return null;
	return listExecutions(root).find((record) => record.attemptId === attemptId) ?? null;
}
