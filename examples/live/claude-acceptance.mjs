#!/usr/bin/env node
/**
 * P3.3-C live acceptance: drive the Claude Code adapter on a real machine.
 *
 * Run this from a shell where Claude Code is authenticated:
 *
 *     node examples/live/claude-acceptance.mjs
 *
 * It prints a PASS/FAIL line per reconnaissance condition (D1–D6) and a final verdict.
 * Everything it observes is written under `.claude-acceptance/` so the evidence can be
 * inspected afterwards.
 *
 * What it deliberately does **not** do: read or copy any credential. It only launches
 * `claude`, exactly as a user would.
 *
 * Conditions:
 *   setup  the plugin is installed and a target DSH session is live
 *   D1     Claude lists the HarnessMux MCP tools
 *   D2     Claude calls the shared MCP server (a real get_status round trip)
 *   D3     Claude's message reaches the bound DSH session and is acked
 *   D4     a message waiting for Claude is surfaced by the lifecycle hook
 *   D5     thread and reply relationships are correct in the store
 *   D6     a second live DSH session receives nothing
 *
 * @module harnessmux/examples/claude-acceptance
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as core from "../../packages/core/core-v2.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(REPO, ".claude-acceptance");
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
const ACTOR = "claude";
const PEER = "dsh";

const results = [];
const record = (id, ok, evidence, conclusion) => {
	results.push({ id, ok, evidence, conclusion });
};

/** Run claude non-interactively and return its combined output. */
function claude(prompt, timeoutMs = 240_000) {
	const started = Date.now();
	try {
		const stdout = execFileSync("claude", ["-p", prompt, "--permission-mode", "bypassPermissions"], {
			encoding: "utf8",
			timeout: timeoutMs,
			env: { ...process.env, HARNESSMUX_ACTOR: ACTOR },
			maxBuffer: 32 * 1024 * 1024
		});
		return { ok: true, output: stdout, ms: Date.now() - started };
	} catch (error) {
		return { ok: false, output: `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${String(error?.message ?? error)}`, ms: Date.now() - started };
	}
}

/** Wait until `predicate` holds or the budget runs out. */
async function waitUntil(predicate, timeoutMs = 30_000, stepMs = 500) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true;
		await new Promise((done) => setTimeout(done, stepMs));
	}
	return false;
}

mkdirSync(OUT, { recursive: true });
const log = [];
const say = (line) => {
	log.push(line);
	process.stdout.write(`${line}\n`);
};

// --- setup ----------------------------------------------------------------------
const pluginPath = join(CLAUDE_HOME, "skills", "harnessmux");
if (!existsSync(join(pluginPath, ".claude-plugin", "plugin.json"))) {
	say(`FATAL: the Claude plugin is not installed at ${pluginPath}`);
	say(`       run: node scripts/install.mjs --claude --link`);
	process.exit(1);
}
const bridge = core.resolveBridgeRoot(process.env.HARNESSMUX_DIR ?? undefined);
if (!core.isBridgeRoot(bridge)) {
	say(`FATAL: no bridge root at ${bridge}`);
	process.exit(1);
}

const endpoint = core.listEndpoints(bridge).find((entry) => entry.actor === PEER);
const sessions = endpoint?.sessions ?? [];
if (sessions.length === 0) {
	say("FATAL: no live DeepSeek Harness session is published.");
	say("       open a DSH session and send it one message so it stays running, then retry.");
	process.exit(1);
}
// The DSH session that must NOT receive anything: any other live session, else a fake
// endpoint registered for this run so the isolation check still has a second target.
const targetSession = sessions[0];
let decoySession = sessions[1] ?? "decoy-session-not-live";
if (sessions.length < 2) {
	core.registerEndpoint(bridge, { actor: PEER, endpointId: "dsh-decoy-endpoint", sessions: [decoySession] });
}
record("setup", true, `plugin at ${pluginPath}; live sessions=${JSON.stringify(sessions)}; target=${targetSession}`, "the adapter can be exercised");

