/**
 * P0.5 cutover fault injection with per-scenario isolation.
 *
 * A single bridge root cannot host both fault scenarios: the pump's backoff table
 * and one-watcher-per-endpoint registry are module-level by design, so scenario 1
 * keeps competing for its own delivery (its 6s lease expires every 10s tick) and
 * starves scenario 2. Each scenario therefore gets its own root and endpoint,
 * which also removes cross-scenario state from the evidence.
 *
 * Facts the trace established and this file encodes:
 *   - the pump delivers only to a **running** agent;
 *   - it ticks every 10s, so a crash window is only observable when the lease is
 *     shorter than a tick (`leaseMs: 6000`);
 *   - a delivery that starts `queued` proves nothing by still being `queued`:
 *     the attempt counter is the proof that the pump ran.
 *
 * V4-3: a failed steer releases the delivery, writes no ack, counts the attempt,
 *       and backs off instead of re-claiming every tick.
 * V4-4: a crash between a successful steer and the ack leaves the delivery
 *       claimed-but-un-acked; the restart re-delivers the SAME deliveryId with
 *       attempt + 1. The required outcome is "duplicate but not lost".
 *
 * Run: node tests/cutover-faults.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../../packages/core/core-v2.mjs";

const LEASE_MS = 6_000;
const plugin = await import(pathToFileURL(join(import.meta.dirname, "..", "..", "packages", "receiver-dsh", "index.js")).href);

/**
 * Build one isolated scenario: its own root, endpoint, session, trace, and mount.
 *
 * @param {string} label - scenario label used in the trace.
 * @param {object} [options] - `leaseMs` override (default 6s so a crash window
 *   can be observed inside one 10s pump tick).
 * @returns {object} the scenario handle.
 */
