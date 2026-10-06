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
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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

/** How a non-interactive Claude refuses when it has no usable credential. */
const AUTH_REFUSAL = /not logged in|please run \/login|failed to authenticate|invalid api key|authentication fails/iu;

/**
 * Check that a headless Claude can reach a model at all, before judging anything.
 *
 * Without this the script ran every remaining step against an empty response and reported
 * the absence of output as failures of the adapter — which is what happened on the first two
 * attempts, and it cost a full round trip each time. A run that cannot reach a model is one
 * configuration problem; it must be said once, plainly, instead of being distributed across
 * six verdicts.
 */
function requireUsableClaude() {
	const probe = claude("Reply with exactly: READY", 120_000);
	const lines = probe.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	if (AUTH_REFUSAL.test(probe.output)) {
		say("FATAL: a non-interactive `claude` cannot authenticate on this machine.");
		say("");
		say("       Claude Code here is pointed at a third-party endpoint:");
		say(`         ANTHROPIC_BASE_URL = ${process.env.ANTHROPIC_BASE_URL ?? "(unset)"}`);
		say(`         ANTHROPIC_MODEL    = ${process.env.ANTHROPIC_MODEL ?? "(unset)"}`);
		say("       so it needs a credential for that endpoint. Its own message:");
		say("");
		for (const line of lines.slice(0, 6)) say(`         ${line}`);
		say("");
		say("       Provide one for this command only — this script never reads or copies it:");
		say("         $env:ANTHROPIC_API_KEY = \"<your key>\"; node examples/live/claude-acceptance.mjs");
		process.exit(3);
	}
	if (!probe.ok) {
		say("FATAL: `claude -p` did not complete. Its output:");
		say("");
		for (const line of lines.slice(0, 10)) say(`         ${line}`);
		process.exit(3);
	}
	say(`claude -p        : usable (${Math.round(probe.ms / 1000)}s for a one-word reply)`);
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

/**
 * The session to deliver to, chosen from evidence rather than from list order.
 *
 * A published endpoint can carry sessions that are no longer running: the first
 * acceptance run picked `sessions[0]` and addressed a session that had been gone for 50
 * minutes, so its delivery sat queued forever and D3 was reported as a failure of the
 * adapter when it was a failure of target selection. A delivery to a dead session is
 * indistinguishable from a delivery to an idle one, so the script refuses to guess:
 *
 *   - `--target-session <id>` states it outright (use the session you are looking at);
 *   - otherwise every candidate must be confirmed by the harness publishing it *now*.
 *
 * "Now" is judged from the endpoint file's own modification time: the receiver rewrites
 * it whenever its live session set changes, so a file untouched for a long time means no
 * session is actually live, whatever the stored list says.
 */
function pickTargetSession(endpoint) {
	const explicit = process.argv.find((arg) => arg.startsWith("--target-session="))?.split("=")[1]
		?? (process.argv.includes("--target-session") ? process.argv[process.argv.indexOf("--target-session") + 1] : null);
	if (explicit) return { session: explicit, how: "stated with --target-session" };
	return { session: endpoint?.sessions?.[0] ?? null, how: "first published session" };
}

/**
 * The receiver endpoint to deliver to.
 *
 * Prefer the harness's own endpoint and never the decoy this script registers for the
 * isolation check: an earlier run picked the first endpoint whose actor matched, which was
 * the decoy left behind by a previous run, and then refused to start because the "published
 * session" it had chosen was the decoy's fake one.
 */
const endpoints = core.listEndpoints(bridge).filter((entry) => entry.actor === PEER);
const endpoint = endpoints.find((entry) => entry.endpointId === "dsh-endpoint")
	?? endpoints.find((entry) => !entry.endpointId.startsWith("dsh-decoy"))
	?? null;
const published = endpoint?.sessions ?? [];
if (published.length === 0) {
	say("FATAL: no DeepSeek Harness session is published at all.");
	say(`       endpoints seen: ${JSON.stringify(endpoints.map((entry) => ({ id: entry.endpointId, sessions: entry.sessions })))}`);
	say("       Open a DSH session and keep it running, then retry.");
	process.exit(1);
}

const endpointFile = join(bridge, "endpoints", `${endpoint.endpointId}.json`);
const endpointAgeMs = existsSync(endpointFile) ? Date.now() - statSync(endpointFile).mtimeMs : Number.POSITIVE_INFINITY;
const picked = pickTargetSession(endpoint);
const ageSeconds = Math.round(endpointAgeMs / 1000);
say(`published sessions : ${JSON.stringify(published)}`);
say(`endpoint refreshed : ${ageSeconds}s ago (${new Date(Date.now() - endpointAgeMs).toISOString()})`);

// A delivery is only attempted into a *running* session, so a stale publication means the
// target cannot be confirmed and the run would produce a meaningless D3.
if (picked.how !== "stated with --target-session" && endpointAgeMs > 120_000) {
	say("");
	say(`FATAL: the harness has not republished its live sessions for ${ageSeconds}s, so none of the`);
	say("       published sessions can be confirmed as running, and a delivery to a stopped");
	say("       session would wait forever — that is the documented idle boundary, not a bug.");
	say("");
	say("       Fix: keep a DSH session running (send it a message so it is mid-turn), or state");
	say("       the target explicitly, e.g.");
	say("         node examples/live/claude-acceptance.mjs --target-session <sessionId>");
	process.exit(2);
}

const targetSession = picked.session;
// Prove a model is reachable before spending six steps on it.
requireUsableClaude();
// The DSH session that must NOT receive anything: any other published session, else a fake
// endpoint registered for this run so the isolation check still has a second target.
let decoySession = published.find((id) => id !== targetSession) ?? "decoy-session-not-live";
if (!published.some((id) => id !== targetSession)) {
	core.registerEndpoint(bridge, { actor: PEER, endpointId: "dsh-decoy-endpoint", sessions: [decoySession] });
}
record("setup", true, `plugin at ${pluginPath}; published=${JSON.stringify(published)}; target=${targetSession} (${picked.how}); endpoint refreshed ${ageSeconds}s ago`, "the adapter can be exercised against a target chosen from evidence");

// --- D1/D2: Claude sees and calls the shared MCP server -------------------------
// `claude -p` prints only the model's final text — it does not echo which tools ran. So the
// only sound evidence is data that *only the tool could have supplied*: the live session id
// for D1, and the status payload for D2. An earlier version looked for the tool's name in the
// output and reported a failure while the captured payload proved the call had happened.
const sessionsRun = claude(
	"Call the harnessmux MCP tool `list_sessions` and print only the tool's returned text, verbatim. Do not explain and do not use any other tool."
);
const sessionsText = sessionsRun.output;
const sawLiveSession = sessionsText.includes(targetSession);
record(
	"D1 Claude lists the HarnessMux MCP tools",
	sawLiveSession,
	`list_sessions returned the live session id ${targetSession}: ${sawLiveSession}${sawLiveSession ? "" : ` (output: ${sessionsText.slice(0, 300).replace(/\s+/gu, " ")})`}`,
	"the tool answered with data only the shared bridge knows, so Claude both discovered and reached it"
);

const statusRun = claude(
	"Call the harnessmux MCP tool `get_status` and print only the tool's returned text, verbatim. Do not explain and do not use any other tool."
);
const statusText = statusRun.output;
const sawServerOutput = /"invariantsOk"\s*:\s*true/u.test(statusText) || /"version"\s*:\s*2/u.test(statusText) || /protocol:\s*v2/iu.test(statusText);
record(
	"D2 Claude calls the shared MCP server",
	sawServerOutput,
	`get_status returned the shared server's own payload: ${sawServerOutput}${sawServerOutput ? "" : ` (tail: ${statusText.slice(-300).replace(/\s+/gu, " ")})`}`,
	"the reply is the shared server's structured output, not a legacy path"
);
writeFileSync(join(OUT, "d1-list-sessions.txt"), sessionsText, "utf8");
writeFileSync(join(OUT, "d2-get-status.txt"), statusText, "utf8");

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
