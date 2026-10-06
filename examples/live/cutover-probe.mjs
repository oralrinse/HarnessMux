#!/usr/bin/env node
/**
 * P0.5 cutover acceptance probe (live, timeline-correct).
 *
 * The v2 pump deliberately delivers only to a **running** agent, so every
 * delivery under test must be queued while the target session is mid-turn. An
 * earlier version of this probe queued deliveries while every session sat idle
 * and observed nothing — correctly, because the pump skips idle agents.
 *
 * Coverage:
 *   V4-1  provider-facing tool contract + a real model tool call
 *   V4-2  bound delivery: claim → steer → ack, exactly once
 *   V4-6  only the bound session receives it (no cross-session leakage)
 *   V4-5  an unrouted delivery is consumed by nobody and stays awaitingBinding
 *   V1    recorded observation about idle delivery (see the report)
 *
 * Usage: node tests/cutover-probe.mjs [timeoutMs]
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import * as core from "../../packages/core/core-v2.mjs";
import { BRIDGE_ROOT, CWD, DSH, requireDsh } from "./env.mjs";

const TIMEOUT_MS = Number(process.argv[2] ?? 240_000);

const ROOT = BRIDGE_ROOT;
const ENDPOINT = "dsh-endpoint";
const REPORT = [];

/** Record one acceptance result. */
function record(test, pass, evidence, conclusion) {
	REPORT.push({ test, result: pass === null ? "OBSERVED" : pass ? "PASS" : "FAIL", evidence, conclusion });
}

// --- disk observer -----------------------------------------------------------
const observed = [];
const observer = setInterval(() => {
	try {
		observed.push({
			at: new Date().toISOString(),
			queued: core.listDeliveries(ROOT, "queued").length,
			claimed: core.listDeliveries(ROOT, "claimed").length,
			acked: core.listDeliveries(ROOT, "acked").length
		});
	} catch {
		// A sample racing a write is fine; the next one covers it.
	}
}, 250);

// --- ACP client --------------------------------------------------------------
requireDsh();
const COMSPEC = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
const child = spawn(COMSPEC, ["/d", "/s", "/c", "%DSH_ACP_CMD% --profile acp"], {
	cwd: CWD,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, DSH_ACP_CMD: `"${DSH}"`, HARNESSMUX_DIR: ROOT }
});

let nextId = 1;
const pending = new Map();
const toolCalls = [];
const turns = [];
const stderrLines = [];
let buffer = "";
let currentText = "";

/** Send one request. */
function request(method, params, timeoutMs = TIMEOUT_MS) {
	const id = nextId++;
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject, method });
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`${method} timed out`));
			}
		}, timeoutMs);
	});
}

child.stdin.on("error", (error) => stderrLines.push(`stdin error: ${String(error?.code ?? error)}`));
child.stderr.on("data", (chunk) => {
	const text = chunk.toString("utf8").trim();
	if (text) stderrLines.push(text.slice(0, 300));
});

child.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (!line) continue;
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			continue;
		}
		if (frame.id !== undefined && frame.method === undefined) {
			const waiter = pending.get(frame.id);
			if (waiter) {
				pending.delete(frame.id);
				if (frame.error) waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(frame.error)}`));
				else waiter.resolve(frame.result);
			}
			continue;
		}
		if (frame.method !== undefined && frame.id !== undefined) {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } })}\n`);
			continue;
		}
		const update = frame.params?.update ?? frame.params;
		const kind = update?.sessionUpdate ?? "?";
		if (kind === "tool_call" || kind === "tool_call_update") {
			const entry = `${kind} ${update.title ?? update.toolCall?.title ?? ""} ${update.status ?? update.toolCall?.status ?? ""}`.trim();
			if (!toolCalls.includes(entry)) toolCalls.push(entry);
		} else if (kind === "agent_message_chunk") {
			currentText += update.content?.text ?? "";
		}
	}
});

/** Wait for a predicate. */
async function waitUntil(predicate, timeoutMs) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

const FINISH_TEXT = "SESSION-QUIET-OK";