function scenario(label, options = {}) {
	const root = mkdtempSync(join(tmpdir(), `ab-${label}-`));
	const endpoint = `ep-${label}`;
	const session = `session-${label}`;
	const sentinel = join(root, "crash.sentinel");
	const trace = [];
	const start = Date.now();
	const leaseMs = options.leaseMs ?? LEASE_MS;
	// A scenario root is throwaway state in a temp directory, which the core cannot
	// recognise as ephemeral by path alone: opt out of the shared root cache so a
	// test run never repoints the user's remembered bridge.
	core.ensureBridge(root, { remember: false });
	core.registerEndpoint(root, { actor: "dsh", endpointId: endpoint, transport: "in-process", sessions: [session] });

	/** Append a trace line; lives outside every mock so disposal cannot stop it. */
	const note = (line) => trace.push(`${String(Date.now() - start).padStart(6)}ms  ${line}`);
	note(`scenario ${label} root=${root}`);

	/**
	 * Mount a mock host agent.
	 *
	 * @param {object} [options] - `steerThrows` to fail the hand-off.
	 * @returns {object} the mock handle.
	 */
	function mount(options = {}) {
		const steered = [];
		const effects = [];
		const agent = {
			id: `agent-${label}`,
			status: "running",
			session: { header: { id: session, cwd: root } },
			inject: () => {},
			steer: (message) => {
				if (options.steerThrows === true) {
					note("STEER THREW (injected)");
					throw new Error("injected steer failure");
				}
				steered.push(message);
				note("STEER OK");
			}
		};
		const ctx = {
			logger: { warn: (line) => note(`warn: ${String(line).slice(0, 100)}`) },
			systemPrompt: { getSectionOrder: () => 5000, section: () => {} },
			tools: { register: () => {} },
			agents: { roots: () => [agent] },
			on: () => {},
			effect: (factory) => {
				const disposer = factory();
				if (typeof disposer === "function") effects.push(disposer);
			}
		};
		plugin.apply(ctx, {
			bridgeRoot: root,
			protocolVersion: "v2",
			actor: "dsh",
			peer: "codex",
			endpointId: endpoint,
			leaseMs,
			crashAfterSteerSentinel: sentinel
		});
		note("mounted");
		return {
			steered,
			dispose: () => {
				for (const disposer of effects.reverse()) disposer();
				effects.length = 0;
				note("disposed");
			}
		};
	}

	/**
	 * Post + bind + queue one delivery in this scenario.
	 *
	 * @param {string} topic - thread topic.
	 * @param {string} body - message body.
	 * @returns {{message: object, delivery: object}} the seeded records.
	 */
	function seed(topic, body) {
		const message = core.postMessage(root, { from: "codex", topic, body });
		core.bindThread(root, { threadId: message.threadId, endpointId: endpoint, sessionId: session, mode: "delegated" });
		const delivery = core.enqueueDelivery(root, { messageId: message.messageId });
		note(`seeded ${delivery.deliveryId}`);
		return { message, delivery };
	}

	/**
	 * Wait until the delivery's attempt counter appears (proof the pump ran).
	 *
	 * @param {string} deliveryId - the delivery to watch.
	 * @param {number} timeoutMs - how long to wait.
	 * @returns {Promise<boolean>} whether an attempt was recorded.
	 */
	async function waitForAttempt(deliveryId, timeoutMs) {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const current = core.getDelivery(root, deliveryId);
			if ((current?.attempt ?? 0) >= 1) {
				note(`attempt=${current.attempt} state=${current.state}`);
				return true;
			}
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		note("TIMEOUT waiting for an attempt");
		return false;
	}

	/**
	 * Wait until a delivery reaches a state.
	 *
	 * @param {string} deliveryId - the delivery to watch.
	 * @param {string} state - expected state.
	 * @param {number} timeoutMs - how long to wait.
	 * @returns {Promise<object>} the last observed delivery.
	 */
	async function waitForState(deliveryId, state, timeoutMs) {
		const started = Date.now();
		let last = null;
		while (Date.now() - started < timeoutMs) {
			last = core.getDelivery(root, deliveryId);
			if (last?.state === state) {
				note(`reached ${state} attempt=${last.attempt}`);
				return last;
			}
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		note(`TIMEOUT waiting for ${state}; last=${last?.state} attempt=${last?.attempt}`);
		return last;
	}

	return {
		label,
		root,
		endpoint,
		session,
		sentinel,
		trace,
		note,
		mount,
		seed,
		waitForAttempt,
		waitForState,
		cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
	};
}

// ---------------------------------------------------------------------------
// V4-3: steer failure → release, no ack, attempt counted, backoff honoured
// ---------------------------------------------------------------------------
{
	const s = scenario("v43");
	const { delivery } = s.seed("fault: steer failure", "this hand-off will fail");
	const failing = s.mount({ steerThrows: true });

	assert.equal(await s.waitForAttempt(delivery.deliveryId, 30_000), true, "V4-3: the failed hand-off was attempted");
	const after = await s.waitForState(delivery.deliveryId, "queued", 10_000);
	for (const line of s.trace) console.log(`  ${line}`);
	assert.equal(after.state, "queued", "V4-3: a failed steer returns the delivery to the queue");
	assert.ok(after.attempt >= 1, `V4-3: the attempt is counted (attempt=${after.attempt})`);
	assert.equal(core.listDeliveries(s.root, "acked").length, 0, "V4-3: no ack was written for a failed steer");
	assert.equal(failing.steered.length, 0, "V4-3: steer never reported success");

	// Backoff: past the 1s base backoff but well inside the 10s tick, the attempt
	// must not grow again — a claim storm would add attempts every tick.
	const settledAttempt = after.attempt;
	await new Promise((resolve) => setTimeout(resolve, 2_500));
	const later = core.getDelivery(s.root, delivery.deliveryId);
	assert.ok(later.attempt <= settledAttempt + 1, `V4-3: backoff suppressed a claim storm (${settledAttempt} -> ${later.attempt})`);
	console.log(`  V4-3 VERDICT: released=yes acked=no attempt=${later.attempt} backoff=ok`);
	failing.dispose();
	s.cleanup();
}

// ---------------------------------------------------------------------------
// V4-4: crash between a successful steer and the ack → duplicate, not lost
// ---------------------------------------------------------------------------
{
	const s = scenario("v44");
	const { message, delivery } = s.seed("fault: crash window", "CRASH-WINDOW-7731");

	// cycle 1 — the steer succeeds and the "process" dies before the ack.
	writeFileSync(s.sentinel, "crash", "utf8");
	const crashed = s.mount();
	assert.equal(await s.waitForAttempt(delivery.deliveryId, 30_000), true, "V4-4: the pump attempted the delivery");
	await new Promise((resolve) => setTimeout(resolve, 300));
	const crashState = core.getDelivery(s.root, delivery.deliveryId);
	for (const line of s.trace) console.log(`  ${line}`);
	assert.equal(crashState.state, "claimed", `V4-4: the crash left the delivery claimed (got ${crashState.state})`);
	assert.ok(crashState.attempt >= 1, "V4-4: the crash attempt is recorded");
	assert.equal(core.listDeliveries(s.root, "acked").some((entry) => entry.deliveryId === delivery.deliveryId), false, "V4-4: no ack exists at the crash point");
	assert.equal(crashed.steered.length, 1, "V4-4: the host received the message once before the crash");
	crashed.dispose();
	console.log(`  V4-4 CYCLE1: claimed+unacked, host steered=${crashed.steered.length}, acks=0`);

	// cycle 2 — restart with the sentinel cleared: the stale claim must be
	// recovered past its lease and re-delivered on the SAME deliveryId.
	rmSync(s.sentinel, { force: true });
	const restarted = s.mount();
	const recovered = await s.waitForState(delivery.deliveryId, "acked", 60_000);
	for (const line of s.trace.filter((entry) => entry.includes("CYCLE") === false).slice(-12)) console.log(`  ${line}`);
	assert.equal(recovered.state, "acked", "V4-4: the delivery is acked after recovery");
	assert.equal(recovered.attempt, 2, `V4-4: recovery is attempt 2 on the same deliveryId (got ${recovered.attempt})`);
	assert.equal(restarted.steered.length, 1, "V4-4: the host saw the message a second time — the duplicate is expected");
	const copies = core.listMessages(s.root).filter((entry) => entry.messageId === message.messageId);
	assert.equal(copies.length, 1, "V4-4: the immutable message exists exactly once");
	assert.match(copies[0].body, /CRASH-WINDOW-7731/u, "V4-4: the body is unchanged");
	const ackRecord = core.listDeliveries(s.root, "acked").find((entry) => entry.deliveryId === delivery.deliveryId);
	assert.equal(ackRecord.messageId, message.messageId, "V4-4: the ack references the original message");

	core.reconcile(s.root);
	const report = core.verifyInvariants(s.root);
	assert.equal(report.ok, true, `V4-4: invariants hold after recovery (${report.violations.join("; ")})`);
	assert.equal(report.claimed, 0, "V4-4: no claim is left dangling");
	console.log(`  V4-4 VERDICT: duplicate but not lost (attempt=${recovered.attempt}, message copies=1, invariants ok)`);
	restarted.dispose();
	s.cleanup();
}

// ---------------------------------------------------------------------------
// V4-4b: the same crash with a production-length lease
//
// The short-lease variant above exists to observe recovery inside one pump tick.
// This variant answers the more important question for real deployments: if the
// process restarts while the claim's lease is still running, is the delivery lost?
// It must not be — the claim survives on disk with its attempt count and is
// delivered exactly once more when the lease expires.
// ---------------------------------------------------------------------------
{
	const s = scenario("v44b", { leaseMs: 90_000 });
	const { message, delivery } = s.seed("fault: crash window long lease", "LONG-LEASE-CRASH-5521");

	writeFileSync(s.sentinel, "crash", "utf8");
	const crashed = s.mount();
	assert.equal(await s.waitForAttempt(delivery.deliveryId, 30_000), true, "V4-4b: the pump attempted the delivery");
	await new Promise((resolve) => setTimeout(resolve, 300));
	const crashState = core.getDelivery(s.root, delivery.deliveryId);
	for (const line of s.trace) console.log(`  ${line}`);
	assert.equal(crashState.state, "claimed", "V4-4b: the crash left the delivery claimed");
	assert.equal(core.listDeliveries(s.root, "acked").length, 0, "V4-4b: nothing was acked");
	crashed.dispose();

	// "Restart" immediately: the lease has not expired, so the delivery must NOT be
	// re-delivered yet — but it must still be there, claimed and un-acked.
	rmSync(s.sentinel, { force: true });
	const restarted = s.mount();
	await new Promise((resolve) => setTimeout(resolve, 12_000));
	const afterRestart = core.getDelivery(s.root, delivery.deliveryId);
	assert.notEqual(afterRestart, null, "V4-4b: the delivery still exists after a restart");
	assert.equal(afterRestart.state, "claimed", "V4-4b: the unexpired claim is preserved, not discarded");
	assert.equal(afterRestart.attempt, 1, "V4-4b: the attempt count survived the restart");
	assert.equal(restarted.steered.length, 0, "V4-4b: no premature re-delivery while the lease is valid");
	const messages = core.listMessages(s.root).filter((entry) => entry.messageId === message.messageId);
	assert.equal(messages.length, 1, "V4-4b: the immutable message is intact");
	assert.equal(core.verifyInvariants(s.root).ok, true, "V4-4b: invariants hold with a claim surviving a restart");

	// Force the lease to expire and prove the delivery still completes.
	core.reconcile(s.root, { now: Date.now() + 120_000 });
	const recovered = await s.waitForState(delivery.deliveryId, "acked", 60_000);
	for (const line of s.trace.slice(-10)) console.log(`  ${line}`);
	assert.equal(recovered.state, "acked", "V4-4b: the delivery completes after the lease expires");
	assert.equal(recovered.attempt, 2, "V4-4b: the recovery is attempt 2 on the same deliveryId");
	assert.equal(core.listDeliveries(s.root, "acked").length, 1, "V4-4b: exactly one ack");
	console.log(`  V4-4b VERDICT: not lost across a restart with a live lease (attempt=${recovered.attempt})`);
	restarted.dispose();
	s.cleanup();
}

console.log("\ncutover-faults.test.mjs: all assertions passed (V4-3, V4-4, V4-4b)");
