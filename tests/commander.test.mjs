/**
 * Commander Mode state machine.
 *
 * The layer this covers exists to prevent one specific failure: a client treats a successful send as
 * task completion. "Sending a task is not task completion" is not a slogan here — it is a transition
 * the machine refuses, and this suite is what proves the refusal still happens.
 *
 * Nothing in this suite touches Protocol v2. A commander task is a descriptive record of a client's own
 * loop: it is stored beside the protocol directories, never inside them, and the pump, the claim path
 * and the invariant check never read it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as commander from "../packages/core/commander.mjs";
import * as core from "../packages/core/core-v2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Run one isolated case against a throwaway bridge root. */
const withRoot = (fn) => {
	const root = mkdtempSync(join(tmpdir(), "hxmux-commander-"));
	try {
		return fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
};

// --- 1. a task starts in planning and remembers the user's actual goal ----------
withRoot((root) => {
	core.ensureBridge(root, { remember: false });
	const task = commander.createCommanderTask(root, { goal: "fix the installer", threadId: "th-1", targetSessionId: "session-A" });
	assert.equal(task.state, "planning", "a new task starts in planning, not in flight");
	assert.equal(task.iteration, 0, "and no round has been sent");
	assert.equal(task.initialUserGoal, "fix the installer", "the user's original goal is recorded verbatim, because review is against it");
	assert.equal(commander.isCommanderTaskFinished(task), false, "a fresh task is not finished");
	assert.throws(() => commander.createCommanderTask(root, { goal: "   " }), /needs the user's goal/u, "a task without a goal is refused");
});

// --- 2. the happy path, and the one transition that must never exist -----------
withRoot((root) => {
	core.ensureBridge(root, { remember: false });
	const task = commander.createCommanderTask(root, { goal: "goal", threadId: "th-1", targetSessionId: "session-A" });
	for (const state of ["resolving_target", "binding", "delegating"]) commander.transitionCommanderTask(root, task.taskId, state);

	// This is the whole point of the file. If `delegating -> completed` were allowed, a client could
	// mark the user's task done the instant `send_message` returned.
	assert.throws(
		() => commander.transitionCommanderTask(root, task.taskId, "completed"),
		/cannot go delegating -> completed/u,
		"a task cannot be completed straight after delegating"
	);
	// Getting stuck, unlike finishing, is a legitimate thing to discover right after a send: the
	// hand-off itself can fail. The machine refuses premature *success*, not bad news.
	const stuck = commander.transitionCommanderTask(root, task.taskId, "blocked");
	assert.equal(stuck.state, "blocked", "but genuinely failing to hand the work over can be reported as blocked");
	// A self-transition is refused too: idling in place is not progress, and allowing it would let a
	// client look busy while nothing changes.
	assert.throws(() => commander.transitionCommanderTask(root, task.taskId, "blocked"), /cannot go blocked -> blocked/u, "a state does not transition to itself");
	commander.transitionCommanderTask(root, task.taskId, "waiting");

	// Waiting, review, and a genuine follow-up round. `blocked` already moved back to `waiting` above.
	for (const state of ["reviewing", "following_up", "waiting", "reviewing", "completed"]) {
		commander.transitionCommanderTask(root, task.taskId, state);
	}
	const done = commander.getCommanderTask(root, task.taskId);
	assert.equal(done.state, "completed", "the full loop reaches completed");
	assert.equal(commander.isCommanderTaskFinished(done), true, "and is then terminal");
	assert.throws(() => commander.transitionCommanderTask(root, task.taskId, "waiting"), /cannot go completed/u, "a completed task is not reopened");

	// Round counting follows the executor rounds, not the state changes.
	assert.equal(done.iteration, 2, "two rounds were actually sent: the first task and one follow-up");
});

// --- 3. an out-of-order transition is refused, not coerced ---------------------
withRoot((root) => {
	core.ensureBridge(root, { remember: false });
	const task = commander.createCommanderTask(root, { goal: "goal" });
	assert.throws(() => commander.transitionCommanderTask(root, task.taskId, "waiting"), /cannot go planning -> waiting/u, "a task cannot wait on work it never resolved a target for");
	assert.throws(() => commander.transitionCommanderTask(root, task.taskId, "reviewing"), /cannot go planning -> reviewing/u, "nor review a result that does not exist");
	assert.throws(() => commander.transitionCommanderTask(root, task.taskId, "nonsense"), /unknown commander state/u, "an unknown state is refused");
	assert.throws(() => commander.transitionCommanderTask(root, "missing-task", "planning"), /unknown commander task/u, "an unknown task is refused");
});

// --- 4. rounds: a retry collapses, a real follow-up does not ------------------
withRoot((root) => {
	core.ensureBridge(root, { remember: false });
	const task = commander.createCommanderTask(root, { goal: "goal" });
	assert.equal(commander.commanderRequestId(task, 1), `${task.taskId}-round-1`, "round 1 has its own request id");
	assert.equal(commander.commanderRequestId(task, 2), `${task.taskId}-round-2`, "and round 2 a different one");
	assert.notEqual(commander.commanderRequestId(task, 1), commander.commanderRequestId(task, 2), "so a real follow-up is never mistaken for a retry");
	assert.equal(commander.commanderRequestId(task, 1), commander.commanderRequestId(task, 1), "while a retry within a round reuses the id, which is what suppresses it");
	assert.throws(() => commander.commanderRequestId(task, 0), /positive integer/u, "rounds are 1-based");
	assert.throws(() => commander.commanderRequestId("", 1), /needs a task id/u, "a request id needs a task");

	// The id is scoped by author + thread in the core, so a round id cannot collide across tasks.
	const first = core.postMessage(root, { from: "codex", clientRequestId: commander.commanderRequestId(task, 1), topic: "round", kind: "instruction", body: "do round one" });
	assert.equal(core.findMessageByRequestId(root, { from: "codex", clientRequestId: commander.commanderRequestId(task, 1) })?.messageId, first.messageId, "the round id resolves to its own message");
	assert.equal(core.findMessageByRequestId(root, { from: "codex", clientRequestId: commander.commanderRequestId(task, 2) }), null, "and round 2 is not suppressed by round 1");
});

// --- 5. the state file is descriptive: it never enters the protocol -----------
withRoot((root) => {
	core.ensureBridge(root, { remember: false });
	const task = commander.createCommanderTask(root, { goal: "goal" });
	commander.transitionCommanderTask(root, task.taskId, "resolving_target");
	assert.equal(existsSync(join(root, "commander", `${task.taskId}.json`)), true, "the task lives under commander/, beside the protocol directories");
	assert.equal(existsSync(join(root, "messages", `${task.taskId}.json`)), false, "and never in messages/");
	assert.equal(existsSync(join(root, "queue", `${task.taskId}.json`)), false, "nor in queue/");

	// The proof that transport is unaffected: adding a commander task cannot disturb the invariants.
	const before = core.verifyInvariants(root);
	assert.equal(before.ok, true, "invariants hold with no protocol traffic");
	const message = core.postMessage(root, { from: "codex", topic: "t", kind: "instruction", body: "x" });
	core.enqueueDelivery(root, { messageId: message.messageId });
	const after = core.verifyInvariants(root);
	assert.equal(after.ok, true, "and still hold with a commander task present");
	assert.equal(after.violations.length, 0, "with no violations invented by the workflow layer");
	assert.deepEqual(commander.listCommanderTasks(root).map((t) => t.taskId), [task.taskId], "the task is listable");

	// A commander task is not a delivery and cannot be mistaken for one.
	assert.equal(core.listDeliveries(root, "queued").length, 1, "exactly one delivery exists, the one that was enqueued");
});

// --- 6. the receiver hands the Executor contract to the model with the work -----
{
	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	assert.match(source, /Reply with evidence a reviewer can check/u, "a delegated delivery tells the receiver what a reviewable reply looks like");
	assert.match(source, /Do not reply with only a completion claim/u, "and refuses a bare completion claim in the same breath");
}

// --- 7. both client-facing skills carry the Commander rule ---------------------
// The Codex copy is not a third file here: the adapter deliberately keeps none, and the installer copies
// the one shared skill to `$CODEX_HOME/skills/harnessmux/SKILL.md`. What this pins is that the *sources*
// a client can be given never disagree — a rule that drifts between clients holds for only one of them.
{
	const copies = [
		"packages/portable-plugin/skills/harnessmux/SKILL.md",
		"packages/adapter-claude/skills/harnessmux/SKILL.md"
	];
	for (const relative of copies) {
		const skill = readFileSync(join(HERE, "..", relative), "utf8");
		assert.match(skill, /Sending work to DeepSeek Harness is not completion/u, `${relative} states the core rule`);
		assert.match(skill, /client_request_id/u, `${relative} explains the send-once key`);
		assert.match(skill, /Never resend because a wait timed out/u, `${relative} forbids the resend that caused a duplicate task`);
		assert.match(skill, /wait_for_reply/u, `${relative} tells the commander how to stay`);
	}
	assert.equal(
		readFileSync(join(HERE, "..", copies[1]), "utf8"),
		readFileSync(join(HERE, "..", copies[0]), "utf8"),
		"the two shipped copies are byte-identical, so the rule cannot drift between clients"
	);
}

// --- 8. the executor skill exists and names the review contract ---------------
{
	const executor = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "skills", "harnessmux-executor", "SKILL.md"), "utf8");
	for (const heading of ["RESULT", "EVIDENCE", "LIMITATIONS", "VERDICT"]) {
		assert.match(executor, new RegExp(heading, "u"), `the executor skill asks for ${heading}`);
	}
	assert.match(executor, /Decide these yourself/u, "and tells the executor what not to ask the commander");
	assert.match(executor, /State limitations plainly/u, "and to be honest about what is unverified");
}

// --- 9. the module stays free of transport concerns ---------------------------
{
	const source = readFileSync(join(HERE, "..", "packages", "core", "commander.mjs"), "utf8");
	assert.equal(source.includes("claimDelivery"), false, "the workflow layer never claims a delivery");
	assert.equal(source.includes("ackDelivery"), false, "and never acks one");
	assert.equal(source.includes("enqueueDelivery"), false, "and never creates one — transport is not its business");
	assert.equal(typeof pathToFileURL, "function", "pathToFileURL stays imported for the module loader");
}

console.log("commander.test.mjs: all assertions passed");
