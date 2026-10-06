/**
 * DSH plugin v2 delivery-path test.
 *
 * The v1 plugin path is covered by plugin.test.mjs. This file pins the v2
 * lifecycle, whose ordering is load-bearing: **claim → load → steer → ack**,
 * with a release (not an ack) whenever the steer fails. Acking before a
 * successful steer would recreate v1's "possibly lost forever" failure mode.
 *
 * Run: node tests/plugin-v2.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..", "test-bridge-plugin-v2");
process.env.AGENT_BRIDGE_DIR = ROOT;

rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
mkdirSync(ROOT, { recursive: true });

const core = await import("../lib/core-v2.mjs");
core.ensureBridge(ROOT);
core.registerEndpoint(ROOT, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: ["session-1", "session-2"] });

/** A mock Cordis context that records injections and steers. */
function mockContext(options = {}) {
	const registered = [];
	const sections = [];
	const handlers = new Map();
	const injected = [];
	const steered = [];
	const effects = [];
	const sessionId = options.sessionId ?? "session-1";
	const agent = {
		id: `agent-${sessionId}`,
		status: options.status ?? "running",
		session: { header: { id: sessionId, cwd: ROOT } },
		inject: (message) => injected.push(message),
		steer: (message) => {
			if (options.steerThrows === true) throw new Error("steer refused");
			steered.push(message);
		}
	};
	return {
		registered,
		sections,
		injected,
		steered,
		agent,
		handlers,
		dispose: () => {
			for (const disposer of effects.reverse()) disposer();
		},
		ctx: {
			logger: { warn: () => {} },
			systemPrompt: { getSectionOrder: () => 5000, section: (value) => sections.push(value) },
			tools: { register: (value) => registered.push(value) },
			agents: { roots: () => [agent] },
			on: (event, handler) => handlers.set(event, handler),
			effect: (factory) => {
				const disposer = factory();
				if (typeof disposer === "function") effects.push(disposer);
			}
		}
	};
}

const plugin = await import(pathToFileURL(join(import.meta.dirname, "..", "plugin", "index.js")).href);
/** Wait for the plugin's watcher to fire. */
const waitUntil = async (predicate, timeoutMs = 20_000) => {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
};

// --- 1. a bound delivery is claimed, steered, and acked exactly once ------------
{
	const message = core.postMessage(ROOT, { from: "codex", topic: "delegated work", body: "run the suite" });
	core.bindThread(ROOT, { threadId: message.threadId, endpointId: "dsh-endpoint", sessionId: "session-1", mode: "delegated" });
	const delivery = core.enqueueDelivery(ROOT, { messageId: message.messageId });

	const mock = mockContext();
	plugin.apply(mock.ctx, { bridgeRoot: ROOT, protocolVersion: "v2", actor: "dsh", peer: "codex", endpointId: "dsh-endpoint", leaseMs: 60_000 });

	assert.equal(await waitUntil(() => mock.steered.length > 0), true, "the v2 watcher steers the delivery");
	assert.match(JSON.stringify(mock.steered[0]), /run the suite/u, "the steer carries the message body");
	assert.match(JSON.stringify(mock.steered[0]), /delegated/u, "the steer states the trust mode");
	assert.equal(await waitUntil(() => core.listDeliveries(ROOT, "acked").length === 1), true, "the delivery is acked after a successful steer");
	const acked = core.listDeliveries(ROOT, "acked")[0];
	assert.equal(acked.deliveryId, delivery.deliveryId, "the acked delivery is the one that was queued");
	assert.equal(acked.attempt, 1, "the ack records attempt 1");
	assert.equal(core.listDeliveries(ROOT, "queued").length, 0, "nothing is left queued");
	assert.equal(core.listDeliveries(ROOT, "claimed").length, 0, "nothing is left claimed");
	mock.dispose();
	const report = core.verifyInvariants(ROOT);
	assert.equal(report.ok, true, `invariants hold: ${report.violations.join("; ")}`);
}

// --- 2. a steer failure releases instead of acking -----------------------------
{
	const message = core.postMessage(ROOT, { from: "codex", topic: "failing work", body: "this steer will fail" });
	core.bindThread(ROOT, { threadId: message.threadId, endpointId: "dsh-endpoint", sessionId: "session-1", mode: "advisory" });
	const delivery = core.enqueueDelivery(ROOT, { messageId: message.messageId });

	const mock = mockContext({ steerThrows: true });
	plugin.apply(mock.ctx, { bridgeRoot: ROOT, protocolVersion: "v2", actor: "dsh", peer: "codex", endpointId: "dsh-endpoint", leaseMs: 60_000 });

	// The delivery starts queued, so the observable proof that the pump ran is the
	// attempt counter appearing on the same deliveryId after the release.
	assert.equal(
		await waitUntil(() => (core.getDelivery(ROOT, delivery.deliveryId)?.attempt ?? 0) >= 1),
		true,
		"the failed steer was attempted and released back to the queue"
	);
	const firstAttempt = core.getDelivery(ROOT, delivery.deliveryId).attempt;
	// The pinned backoff must stop the watcher from re-claiming every tick.
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	const queued = core.getDelivery(ROOT, delivery.deliveryId);
	assert.equal(queued.state, "queued", "the delivery is queued, not acked");
	assert.ok(queued.attempt <= firstAttempt + 1, `the retry backoff prevents a claim storm (attempt=${queued.attempt})`);
	assert.equal(core.listDeliveries(ROOT, "acked").length, 1, "no new ack was fabricated by the failed steer");
	mock.dispose();
}