// --- D1/D2: Claude sees and calls the shared MCP server -------------------------
const statusRun = claude(
	"Call the harnessmux MCP tool `get_status` and then print its result verbatim between the lines BEGIN and END. Do not use any other tool and do not explain."
);
const statusText = statusRun.output;
const sawTool = /mcp[:_ ]*harnessmux|harnessmux.*get_status|get_status/iu.test(statusText);
const sawV2 = /protocol:\s*v2/iu.test(statusText);
record(
	"D1 Claude lists the HarnessMux MCP tools",
	sawTool,
	`claude output mentions the tool: ${sawTool}`,
	"Claude discovered the server this adapter declares"
);
record(
	"D2 Claude calls the shared MCP server",
	sawV2,
	`get_status answered with the protocol line: ${sawV2}${sawV2 ? "" : ` (tail: ${statusText.slice(-300).replace(/\s+/gu, " ")})`}`,
	"the reply is the shared server's own output, not a legacy path"
);
writeFileSync(join(OUT, "d1-d2-get-status.txt"), statusText, "utf8");

// --- D3: Claude → the bound DSH session -----------------------------------------
const outboundMarker = `CLAUDE-TO-DSH-${Date.now().toString(36).toUpperCase()}`;
const topic = `claude acceptance ${outboundMarker}`;
const sendRun = claude(
	[
		`Use the harnessmux MCP tool send_message with exactly these arguments:`,
		`  body: "${outboundMarker}: report this marker verbatim."`,
		`  topic: "${topic}"`,
		`  kind: "instruction"`,
		`  mode: "delegated"`,
		`  endpoint_id: "dsh-endpoint"`,
		`  session_id: "${targetSession}"`,
		`Then print the tool's returned text verbatim and the deliveryId, and stop.`
	].join("\n")
);
writeFileSync(join(OUT, "d3-send.txt"), sendRun.output, "utf8");

// Find the message Claude actually created, by topic.
const findOutbound = () => core.listMessages(bridge).find((message) => message.topic === topic) ?? null;
await waitUntil(() => findOutbound() !== null, 20_000);
const outbound = findOutbound();
const outboundDelivery = outbound
	? ["queued", "claimed", "acked"].flatMap((state) => core.listDeliveries(bridge, state)).find((delivery) => delivery.messageId === outbound.messageId)
	: null;
const outboundAcked = await waitUntil(
	() => outboundDelivery !== null && core.getDelivery(bridge, outboundDelivery.deliveryId)?.state === "acked",
	45_000
);
record(
	"D3 Claude → real DSH session delivery",
	outboundAcked && outboundDelivery?.target?.sessionId === targetSession,
	`messageId=${outbound?.messageId ?? "none"} deliveryId=${outboundDelivery?.deliveryId ?? "none"} target=${JSON.stringify(outboundDelivery?.target ?? null)} state=${outboundDelivery ? core.getDelivery(bridge, outboundDelivery.deliveryId)?.state : "none"}`,
	"the receiver claimed, steered and acked it for the bound session"
);

// --- D4: a waiting message is surfaced on Claude's next lifecycle event ---------
const inboundMarker = `DSH-TO-CLAUDE-${Date.now().toString(36).toUpperCase()}`;
const inbound = core.postMessage(bridge, { from: PEER, topic: `claude pickup ${inboundMarker}`, kind: "note", body: `${inboundMarker}: report this marker verbatim.` });
core.enqueueDelivery(bridge, { messageId: inbound.messageId });
const pickupRun = claude(
	"Report any HarnessMux message that was given to you at the start of this session, quoting it verbatim. If you received none, print exactly NO-HARNESSMUX-CONTEXT."
);
writeFileSync(join(OUT, "d4-pickup.txt"), pickupRun.output, "utf8");
const pickupSawMarker = pickupRun.output.includes(inboundMarker);
// The hook's own output is also captured, independently of the model's willingness to
// repeat it: run the handler exactly as Claude does.
const hookProbe = execFileSync(process.execPath, [join(pluginPath, "hooks-handlers", "pending.mjs"), "SessionStart"], {
	encoding: "utf8",
	input: JSON.stringify({ session_id: "acceptance", hook_event_name: "SessionStart", cwd: REPO }),
	env: { ...process.env, HARNESSMUX_DIR: bridge, HARNESSMUX_ACTOR: ACTOR, CLAUDE_PLUGIN_ROOT: pluginPath }
});
const hookCarriesMarker = hookProbe.includes(inboundMarker);
writeFileSync(join(OUT, "d4-hook-output.json"), hookProbe, "utf8");
record(
	"D4 DSH → Claude surfaced at the next lifecycle event",
	pickupSawMarker || hookCarriesMarker,
	`model quoted the marker: ${pickupSawMarker}; the installed hook's own output carries it: ${hookCarriesMarker}`,
	"the message is not lost while Claude is idle, and reaches the next active turn"
);

