/**
 * Trace-policy regression: a steady state must not grow the log.
 *
 * The pump runs every 10 seconds. Recording one line per tick made the field trace
 * grow without bound while saying nothing new — a 196 KB file that was almost entirely
 * `pump: skip agent status=idle` — which is exactly the kind of noise that hides the
 * transition one is looking for.
 *
 * What is pinned here:
 *   1. N consecutive idle ticks produce **one** line, not N;
 *   2. a real transition (idle → running) still produces a line;
 *   3. a repeated refusal / unrouted delivery is also recorded once, not per tick;
 *   4. mount and dispose each record exactly one line.
 *
 * This is a logging test, not a protocol test: nothing here changes what is delivered.
 *
 * Run: node tests/trace-policy.test.mjs   (takes ~35 s: it waits for real ticks)
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../packages/core/core-v2.mjs";

/** The pump's real cadence; the test waits it out rather than faking time. */
const TICK_MS = 10_000;

const ROOT = mkdtempSync(join(tmpdir(), "hxmux-trace-"));
const TRACE = join(ROOT, "trace.log");
core.ensureBridge(ROOT, { remember: false });
writeFileSync(TRACE, "", "utf8");

const plugin = await import(pathToFileURL(join(import.meta.dirname, "..", "packages", "receiver-dsh", "index.js")).href);

/** A mock harness whose agent status the test can flip. */
function mockContext(agent) {
	const effects = [];
	const registered = [];
	const sections = [];
	return {
		agent,
		registered,
		ctx: {
			logger: { warn() {}, info() {} },
			systemPrompt: { getSectionOrder: () => 5000, section: (value) => sections.push(value) },
			tools: { register: (value) => registered.push(value) },
			agents: { roots: () => [agent] },
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

const traceLines = () => (existsSync(TRACE) ? readFileSync(TRACE, "utf8").trim().split("\n").filter(Boolean) : []);
const linesMatching = (needle) => traceLines().filter((line) => line.includes(needle));

/** Wait until `predicate` holds, or fail with the trace for diagnosis. */
async function waitUntil(label, predicate, timeoutMs = TICK_MS * 3) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	assert.fail(`${label} never happened. trace:\n${traceLines().join("\n")}`);
}

// --- a delivery that can never be routed here -----------------------------------
// It stays queued (target null), so every tick meets it again: the case that used to
// write one line per tick.
const message = core.postMessage(ROOT, { from: "codex", topic: "trace policy", body: "stays unrouted on purpose" });
const unrouted = core.enqueueDelivery(ROOT, { messageId: message.messageId });

// --- mount ----------------------------------------------------------------------
const idleAgent = { status: "idle", steer: () => {}, session: { header: { id: "session-trace" } } };
const mock = mockContext(idleAgent);
plugin.apply(mock.ctx, {
	bridgeRoot: ROOT,
	protocolVersion: "v2",
	actor: "dsh",
	peer: "codex",
	endpointId: "dsh-endpoint",
	debugLog: TRACE,
	leaseMs: 60_000
});

assert.equal(linesMatching("apply: root=").length, 1, "mounting records exactly one startup line");

// --- 1. idle ticks must not multiply lines --------------------------------------
await waitUntil("the first idle observation", () => linesMatching("status=idle").length >= 1);
assert.equal(linesMatching("status=idle").length, 1, "the first idle tick is recorded");
// Since Current Session Control the watcher also considers idle sessions — that is what makes them
// wakeable — so one queue-shape summary per idle session is expected. What must not happen is that
// it grows with the clock. This is the assertion that keeps the trace change-driven.
const summaryAtFirst = linesMatching("pump: sessionId=session-trace").length;
assert.ok(summaryAtFirst <= 1, `at most one queue-shape summary per idle session (got ${summaryAtFirst})`);

// Wait out at least two more ticks. The agent stays idle throughout, so the state is
// genuinely steady — the previous trace kind would add one line per tick.
await new Promise((resolve) => setTimeout(resolve, TICK_MS * 2 + 2_000));
const afterTicks = linesMatching("status=idle").length;
assert.equal(afterTicks, 1, `three idle ticks must still be one line (got ${afterTicks})`);
const summaryAfter = linesMatching("pump: sessionId=session-trace").length;
assert.equal(summaryAfter, summaryAtFirst, `three idle ticks must not add queue-shape lines (was ${summaryAtFirst}, now ${summaryAfter})`);

// --- 2. a real transition is still recorded, and the queue is inspected ---------
idleAgent.status = "running";
await waitUntil("the running state", () => linesMatching("pump: sessionId=").length >= 1);
assert.equal(linesMatching(`skip ${unrouted.deliveryId} unrouted`).length, 1, "an unrouted delivery is reported once per change");
assert.equal(core.getDelivery(ROOT, unrouted.deliveryId).state, "queued", "an unrouted delivery is still never delivered");
assert.equal(core.listDeliveries(ROOT, "acked").length, 0, "and never acked");

// A second running tick must not repeat the queue summary or the unrouted line.
await new Promise((resolve) => setTimeout(resolve, TICK_MS + 2_000));
assert.equal(linesMatching(`skip ${unrouted.deliveryId} unrouted`).length, 1, "a steady queue is not re-reported every tick");
assert.equal(linesMatching("status=idle").length, 1, "a running agent writes no idle lines");

// --- 3. a new idle period records its own transition, then stops repeating ------
idleAgent.status = "idle";
await waitUntil("the second idle period", () => linesMatching("status=idle").length > 1);
assert.equal(linesMatching("status=idle").length, 2, "the second idle transition is recorded once");

// --- 3. dispose records one line ------------------------------------------------
mock.dispose();
assert.equal(linesMatching("dispose: root=").length, 1, "stopping the watcher records exactly one line");

const total = traceLines().length;
assert.ok(total <= 8, `a full mount/steady/transition/dispose cycle stays small (got ${total} lines):\n${traceLines().join("\n")}`);

// --- the policy, stated as an assertion -----------------------------------------
const idleLines = linesMatching("status=idle").length;
const ticksObserved = 5;
assert.ok(idleLines < ticksObserved, `idle lines (${idleLines}) must be fewer than the ticks observed (${ticksObserved})`);

rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
console.log("trace-policy.test.mjs: all assertions passed");
