/**
 * The endpoint must keep publishing the live session set, in every tick.
 *
 * Why this exists: the P3.3-C acceptance run addressed a session that the endpoint still
 * advertised 50 minutes after it had stopped, and its delivery waited forever. The trace
 * showed the pump working on a *different* session in the same ticks, which points at
 * `refreshEndpointIfChanged()` not running on the delivering path — the pump returns early
 * once it has work, and the publish used to sit after that return.
 *
 * A published session list that lags reality is worse than no list: `list_sessions` and
 * every adapter's binding UI read it, and a client that binds to a stopped session sees a
 * delivery that never arrives.
 *
 * Run: node tests/endpoint-freshness.test.mjs   (takes ~25 s: it waits for real ticks)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../packages/core/core-v2.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "hxmux-endpoint-"));
core.ensureBridge(ROOT, { remember: false });

const plugin = await import(pathToFileURL(join(import.meta.dirname, "..", "packages", "receiver-dsh", "index.js")).href);

/** A mock harness with one running agent in a named session. */
function mockContext(sessionId) {
	const effects = [];
	const agent = {
		id: `agent-${sessionId}`,
		status: "running",
		session: { header: { id: sessionId, cwd: ROOT } },
		inject() {},
		steer() {}
	};
	return {
		agent,
		dispose() {
			for (const disposer of effects.splice(0)) disposer();
		},
		ctx: {
			logger: { warn() {} },
			systemPrompt: { getSectionOrder: () => 5000, section() {} },
			tools: { register() {} },
			agents: { roots: () => [agent] },
			on() {},
			effect: (factory) => {
				const disposer = factory();
				if (typeof disposer === "function") effects.push(disposer);
			}
		}
	};
}

const endpointOf = () => core.listEndpoints(ROOT).find((entry) => entry.endpointId === "dsh-endpoint") ?? null;
const waitUntil = async (predicate, timeoutMs = 35_000) => {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
};

// A stale publication, exactly like the one that misled the acceptance run: the endpoint
// claims a session that is not the live one.
core.registerEndpoint(ROOT, { actor: "dsh", endpointId: "dsh-endpoint", sessions: ["session-gone-50-minutes"] });
assert.deepEqual(endpointOf().sessions, ["session-gone-50-minutes"], "the bridge starts with a stale publication");

// Work for the live session, so the pump does NOT take the idle path: this is the path
// that used to skip the publish.
const live = "session-live-now";
const message = core.postMessage(ROOT, { from: "codex", topic: "endpoint freshness", body: "deliver me so the pump is busy" });
core.bindThread(ROOT, { threadId: message.threadId, endpointId: "dsh-endpoint", sessionId: live, mode: "delegated" });
core.enqueueDelivery(ROOT, { messageId: message.messageId });

const mock = mockContext(live);
plugin.apply(mock.ctx, {
	bridgeRoot: ROOT,
	protocolVersion: "v2",
	actor: "dsh",
	peer: "codex",
	endpointId: "dsh-endpoint",
	leaseMs: 60_000
});

// The delivery must actually be handed over, so the busy path is genuinely exercised.
assert.equal(await waitUntil(() => core.listDeliveries(ROOT, "acked").length === 1), true, "the bound delivery is steered and acked");

// The publish must follow within the next tick.
const refreshed = await waitUntil(() => (endpointOf()?.sessions ?? []).includes(live));
const published = endpointOf()?.sessions ?? [];
assert.equal(
	refreshed,
	true,
	`the endpoint must publish the live session while the pump is also delivering (published: ${JSON.stringify(published)})`
);
assert.equal(published.includes("session-gone-50-minutes"), false, "and must drop the session that is gone");

// A second, cheaper invariant: the publish is idempotent, so a steady state does not
// rewrite the file on every tick.
const firstWrite = readFileSync(join(ROOT, "endpoints", "dsh-endpoint.json"), "utf8");
await new Promise((resolve) => setTimeout(resolve, 11_000));
assert.equal(readFileSync(join(ROOT, "endpoints", "dsh-endpoint.json"), "utf8"), firstWrite, "an unchanged session set is not republished");

mock.dispose();
const report = core.verifyInvariants(ROOT);
assert.equal(report.ok, true, `invariants hold: ${report.violations.join("; ")}`);
rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
console.log("endpoint-freshness.test.mjs: all assertions passed");