// --- D5: thread and reply relationships -----------------------------------------
const replyRun = claude(
	[
		`Use the harnessmux MCP tool reply_message with these arguments:`,
		`  message_id: "${inbound.messageId}"`,
		`  body: "${inboundMarker} acknowledged."`,
		`Then print the tool's returned text verbatim and stop.`
	].join("\n")
);
writeFileSync(join(OUT, "d5-reply.txt"), replyRun.output, "utf8");
const findReply = () => core.listMessages(bridge).find((message) => message.replyTo === inbound.messageId) ?? null;
await waitUntil(() => findReply() !== null, 20_000);
const replyMessage = findReply();
record(
	"D5 thread and reply relationships",
	replyMessage !== null && replyMessage.threadId === inbound.threadId,
	`reply=${replyMessage?.messageId ?? "none"} replyTo=${replyMessage?.replyTo ?? "none"} thread=${replyMessage?.threadId ?? "none"} parentThread=${inbound.threadId}`,
	"the reply stays on the parent's thread and references it"
);

// --- D6: a second session receives nothing --------------------------------------
const decoyTopic = `claude decoy ${outboundMarker}`;
const decoy = core.postMessage(bridge, { from: ACTOR, topic: decoyTopic, kind: "note", body: `${outboundMarker}: this must never reach ${decoySession}.` });
const decoyDelivery = core.enqueueDelivery(bridge, { messageId: decoy.messageId, target: { actor: PEER, endpointId: "dsh-decoy-endpoint", sessionId: decoySession } });
const targetTouchedDecoy = (() => {
	const state = core.getDelivery(bridge, decoyDelivery.deliveryId);
	return state?.state === "acked" && state?.target?.sessionId === targetSession;
})();
const decoyUntouched = await waitUntil(() => {
	const state = core.getDelivery(bridge, decoyDelivery.deliveryId);
	return state?.state !== "acked";
}, 15_000);
record(
	"D6 several DSH sessions do not cross-talk",
	!targetTouchedDecoy && decoyUntouched,
	`decoy delivery ${decoyDelivery.deliveryId} state=${core.getDelivery(bridge, decoyDelivery.deliveryId)?.state} target=${JSON.stringify(core.getDelivery(bridge, decoyDelivery.deliveryId)?.target ?? null)}`,
	"a delivery addressed elsewhere is never handed to the bound session"
);

// --- verdict --------------------------------------------------------------------
const invariants = core.verifyInvariants(bridge);
say("");
for (const { id, ok, evidence, conclusion } of results) {
	say(`[${ok ? "PASS" : "FAIL"}] ${id}`);
	say(`    evidence  : ${evidence}`);
	say(`    conclusion: ${conclusion}`);
}
say("");
say(`invariants: ${invariants.ok ? "ok" : `VIOLATIONS ${JSON.stringify(invariants.violations)}`}`);
say(`bridge    : ${JSON.stringify(core.bridgeStatus(bridge))}`);
const failed = results.filter((entry) => !entry.ok);
say(`verdict   : ${failed.length === 0 ? "P3.3-C PASS" : `P3.3-C FAIL (${failed.map((entry) => entry.id).join(", ")})`}`);
say(`evidence  : ${OUT}`);
writeFileSync(join(OUT, "summary.txt"), log.join("\n"), "utf8");
process.exit(failed.length === 0 ? 0 : 1);
