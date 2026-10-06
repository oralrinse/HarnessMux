#!/usr/bin/env node
/**
 * Ask a live session to deliver one v2 message — the "how do I test this" tool.
 *
 * Posts a marked message, binds its thread to a specific endpoint/session, and
 * queues it. The target harness's plugin pump then does the real work (claim →
 * steer → ack); this script only watches the bridge and reports the timeline.
 *
 * A delivery lands in the first turn of the target session that is still running
 * when the pump ticks (every 10s), so **send a message into that session while
 * this runs** — otherwise the delivery correctly waits in `queue/`.
 *
 * Usage:
 *   node tests/ask-session.mjs <sessionId> [--endpoint dsh-endpoint] [--marker TEXT]
 *   node tests/ask-session.mjs --list          # show live sessions the plugin published
 *
 * Exit codes: 0 delivered, 3 still queued when the wait expired (not an error —
 * it means the session never ran), 1 usage/setup error.
 */

import * as core from "../lib/core-v2.mjs";

// Same resolution chain as the CLI: explicit env, then the remembered root.
const ROOT = core.resolveBridgeRoot(process.env.AGENT_BRIDGE_DIR ?? undefined);
const args = process.argv.slice(2);

if (args.includes("--list")) {
	const endpoints = core.listEndpoints(ROOT);
	console.log(`bridge: ${ROOT}`);
	for (const endpoint of endpoints) {
		console.log(`endpoint ${endpoint.endpointId} (actor=${endpoint.actor}, transport=${endpoint.transport})`);
		console.log(`  live sessions: ${endpoint.sessions.length ? endpoint.sessions.join(", ") : "(none published — the plugin republishes on its next tick while a session is running)"}`);
	}
	console.log("\nbindings:");
	for (const binding of core.listBindings(ROOT)) {
		console.log(`  ${binding.threadId} -> ${binding.endpointId}${binding.sessionId ? `#${binding.sessionId}` : ""} mode=${binding.mode}`);
	}
	console.log("\npending deliveries:");
	for (const delivery of core.listDeliveries(ROOT, "queued")) {
		const target = delivery.target ? `${delivery.target.endpointId}#${delivery.target.sessionId ?? "-"}` : "UNROUTED (awaiting binding)";
		console.log(`  ${delivery.deliveryId} -> ${target} mode=${delivery.mode} attempt=${delivery.attempt}`);
	}
	process.exit(0);
}

const sessionId = args.find((arg) => !arg.startsWith("--"));
if (!sessionId) {
	console.error("usage: node tests/ask-session.mjs <sessionId> [--endpoint dsh-endpoint] [--marker TEXT] [--wait-ms N]");
	process.exit(1);
}
/** Read `--flag value` from argv. */
function option(name, fallback) {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const endpointId = option("endpoint", "dsh-endpoint");
const marker = option("marker", `ASK-${Date.now().toString(36).toUpperCase()}`);
const waitMs = Number(option("wait-ms", "120000"));

if (!core.isBridgeRoot(ROOT)) {
	console.error(`no v2 bridge at ${ROOT}`);
	process.exit(1);
}

const message = core.postMessage(ROOT, {
	from: "codex",
	topic: "ask a live session",
	body: `${marker}: a peer agent is asking this session to prove the v2 mailbox reached it. When you see this, call the mailbox tool with action=status and answer with the marker.`
});
core.bindThread(ROOT, { threadId: message.threadId, endpointId, sessionId, mode: "delegated" });
const delivery = core.enqueueDelivery(ROOT, { messageId: message.messageId });

console.log(`bridge:    ${ROOT}`);
console.log(`message:   ${message.messageId}`);
console.log(`thread:    ${message.threadId}`);
console.log(`delivery:  ${delivery.deliveryId}`);
console.log(`target:    ${endpointId}#${sessionId} (delegated)`);
console.log(`marker:    ${marker}`);
console.log(`\nwatching for up to ${Math.round(waitMs / 1000)}s. Send a message into that session so a turn is`);
console.log("running when the pump ticks, otherwise the delivery correctly waits in queue/.\n");

const started = Date.now();
let last = null;
let settled = null;
while (Date.now() - started < waitMs) {
	const current = core.getDelivery(ROOT, delivery.deliveryId);
	const stamp = `${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s`;
	if (!last || last.state !== current.state || last.attempt !== current.attempt) {
		console.log(`${stamp}  state=${current.state} attempt=${current.attempt}${current.claimOwner ? ` owner=${current.claimOwner}` : ""}`);
		last = current;
	}
	if (current.state === "acked") {
		settled = current;
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 250));
}

if (settled) {
	const ack = core.listDeliveries(ROOT, "acked").find((entry) => entry.deliveryId === delivery.deliveryId);
	console.log(`\nDELIVERED: the session accepted the hand-off after ${settled.attempt} attempt(s).`);
	console.log(`ack: ${JSON.stringify({ deliveryId: ack.deliveryId, messageId: ack.messageId, sessionId: ack.target.sessionId, mode: ack.mode, ackedAt: ack.ackedAt })}`);
	console.log(`\nThe session should now contain marker ${marker}. Ask it: "quote the marker you just received".`);
	process.exit(0);
}

console.log(`\nSTILL QUEUED after ${Math.round(waitMs / 1000)}s — the target session never ran, so the pump`);
console.log("correctly never delivered. Start a turn in that session and re-run, or bind another session.");
process.exit(3);
