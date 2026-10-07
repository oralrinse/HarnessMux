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
		sessionId: String(input.sessionId ?? ""),
		dispatchKind: input.dispatchKind === "followup" ? "followup" : "steer",
		// Filled in from host events, never parsed out of a string.
		attemptId: null,
		turn: null,
		finalText: "",
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
export function attachAttempt(root, executionId, input = {}) {
	const record = getExecution(root, executionId);
	if (record === null) return null;
	if (record.attemptId !== null && record.attemptId !== input.attemptId) {
		// Rebinding an execution to a different attempt would silently move a delivery's answer to
		// another turn. Refused rather than overwritten.
		throw new Error(`harnessmux: execution ${executionId} is already bound to attempt ${record.attemptId}`);
	}
	return writeExecution(root, {
		...record,
		attemptId: input.attemptId === undefined ? record.attemptId : String(input.attemptId),
		turn: Number.isInteger(input.turn) ? input.turn : record.turn,
		state: record.state === "dispatching" ? "running" : record.state
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
