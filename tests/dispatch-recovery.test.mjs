/**
 * Exactly-once host dispatch — the side-effect window.
 *
 * The dangerous window is the one where the *host* has already accepted the work:
 *
 *   claim delivery → host call → host accepts → receiver dies → lease expires → another receiver retries
 *
 * A local "we dispatched it" flag cannot close it, because the crash can land between the host accepting
 * and the flag being written. What closes it is a **dispatch identity the host itself keeps**: the
 * message handed to `followup` carries `hxmux-dispatch:<executionId>` as its `user/message` id, which was
 * measured to survive into the durable `agent/inbox/spliced` event and the `user/message` event. Recovery
 * therefore asks the target session's own record — the only authority on whether the side effect
 * happened — instead of trusting local state.
 *
 * The three answers are the whole design, and the third one is the point:
 *
 *   found    → adopt the dispatch, never issue it again
 *   absent   → the record was read and the key is not in it; the call may safely be made
 *   unknown  → no record could be read; **wait**, because guessing "it never happened" runs the task twice
 *
 * Run: node tests/dispatch-recovery.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../packages/core/core-v2.mjs";
import * as execution from "../packages/core/execution.mjs";

const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");
const plugin = await import(pathToFileURL(join(HERE, "..", "packages", "receiver-dsh", "index.js")).href);

/** Wait longer than one watch tick. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 1_200));

/**
 * A fake host holding one session, with a log the test controls.
 *
 * @param {string} sessionId - the session.
 * @param {object[]} log - the session's events.
 * @returns {object} the context, the session, what was done to it, and a way to restart the receiver.
 */
