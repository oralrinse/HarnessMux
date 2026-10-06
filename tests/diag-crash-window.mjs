#!/usr/bin/env node
/**
 * Isolated trace for the V4-4 crash window.
 *
 * Prints every state transition with a timestamp so the cause of an unexpected
 * "acked" or "queued" reading is evidence instead of a guess. Also enforces the
 * one-watcher-per-endpoint rule by disposing the previous mock before the next.
 *
 * Usage: node tests/diag-crash-window.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../lib/core-v2.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "ab-trace-"));
const ENDPOINT = "ep-trace";
const SESSION = "session-trace";
const SENTINEL = join(ROOT, "crash.sentinel");

core.ensureBridge(ROOT, { remember: false });
core.registerEndpoint(ROOT, { actor: "dsh", endpointId: ENDPOINT, transport: "in-process", sessions: [SESSION] });
const plugin = await import(pathToFileURL(join(import.meta.dirname, "..", "plugin", "index.js")).href);
const t0 = Date.now();
const log = (line) => console.log(`${String(Date.now() - t0).padStart(6)}ms  ${line}`);

/** A mock host agent. */
function mock(label, options = {}) {
	const steered = [];
	const effects = [];
	const agent = {
		id: `agent-${label}`,
		status: "running",
		session: { header: { id: SESSION, cwd: ROOT } },
		inject: () => {},
		steer: (message) => {
			steered.push(message);
			log(`[${label}] STEER: ${JSON.stringify(String(message?.content?.[0]?.text ?? message).slice(0, 60))}`);
		}
	};
	const ctx = {
		logger: { warn: (line) => log(`[${label}] warn: ${String(line).slice(0, 120)}`) },
		systemPrompt: { getSectionOrder: () => 5000, section: () => {} },
		tools: { register: () => {} },
		agents: { roots: () => [agent] },
		on: () => {},
		effect: (factory) => {
			const disposer = factory();
			if (typeof disposer === "function") effects.push(disposer);
		}
	};
	return {
		steered,
		label,
		mount: (extra = {}) => {
			log(`[${label}] mount`);
			plugin.apply(ctx, {
				bridgeRoot: ROOT,
				protocolVersion: "v2",
				actor: "dsh",
				peer: "codex",
				endpointId: ENDPOINT,
				leaseMs: 60_000,
				crashAfterSteerSentinel: SENTINEL,
				...extra
			});
		},
		dispose: () => {
			for (const disposer of effects.reverse()) disposer();
			effects.length = 0;
			log(`[${label}] disposed`);
		}
	};
}

const message = core.postMessage(ROOT, { from: "codex", topic: "trace", body: "TRACE-MARKER" });
core.bindThread(ROOT, { threadId: message.threadId, endpointId: ENDPOINT, sessionId: SESSION, mode: "delegated" });
const delivery = core.enqueueDelivery(ROOT, { messageId: message.messageId });
log(`queued delivery=${delivery.deliveryId}`);

// Sampling must survive mock disposal, so it lives outside any pump.
const sampler = setInterval(() => {
	const state = core.getDelivery(ROOT, delivery.deliveryId);
	const acked = core.listDeliveries(ROOT, "acked").length;
	const claimed = core.listDeliveries(ROOT, "claimed").map((entry) => entry.deliveryId);
	const owner = core.getDelivery(ROOT, delivery.deliveryId).claimOwner;
	log(`sample state=${state.state} attempt=${state.attempt} owner=${owner ?? "-"} ackedTotal=${acked} claimedIds=${JSON.stringify(claimed)}`);
}, 1_500);

// --- cycle 1: crash after steer ------------------------------------------------
writeFileSync(SENTINEL, "crash", "utf8");
const first = mock("cycle1");
first.mount();
await new Promise((resolve) => setTimeout(resolve, 12_000));
log(`cycle1 steers=${first.steered.length}`);
first.dispose();

// --- cycle 2: restart without the sentinel ------------------------------------
rmSync(SENTINEL, { force: true });
const second = mock("cycle2");
second.mount();
await new Promise((resolve) => setTimeout(resolve, 26_000));
log(`cycle2 steers=${second.steered.length}`);
const final = core.getDelivery(ROOT, delivery.deliveryId);
log(`FINAL state=${final.state} attempt=${final.attempt} owner=${final.claimOwner ?? "-"}`);
second.dispose();
clearInterval(sampler);
log(`invariants ok=${core.verifyInvariants(ROOT).ok}`);
rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