try {
	await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
	const sessionA = await request("session/new", { cwd: CWD, mcpServers: [] });
	const sessionB = await request("session/new", { cwd: CWD, mcpServers: [] });
	const A = sessionA.sessionId;
	const B = sessionB.sessionId;
	record("setup: two real sessions", true, `A=${A} B=${B}`, "independent live sessions for the routing tests");

	// --- V4-1: the tool reaches the model and is callable ---------------------
	currentText = "";
	await request("session/prompt", { sessionId: A, prompt: [{ type: "text", text: "Use the mailbox tool with action=status, then answer with exactly MAILBOX_OK and nothing else." }] });
	const mailboxCall = toolCalls.find((call) => call.includes("mailbox"));
	record(
		"V4-1 provider-facing contract + real call",
		Boolean(mailboxCall) && currentText.includes("MAILBOX_OK"),
		`tool calls: ${toolCalls.join(" | ") || "(none)"}; answer: ${currentText.slice(0, 80)}`,
		mailboxCall ? "the compiled descriptor was accepted by the provider and the model invoked the tool" : "the tool never reached the model"
	);
	turns.push({ session: "A", text: currentText });

	// --- V4-5: unrouted delivery, with both sessions idle ---------------------
	const unrouted = core.postMessage(ROOT, { from: "codex", topic: "unrouted probe", body: "UNROUTED-MARKER: nobody may consume me" });
	const unroutedDelivery = core.enqueueDelivery(ROOT, { messageId: unrouted.messageId, target: null });
	await new Promise((resolve) => setTimeout(resolve, 11_000));
	const unroutedState = core.getDelivery(ROOT, unroutedDelivery.deliveryId);
	const reportAfterUnrouted = core.verifyInvariants(ROOT);
	record(
		"V4-5 unbound delivery is never consumed",
		unroutedState.state === "queued" && unroutedState.attempt === 0 && reportAfterUnrouted.ok && reportAfterUnrouted.awaitingBinding.includes(unroutedDelivery.deliveryId),
		`state=${unroutedState.state} attempt=${unroutedState.attempt} awaitingBinding=${JSON.stringify(reportAfterUnrouted.awaitingBinding)} violations=${JSON.stringify(reportAfterUnrouted.violations)}`,
		"neither session claimed it while both were idle; it is awaitingBinding, not a violation"
	);

	// --- V4-2 / V4-6: bind to A, then queue while A is running ----------------
	core.bindThread(ROOT, { threadId: unrouted.threadId, endpointId: ENDPOINT, sessionId: A, mode: "delegated" });
	const marker = "ACCEPTANCE-MARKER-4417";
	const bound = core.postMessage(ROOT, { from: "codex", topic: "bound probe", threadId: unrouted.threadId, body: `${marker}: report this marker verbatim, then answer ${FINISH_TEXT}.` });
	const boundDelivery = core.enqueueDelivery(ROOT, { messageId: bound.messageId });

	// The pump ticks every 10s and only delivers to a *running* agent, so a
	// delivery is opportunistic: it lands in the first turn that is still running
	// at a tick. A real deployment lives with that (L1); the probe therefore gives
	// it a few turns instead of assuming one, and records every transition.
	const transitions = [];
	let polling = true;
	const poller = setInterval(() => {
		const current = core.getDelivery(ROOT, boundDelivery.deliveryId);
		const last = transitions.at(-1);
		if (!last || last.state !== current.state || last.attempt !== current.attempt) {
			transitions.push({ at: new Date().toISOString(), state: current.state, attempt: current.attempt, owner: current.claimOwner ?? null });
		}
	}, 250);

	let attempts = 0;
	currentText = "";
	while (attempts < 3 && !transitions.some((entry) => entry.state === "acked")) {
		attempts += 1;
		await request("session/prompt", {
			sessionId: A,
			prompt: [{
				type: "text",
				text: `Use the mailbox tool with action=status, then list every file in the current directory in one command, then answer turn-${attempts} done ${FINISH_TEXT}.`
			}]
		});
		// A turn that ran long enough to overlap a pump tick will have been claimed.
		if (transitions.some((entry) => entry.state === "acked")) break;
	}
	polling = false;
	clearInterval(poller);
	void polling;
	const boundState = core.getDelivery(ROOT, boundDelivery.deliveryId);
	record(
		"V4-6 bound delivery routes to session A only",
		boundState.state === "acked" && boundState.attempt === 1,
		`state=${boundState.state} attempt=${boundState.attempt} turns=${attempts} transitions=${JSON.stringify(transitions)} expectedOwner=${ENDPOINT}:${A}`,
		boundState.state === "acked"
			? "the binding routed it; it was claimed once and acked once"
			: "the bound delivery was not consumed within three turns (tick/duration race — see limitation L1)"
	);
	turns.push({ session: "A", text: currentText });

	// Ask each session what it holds; only A may know the marker.
	currentText = "";
	await request("session/prompt", { sessionId: A, prompt: [{ type: "text", text: `Quote verbatim any peer-agent message you received. Answer exactly ${FINISH_TEXT} if none.` }] });
	const aSaw = currentText.includes(marker);
	turns.push({ session: "A-final", text: currentText });
	currentText = "";
	await request("session/prompt", { sessionId: B, prompt: [{ type: "text", text: `Quote verbatim any peer-agent message you received. Answer exactly ${FINISH_TEXT} if none.` }] });
	const bSaw = currentText.includes(marker);
	turns.push({ session: "B-final", text: currentText });
	record(
		"V4-6b no cross-session contamination",
		aSaw && !bSaw,
		`sessionA saw the marker=${aSaw}; sessionB saw the marker=${bSaw}`,
		aSaw && !bSaw ? "only the bound session received the peer message" : (bSaw ? "routing leaked into the unbound session" : "the bound session did not receive it")
	);

	// --- V4-2 accounting -----------------------------------------------------
	// The thread accumulates messages across probe runs, so the invariant that
	// matters is about *this* delivery's message: exactly one copy, exactly one
	// ack, nothing left queued or claimed. Asserting a fixed thread size made the
	// check fail purely because earlier runs had used the same thread.
	const ackedAll = core.listDeliveries(ROOT, "acked").filter((entry) => entry.deliveryId === boundDelivery.deliveryId);
	const leftQueued = core.listDeliveries(ROOT, "queued").filter((entry) => entry.deliveryId === boundDelivery.deliveryId);
	const leftClaimed = core.listDeliveries(ROOT, "claimed").filter((entry) => entry.deliveryId === boundDelivery.deliveryId);
	const copiesOfThisMessage = core.listMessages(ROOT).filter((message) => message.messageId === bound.messageId);
	const messagesInThread = core.listMessages(ROOT).filter((message) => message.threadId === bound.threadId);
	record(
		"V4-2 lifecycle accounting",
		ackedAll.length === 1 && leftQueued.length === 0 && leftClaimed.length === 0 && copiesOfThisMessage.length === 1,
		`acks=${ackedAll.length} queuedLeft=${leftQueued.length} claimedLeft=${leftClaimed.length} copiesOfMessage=${copiesOfThisMessage.length} messagesInThread=${messagesInThread.length} attempt=${boundState.attempt} ackRecord=${JSON.stringify(ackedAll[0] ?? null)}`,
		"claim → steer → ack happened exactly once; the immutable message exists exactly once"
	);

	// --- V1: what the transport does with idle sessions -----------------------
	const idleMessage = core.postMessage(ROOT, { from: "codex", topic: "idle probe", threadId: unrouted.threadId, body: "IDLE-PROBE-9902" });
	const idleDelivery = core.enqueueDelivery(ROOT, { messageId: idleMessage.messageId });
	const idleBefore = core.getDelivery(ROOT, idleDelivery.deliveryId);
	await new Promise((resolve) => setTimeout(resolve, 12_000));
	const idleAfter = core.getDelivery(ROOT, idleDelivery.deliveryId);
	record(
		"V1 idle-session delivery semantics",
		null,
		`queued while idle: stateBefore=${idleBefore.state} stateAfter12s=${idleAfter.state} attempt=${idleAfter.attempt}`,
		idleAfter.state === "queued"
			? "OBSERVED: with no running session the delivery stays queued; the pump only delivers to a running agent (no idle wake)"
			: "OBSERVED: the delivery was consumed while the session was idle"
	);

	const final = core.verifyInvariants(ROOT);
	record(
		"invariants after all probes",
		final.ok,
		`ok=${final.ok} pending=${final.pending} claimed=${final.claimed} acked=${final.acked} awaitingBinding=${JSON.stringify(final.awaitingBinding)} violations=${JSON.stringify(final.violations)}`,
		final.ok ? "every un-acked delivery sits in exactly one state" : "invariant violation"
	);
} catch (error) {
	record("probe", false, String(error?.message ?? error), "the probe aborted");
} finally {
	clearInterval(observer);
	try {
		child.kill();
	} catch {
		// already gone
	}
}

console.log("\n===== P0.5 CUTOVER PROBE REPORT =====");
for (const row of REPORT) {
	console.log(`\n[${row.result}] ${row.test}`);
	console.log(`  evidence: ${row.evidence}`);
	console.log(`  conclusion: ${row.conclusion}`);
}
console.log("\n----- delivery-state samples (disk) -----");
for (const sample of observed.filter((_, index) => index % 12 === 0)) {
	console.log(`${sample.at} queued=${sample.queued} claimed=${sample.claimed} acked=${sample.acked}`);
}
console.log("\n----- assistant turns -----");
for (const turn of turns) console.log(`[${turn.session}] ${turn.text.slice(0, 220).replace(/\s+/gu, " ")}`);
console.log("\n----- harness stderr -----");
console.log(stderrLines.length ? stderrLines.slice(0, 10).join("\n") : "(clean)");
const failures = REPORT.filter((row) => row.result === "FAIL");
console.log(`\nfailures: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
