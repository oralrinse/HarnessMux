/**
 * Commander Mode task state — the workflow layer, deliberately *not* part of Protocol v2.
 *
 * The layering matters and is enforced by keeping this file ignorant of transport:
 *
 *     Commander workflow (this file)  — "is the user's goal done yet?"
 *     HarnessMux MCP/client API       — send, wait, bind
 *     Protocol v2                     — message/delivery, claim, lease, ACK, at-least-once
 *
 * Nothing here is consulted by the pump, the claim path or the invariant check. A commander task is a
 * *descriptive* record of a client's own loop, in the same spirit as the dispatch store: useful to read
 * back, never a routing input. There is no commander-specific ACK and no commander-specific delivery
 * state, because transport does not decide whether a task is finished.
 *
 * ## Why the state machine exists at all
 *
 * The failure it prevents is specific and was observed: a client sends work to the executor, the send
 * succeeds, and the client treats that as completion. **Sending a task is not task completion.** A
 * successful delivery proves the transport worked, nothing more. Encoding the states makes the honest
 * position explicit — after `delegating` the only legal move is `waiting`, never `completed`.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where commander task records live, beside — never inside — the protocol directories. */
const COMMANDER_DIR = "commander";

/**
 * The states a commander task may be in.
 *
 * `waiting` is the state that keeps a client alive: after delegating, the only way forward is to wait
 * for the executor, so there is deliberately no transition from `delegating` to `completed`.
 */
export const COMMANDER_STATES = [
	"planning",
	"resolving_target",
	"binding",
	"delegating",
	"waiting",
	"reviewing",
	"following_up",
	"blocked",
	"completed"
];

/**
 * Legal transitions. Anything absent is refused, which is the point: a state machine that permits
 * everything documents nothing.
 *
 * `delegating -> completed` is intentionally missing. Getting stuck, by contrast, *is* reachable from
 * `delegating`: a hand-off can fail outright, and the machine refuses premature success, not bad news.
 */
const TRANSITIONS = {
	planning: ["resolving_target", "blocked"],
	resolving_target: ["binding", "planning", "blocked"],
	binding: ["delegating", "blocked"],
	delegating: ["waiting", "blocked"],
	waiting: ["reviewing", "following_up", "blocked"],
	reviewing: ["completed", "following_up", "blocked"],
	following_up: ["waiting", "blocked"],
	blocked: ["planning", "resolving_target", "waiting"],
	completed: []
};

/** Terminal states. A completed task is not reopened; a new goal is a new task. */
const TERMINAL = ["completed"];

/**
 * File for one commander task.
 *
 * @param {string} root - bridge root.
 * @param {string} taskId - the task id.
 * @returns {string} absolute path.
 */
const taskPath = (root, taskId) => join(root, COMMANDER_DIR, `${taskId}.json`);

/**
 * Ensure the commander directory exists.
 *
 * @param {string} root - bridge root.
 */
function ensureDir(root) {
	mkdirSync(join(root, COMMANDER_DIR), { recursive: true });
}

/**
 * Read one task.
 *
 * @param {string} root - bridge root.
 * @param {string} taskId - the task id.
 * @returns {object|null} the record, or null when absent or unreadable.
 */
export function getCommanderTask(root, taskId) {
	const path = taskPath(root, String(taskId));
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Every commander task, oldest first.
 *
 * @param {string} root - bridge root.
 * @returns {object[]} the records.
 */
export function listCommanderTasks(root) {
	const dir = join(root, COMMANDER_DIR);
	if (!existsSync(dir)) return [];
	const tasks = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			tasks.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
		} catch {
			// An unreadable record is skipped rather than breaking the listing: these records are
			// descriptive, so one bad file must not hide the rest.
		}
	}
	return tasks.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/**
 * Start a commander task for one user goal.
 *
 * @param {string} root - bridge root.
 * @param {object} input - `goal` (required), optional `taskId`, `threadId`, `targetSessionId`.
 * @returns {object} the created record.
 */
export function createCommanderTask(root, input = {}) {
	const goal = String(input.goal ?? "").trim();
	if (goal === "") throw new Error("harnessmux: a commander task needs the user's goal");
	ensureDir(root);
	const now = new Date().toISOString();
	const task = {
		taskId: typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : `commander-${randomUUID()}`,
		state: "planning",
		iteration: 0,
		initialUserGoal: goal,
		threadId: typeof input.threadId === "string" ? input.threadId.trim() : "",
		targetSessionId: typeof input.targetSessionId === "string" ? input.targetSessionId.trim() : "",
		currentMessageId: "",
		currentDeliveryId: "",
		lastPeerMessageId: "",
		verdict: "",
		startedAt: now,
		lastActivityAt: now
	};
	writeFileSync(taskPath(root, task.taskId), `${JSON.stringify(task, null, 2)}\n`, "utf8");
	return task;
}

/**
 * Move a task to a new state, refusing anything the machine does not allow.
 *
 * Refusing is the feature. If `delegating -> completed` were permitted, the exact behaviour this layer
 * exists to prevent would be expressible, and a client could mark a task done the moment the send
 * returned.
 *
 * @param {string} root - bridge root.
 * @param {string} taskId - the task id.
 * @param {string} next - the target state.
 * @param {object} [patch] - additional fields to record, e.g. `currentDeliveryId`.
 * @returns {object} the updated record.
 * @throws {Error} when the task is unknown or the transition is not allowed.
 */
export function transitionCommanderTask(root, taskId, next, patch = {}) {
	const task = getCommanderTask(root, taskId);
	if (task === null) throw new Error(`harnessmux: unknown commander task ${taskId}`);
	if (!COMMANDER_STATES.includes(next)) throw new Error(`harnessmux: unknown commander state ${next}`);
	const allowed = TRANSITIONS[task.state] ?? [];
	if (!allowed.includes(next)) {
		const hint = task.state === "delegating" && next === "completed"
			? " — a task cannot be completed before the executor has been waited on and its result reviewed"
			: "";
		throw new Error(`harnessmux: commander task ${taskId} cannot go ${task.state} -> ${next}${hint}`);
	}
	const updated = {
		...task,
		...patch,
		state: next,
		// `iteration` counts executor rounds, so it advances when work is *sent*, not when state moves.
		iteration: next === "delegating" || next === "following_up" ? task.iteration + 1 : task.iteration,
		lastActivityAt: new Date().toISOString()
	};
	writeFileSync(taskPath(root, task.taskId), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
	return updated;
}

/**
 * Whether a task may still be advanced.
 *
 * @param {object} task - a commander task record.
 * @returns {boolean} true when the task is in a terminal state.
 */
export function isCommanderTaskFinished(task) {
	return task !== null && TERMINAL.includes(task.state);
}

/**
 * The client's request id for one round of a task.
 *
 * Rounds are the unit of idempotency: a retry *within* a round must collapse onto the original
 * submission, while a genuine new round must not be mistaken for a duplicate. An explicit, per-round
 * key gives both, without ever comparing message bodies — identical text may legitimately be sent
 * twice as two real rounds.
 *
 * @param {object|string} task - the task record, or a task id.
 * @param {number} round - the round number, counting from 1.
 * @returns {string} the request id, e.g. `commander-abc-round-2`.
 */
export function commanderRequestId(task, round) {
	const taskId = typeof task === "string" ? task : task?.taskId;
	if (typeof taskId !== "string" || taskId === "") throw new Error("harnessmux: a commander request id needs a task id");
	const n = Number(round);
	if (!Number.isInteger(n) || n < 1) throw new Error("harnessmux: a commander round must be a positive integer");
	return `${taskId}-round-${n}`;
}