function mockHost(sessionId, log) {
	const effects = [];
	const followups = [];
	const session = { header: { id: sessionId }, log };
	const agent = {
		status: "idle",
		session,
		// The host appends the keyed splice **synchronously** inside `followup()` — measured on a live host,
		// it is the first new event and it is there by the time the call returns. The mock has to do the
		// same or it models a host that does not exist, which is what made this test disagree with the
		// recovery logic rather than the other way round.
		followup: (message) => {
			followups.push(message);
			session.log.push({ type: "agent/inbox/spliced", seq: session.log.length, data: { target: "next-turn", start: 0, inserted: [message] } });
			session.log.push({ type: "turn/start", seq: session.log.length, data: { turn: session.log.filter((event) => event.type === "turn/start").length + 1 } });
		},
		steer: () => {}
	};
	const live = [agent];
	return {
		agent,
		session,
		followups,
		live,
		ctx: {
			logger: { warn() {}, info() {} },
			systemPrompt: { getSectionOrder: () => 5000, section: () => {} },
			tools: { register: () => {} },
			agents: { roots: () => live, resume: async () => ({ agent, dispose: () => {} }) },
			get: () => undefined,
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

/** One delegated instruction on a bound thread, delivered to a session. */
function seedDelivery(root, sessionId) {
	const message = core.postMessage(root, { from: "codex", topic: "dispatch-recovery", kind: "instruction", body: "do the work" });
	core.bindThread(root, { threadId: message.threadId, endpointId: "dsh-endpoint", sessionId, mode: "delegated" });
	const delivery = core.enqueueDelivery(root, { messageId: message.messageId, actor: "dsh", endpointId: "dsh-endpoint", sessionId, mode: "delegated" });
	return { message, delivery };
}

/**
 * Age a dispatch attempt, as the passage of time between a crash and a restart would.
 *
 * The recovery rule refuses to conclude anything within one watch interval of the call, so a crash
 * simulated in the same millisecond has to be given the age a real one would have.
 *
 * @param {string} root - bridge root.
 * @param {string} executionId - the execution.
 * @param {number} ms - how far into the past to move the attempt.
 */
function ageDispatchAttempt(root, executionId, ms) {
	const path = join(root, "executions", `${executionId}.json`);
	const record = JSON.parse(readFileSync(path, "utf8"));
	record.dispatchAttemptedAt = new Date(Date.parse(record.dispatchAttemptedAt) - ms).toISOString();
	writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * Put a delivery back into the state a crash between the host call and the ack leaves it in.
 *
 * The ack is written in the same `.then()` that runs immediately after `followup` resolves, so an
 * in-process test cannot observe that window without recreating it: the delivery moves out of `acks/`
 * and back into `claims/`, exactly where a dead receiver leaves it.
 *
 * @param {string} root - bridge root.
 * @param {string} deliveryId - the delivery.
 */
function unAck(root, deliveryId) {
	const acked = join(root, "acks", `${deliveryId}.json`);
	const claimed = join(root, "claims", `${deliveryId}.json`);
	const record = JSON.parse(readFileSync(acked, "utf8"));
	// Reconstruct the *claim* a crash would have left, not the ack. An ack record is terminal and carries
	// no `threadId` — nothing reads it afterwards — while a claim does, because the queue entry it was
	// copied from does. Building the crash state out of the ack would silently drop the thread, and with
	// it the binding, so the receiver would refuse the delivery for the wrong reason.
	const message = core.getMessage(root, record.messageId);
	const claim = {
		deliveryId: record.deliveryId,
		messageId: record.messageId,
		target: record.target,
		threadId: message.threadId,
		mode: record.mode,
		attempt: record.attempt,
		createdAt: record.createdAt,
		claimOwner: "receiver-A",
		claimedAt: new Date(Date.now() - 60_000).toISOString(),
		// The lease has expired by the time a second receiver is looking; that is what lets it re-claim.
		leaseUntil: new Date(Date.now() - 1_000).toISOString()
	};
	writeFileSync(claimed, `${JSON.stringify(claim, null, 2)}\n`, "utf8");
	rmSync(acked, { force: true });
}

/** The `agent/inbox/spliced` event that carries a dispatch key, as the host records it. */
const keyedSplice = (key, seq) => ({ type: "agent/inbox/spliced", seq, data: { target: "next-turn", start: 0, inserted: [{ id: key, role: "user", content: [{ type: "text", text: "work" }] }] } });

// --- D1. the key is derived, never generated, and is the message's id ----------
{
	const key = execution.dispatchKeyFor("exec-7");
	assert.equal(key, "hxmux-dispatch:exec-7", "the dispatch key names the execution");
	assert.equal(execution.dispatchKeyFor("exec-7"), key, "and is stable across calls");
	assert.notEqual(execution.dispatchKeyFor("exec-8"), key, "a different execution is a different dispatch");
	assert.equal(execution.dispatchKeyFor(""), "", "no execution means no key");

	const source = readFileSync(join(HERE, "..", "packages", "receiver-dsh", "index.js"), "utf8");
	assert.match(source, /function makeDispatchMessage\(text, dispatchKey\)/u, "the receiver builds the dispatch message itself");
	assert.match(source, /id: dispatchKey/u, "and puts the key in the message's identity");
	// `createUserMessage` overwrites `id` with a fresh uuid, so using it would silently discard the key.
	assert.match(source, /createUserMessage` cannot be used here/u, "with the reason the standard constructor cannot be used recorded beside it");
}

// --- D2. the state machine keeps "dispatch attempted" separate from "accepted" --
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-dispatch-states-"));
	core.ensureBridge(root, { remember: false });
	try {
		const record = execution.beginExecution(root, {
			deliveryId: "D-dispatch",
			originMessageId: "M1",
			threadId: "T1",
			originActor: "codex",
			sessionId: "session-d",
			dispatchKind: "followup",
			baselineLogSeq: 4
		});
		assert.equal(record.state, "dispatching", "a fresh record is not yet dispatched");
		assert.equal(record.dispatchKey, null, "and carries no key");

		execution.markDispatchInflight(root, record.executionId, { dispatchKey: execution.dispatchKeyFor(record.executionId) });
		const inflight = execution.getExecution(root, record.executionId);
		assert.equal(inflight.state, "dispatch_inflight", "an attempted dispatch is its own state");
		assert.equal(inflight.dispatchKey, "hxmux-dispatch:" + record.executionId, "with the key written before the host is touched");
		assert.equal(execution.executionsAwaitingDispatchRecovery(root).length, 1, "and it is listed as awaiting recovery");
		assert.equal(execution.executionForDelivery(root, "D-dispatch")?.executionId, record.executionId, "the delivery resolves back to its execution");

		// Found: adopted, and the state says "the host has it" — never "dispatch it again".
		execution.adoptDispatch(root, record.executionId, { hostUserMessageId: inflight.dispatchKey });
		const adopted = execution.getExecution(root, record.executionId);
		assert.equal(adopted.state, "running", "an adopted dispatch is running work, not an unknown outcome");
		assert.equal(adopted.hostUserMessageId, inflight.dispatchKey, "with the host's own id for the message it accepted");
		assert.equal(execution.executionsAwaitingDispatchRecovery(root).length, 0, "so nothing awaits recovery any more");

		// Absent: back to "not dispatched", which is the only state from which a dispatch may be issued.
		const other = execution.beginExecution(root, { deliveryId: "D-other", sessionId: "session-d", dispatchKind: "followup", baselineLogSeq: 9 });
		execution.markDispatchInflight(root, other.executionId, { dispatchKey: execution.dispatchKeyFor(other.executionId) });
		execution.resetDispatch(root, other.executionId, { reason: "key absent" });
		const reset = execution.getExecution(root, other.executionId);
		assert.equal(reset.state, "dispatching", "a dispatch proved absent returns to not-yet-dispatched");
		assert.equal(execution.executionsAwaitingDispatchRecovery(root).length, 0, "and stops awaiting recovery");
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- D3. a dispatched message carries the key into the host's own record -------
// The mechanism, exercised through the real wake path rather than asserted about the source.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-dispatch-key-"));
	const sessionId = "session-key";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { delivery } = seedDelivery(root, sessionId);
	const host = mockHost(sessionId, [{ type: "sandbox/mode", seq: 0, data: {} }]);
	plugin.apply(host.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", actor: "dsh", peer: "codex", watchIntervalMs: 250, debugLog: join(root, "trace.log") });
	try {
		await tick();
		assert.equal(host.followups.length, 1, "the idle bound session is woken");
		const handed = host.followups[0];
		const record = execution.executionForDelivery(root, delivery.deliveryId);
		assert.equal(handed.id, "hxmux-dispatch:" + record.executionId, "the message handed to the host carries the dispatch key as its identity");
		assert.equal(record.dispatchKey, handed.id, "and the execution records the same key before the call");
		assert.equal(record.state, "running", "and the dispatch is accepted once the wake resolved");
		assert.equal(core.getDelivery(root, delivery.deliveryId).state, "acked", "with the delivery acked");
		assert.equal(core.getDelivery(root, delivery.deliveryId).note, "woken", "by the normal hand-off");
	} finally {
		host.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- D4. a restart must not dispatch what the host already has -----------------
// The crash window, over the durable state: the first receiver dies after the host accepted the dispatch
// and before the ack. The second receiver must find the key in the session record and ack — not dispatch.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-dispatch-restart-"));
	const sessionId = "session-restart";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { delivery } = seedDelivery(root, sessionId);

	// Receiver A: claims and dispatches; the host accepts. Then A is gone — its delivery stays claimed,
	// which is exactly the state a crash leaves (the lease has to expire before anyone may re-claim).
	const first = mockHost(sessionId, [{ type: "sandbox/mode", seq: 0, data: {} }]);
	plugin.apply(first.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", actor: "dsh", peer: "codex", watchIntervalMs: 250, leaseMs: 1_000, debugLog: join(root, "trace.log") });
	await tick();
	assert.equal(first.followups.length, 1, "receiver A dispatched the delivery");
	const delegatedKey = first.followups[0].id;
	const executionId = execution.executionForDelivery(root, delivery.deliveryId).executionId;
	first.dispose();
	// The host keeps what it accepted: the keyed splice is in the session's own record now, appended by the
	// mock's `followup` exactly as the real host appends it.
	assert.equal(first.session.log.some((event) => event.type === "agent/inbox/spliced" && (event.data.inserted ?? []).some((entry) => entry.id === delegatedKey)), true, "the host's record holds the accepted dispatch");
	// A's attempt is rolled back to the moment of the crash: the host call happened, the record of the
	// acceptance did not, and the delivery was never acked.
	unAck(root, delivery.deliveryId);
	execution.markDispatchInflight(root, executionId, { dispatchKey: delegatedKey });
	// `markDispatchInflight` stamps the attempt time; a rollback written just now would look "too soon to
	// tell" rather than recovered, so age it as the crash would have.
	ageDispatchAttempt(root, executionId, 10_000);
	assert.equal(core.getDelivery(root, delivery.deliveryId).state, "claimed", "the delivery is left claimed by the receiver that died");
	assert.equal(execution.getExecution(root, executionId).state, "dispatch_inflight", "and the execution says the dispatch outcome is unknown");

	// Expire the lease, exactly as time would.
	core.reconcile(root, { now: Date.now() + 60_000 });
	assert.equal(core.getDelivery(root, delivery.deliveryId).state, "queued", "the expired lease returns the delivery to the queue");

	// Receiver B: a fresh instance over the same store and the same session record.
	const second = mockHost(sessionId, first.session.log);
	assert.equal(second.session.log.some((event) => event.type === "agent/inbox/spliced"), true, "the restarted host still holds the accepted dispatch in its record");
	plugin.apply(second.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", actor: "dsh", peer: "codex", watchIntervalMs: 250, leaseMs: 1_000, debugLog: join(root, "trace.log") });
	try {
		await tick();
		await tick();
		assert.equal(second.followups.length, 0, "receiver B does NOT dispatch the work a second time");
		if (process.env.HXMUX_DEBUG_TRACE === "1") {
			process.stdout.write(readFileSync(join(root, "trace.log"), "utf8"));
			process.stdout.write(`bindings=${JSON.stringify(core.listBindings(root))}\n`);
			process.stdout.write(`delivery=${JSON.stringify(core.getDelivery(root, delivery.deliveryId))}\n`);
		}
		const state = core.getDelivery(root, delivery.deliveryId);
		assert.equal(state.state, "acked", "it acknowledges the delivery as recovered");
		assert.equal(state.note, "recovered", "and says so, so a crash recovery is distinguishable from a fresh hand-off");
		assert.equal(state.attempt, 2, "the delivery was claimed twice, which is expected: two receivers owned it");
		const record = execution.getExecution(root, executionId);
		assert.equal(record.state, "running", "the execution is adopted as running work");
		assert.equal(record.hostUserMessageId, delegatedKey, "bound to the message the host accepted");
		assert.equal(core.listMessages(root).filter((entry) => entry.from === "codex").length, 1, "and the logical task still exists exactly once");
		assert.equal(core.verifyInvariants(root).ok, true, "the protocol invariants hold across the restart");
	} finally {
		second.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- D5. "cannot tell" must never be treated as "never dispatched" -------------
// The fail-closed rule. A session that is not loaded and a store that cannot be read look identical to a
// dispatch that never happened, and the difference is whether the task runs twice.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-dispatch-ambiguous-"));
	const sessionId = "session-ambiguous";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { delivery } = seedDelivery(root, sessionId);
	const record = execution.beginExecution(root, {
		deliveryId: delivery.deliveryId,
		originMessageId: delivery.messageId,
		threadId: core.getMessage(root, delivery.messageId).threadId,
		originActor: "codex",
		sessionId,
		dispatchKind: "followup",
		baselineLogSeq: 3
	});
	execution.markDispatchInflight(root, record.executionId, { dispatchKey: execution.dispatchKeyFor(record.executionId) });

	// No live session at all, and no durable query service either: nothing can be read.
	const host = mockHost(sessionId, []);
	host.live.length = 0;
	plugin.apply(host.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", actor: "dsh", peer: "codex", watchIntervalMs: 250, debugLog: join(root, "trace.log") });
	try {
		await tick();
		await tick();
		assert.equal(host.followups.length, 0, "an unprovable dispatch is never re-issued");
		const state = core.getDelivery(root, delivery.deliveryId);
		assert.equal(state.state === "acked", false, "and nothing is acked on a guess");
		assert.equal(execution.getExecution(root, record.executionId).state, "dispatch_inflight", "the execution stays visibly unresolved rather than being reset");
		const trace = readFileSync(join(root, "trace.log"), "utf8");
		assert.match(trace, /cannot be resolved yet/u, "and the trace says it is waiting rather than acting");
		assert.match(trace, /waiting rather than dispatching again/u, "naming what it refused to do");
	} finally {
		host.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- D6. a key that is provably absent is dispatched with the same key ---------
// The other half of D4: when the record *is* readable and the key is not in it, the earlier attempt left
// nothing behind, so the dispatch is owed and may be issued — under the same deterministic key.
{
	const root = mkdtempSync(join(tmpdir(), "hxmux-dispatch-absent-"));
	const sessionId = "session-absent";
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: [sessionId], remember: false });
	const { delivery } = seedDelivery(root, sessionId);
	const log = [{ type: "sandbox/mode", seq: 0, data: {} }, { type: "turn/start", seq: 1, data: { turn: 1 } }, { type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } }];
	const host = mockHost(sessionId, log);
	const record = execution.beginExecution(root, {
		deliveryId: delivery.deliveryId,
		originMessageId: delivery.messageId,
		threadId: core.getMessage(root, delivery.messageId).threadId,
		originActor: "codex",
		sessionId,
		dispatchKind: "followup",
		baselineLogSeq: 2
	});
	execution.markDispatchInflight(root, record.executionId, { dispatchKey: execution.dispatchKeyFor(record.executionId) });
	plugin.apply(host.ctx, { bridgeRoot: root, protocolVersion: "v2", endpointId: "dsh-endpoint", actor: "dsh", peer: "codex", watchIntervalMs: 250, debugLog: join(root, "trace.log") });
	try {
		await tick();
		assert.equal(host.followups.length, 1, "a dispatch whose key is provably absent is issued");
		assert.equal(host.followups[0].id, execution.dispatchKeyFor(record.executionId), "under the same deterministic key, so a retry cannot fork into two dispatches");
		assert.equal(core.getDelivery(root, delivery.deliveryId).state, "acked", "and the delivery is handed over normally");
	} finally {
		host.dispose();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

console.log("dispatch-recovery.test.mjs: all assertions passed");