// --- 3. a delivery for another session is never consumed ----------------------
{
	const message = core.postMessage(ROOT, { from: "codex", topic: "other session", body: "not yours" });
	core.bindThread(ROOT, { threadId: message.threadId, endpointId: "dsh-endpoint", sessionId: "session-2", mode: "delegated" });
	const delivery = core.enqueueDelivery(ROOT, { messageId: message.messageId });

	// This agent is session-1; the delivery is bound to session-2.
	const mock = mockContext({ sessionId: "session-1" });
	plugin.apply(mock.ctx, { bridgeRoot: ROOT, protocolVersion: "v2", actor: "dsh", peer: "codex", endpointId: "dsh-endpoint", leaseMs: 60_000 });
	await new Promise((resolve) => setTimeout(resolve, 700));
	assert.equal(mock.steered.length, 0, "another session's delivery is not steered here");
	assert.equal(core.getDelivery(ROOT, delivery.deliveryId).state, "queued", "and it stays queued for its own session");
	mock.dispose();
}

// --- 4. unrouted deliveries are never consumed (frozen rule) ------------------
{
	const message = core.postMessage(ROOT, { from: "codex", topic: "unbound thread", body: "no binding yet" });
	const delivery = core.enqueueDelivery(ROOT, { messageId: message.messageId, target: null });
	const mock = mockContext();
	plugin.apply(mock.ctx, { bridgeRoot: ROOT, protocolVersion: "v2", actor: "dsh", peer: "codex", endpointId: "dsh-endpoint", leaseMs: 60_000 });
	await new Promise((resolve) => setTimeout(resolve, 700));
	assert.equal(mock.steered.length, 0, "an unrouted delivery is never auto-steered");
	assert.equal(core.getDelivery(ROOT, delivery.deliveryId).state, "queued", "it waits for an explicit binding");
	const report = core.verifyInvariants(ROOT);
	assert.equal(report.ok, true);
	assert.ok(report.awaitingBinding.includes(delivery.deliveryId), "it is reported as awaiting a binding");
	mock.dispose();
}

// --- 5. v1 remains the default protocol ---------------------------------------
{
	const mock = mockContext();
	plugin.apply(mock.ctx, { bridgeRoot: ROOT, actor: "dsh", peer: "codex" });
	assert.equal(mock.registered.length, 1, "the tool still registers under the default protocol");
	mock.dispose();
}

// --- 6. the tool speaks the configured protocol --------------------------------
// Regression from the real Desktop run: with protocolVersion=v2 the tool still
// talked to the v1 store, so `action=status` reported leftover v1 files inside the
// v2 root and the model was told two messages were waiting for it. The tool must
// report the v2 truth and never surface v1 files the v2 pump will never deliver.
{
	const ghost = { id: "20261006102128383-962fe14f", from: "codex", to: "dsh", topic: "ghost", threadId: "ghost-thread", kind: "note", body: "a v1 ghost message" };
	mkdirSync(join(ROOT, "inbox"), { recursive: true });
	mkdirSync(join(ROOT, "log"), { recursive: true });
	writeFileSync(join(ROOT, "inbox", `${ghost.id}.json`), JSON.stringify(ghost), "utf8");
	writeFileSync(join(ROOT, "log", `${ghost.id}.json`), JSON.stringify(ghost), "utf8");

	const mock = mockContext();
	plugin.apply(mock.ctx, { bridgeRoot: ROOT, protocolVersion: "v2", actor: "dsh", peer: "codex", endpointId: "dsh-endpoint", autoWake: false });
	const tool = mock.registered[0];
	const statusText = (await tool.execute({ action: "status" }, { agent: mock.agent })).text;
	assert.match(statusText, /protocol: v2/u, "status declares the v2 protocol");
	assert.match(statusText, /messages=\d+/u, "status reports v2 counters");
	assert.equal(statusText.includes("pendingTotal"), false, "status no longer reports v1 counters");
	const listed = (await tool.execute({ action: "list" }, { agent: mock.agent })).text;
	assert.equal(listed.includes("a v1 ghost message"), false, "the tool never surfaces v1 files inside a v2 bridge");
	mock.dispose();
	rmSync(join(ROOT, "inbox"), { recursive: true, force: true });
	rmSync(join(ROOT, "log"), { recursive: true, force: true });
}

rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
console.log("plugin-v2.test.mjs: all assertions passed");
