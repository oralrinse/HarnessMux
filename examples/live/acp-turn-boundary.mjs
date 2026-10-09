/**
 * Live turn-boundary probe — a persistent-host (ACP) harness for Commander Mode.
 *
 * ## Why this exists, and why ACP
 *
 * The receiver's central question is "may this delegated delivery open a turn in an **idle**
 * session?". A one-shot `dsh --profile headless` run cannot answer it: measured in its own source,
 * `@deepseek-ai/dsh-headless` runs exactly one `followup(task)`, awaits `whenIdle()`, flushes and
 * calls `io.exit(...)`. Its idle window is the few milliseconds between `turn/end` and process exit —
 * shorter than one pump tick — so a delivery either lands in the still-running boot turn or in a dead
 * process. Every "the delivery was folded into the boot turn" observation was that artifact, not a
 * property of the receiver.
 *
 * `dsh --profile acp` is a long-lived host driven over stdio JSON-RPC. `session/new` creates a
 * session, `session/prompt` runs one turn and resolves when that turn ends, and the process then
 * stays alive and idle. That is the real shape of the product under test — an existing session in a
 * running host — and with an isolated `DSH_HOME` nothing the user owns is touched.
 *
 * ## Modes
 *
 *   --mode smoke      boot, create a session, run one prompt, settle, and dump the raw event chain.
 *                     This is the harness self-check: it proves `session.log`, `snapshotEvents()` and
 *                     the durable `seq`/`eventAt` range agree on a real host.
 *   --mode round      then N delegated deliveries, each sent only once the previous turn has closed,
 *                     so every one of them meets a *provably idle* session. Answers "does a delivery
 *                     to an idle session open its own turn, and is its answer captured?".
 *   --mode contended  deliver while a turn nobody delegated is open, and watch what the receiver does
 *                     with it. Answers "does the ownership gate hold when the session is busy?".
 *
 * ## What it needs, and what it leaves behind
 *
 * It runs a real model, so it needs the credentials in the user's own harness home. They are copied
 * into a temp scratch `DSH_HOME` (never into the repository) and deleted before the process exits.
 * Artifacts — the probe JSONL, the receiver's trace, the host's output and `summary.json` — stay in
 * `$TEMP/hxlab-<id>/` so a run can be re-read afterwards.
 *
 * ## Usage
 *
 *   node examples/live/acp-turn-boundary.mjs --mode smoke
 *   node examples/live/acp-turn-boundary.mjs --mode round --rounds 3
 *   node examples/live/acp-turn-boundary.mjs --mode contended --rounds 0
 *
 * `DSH_CLI` selects the launcher (see `env.mjs`); `HARNESSMUX_REPO` overrides the repository root,
 * which is otherwise taken from this file's own location.
 *
 * @module harnessmux/examples/live/acp-turn-boundary
 */

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDsh } from "./env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.env.HARNESSMUX_REPO?.trim() || join(HERE, "..", ".."));
const DSH = requireDsh();
const COMSPEC = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
/** The user's own harness home, which is where the credentials come from. */
const SOURCE_HOME = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");

/** cmd.exe needs native separators in a quoted command position. */
const NATIVE = (value) => value.replace(/\//g, "\\");
/** The bridge is configured with forward slashes, as the plugin row expects. */
const POSIX = (value) => value.replace(/\\/g, "/");
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/**
 * Read one CLI argument.
 *
 * @param {string} name - the flag without dashes.
 * @param {string} fallback - value when the flag is absent.
 * @returns {string} the value.
 */
function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

/** This run's scratch directories and artifact paths. */
function newLab() {
	const id = Math.random().toString(36).slice(2, 8);
	const base = join(tmpdir(), `hxlab-${id}`);
	const paths = {
		id,
		base,
		dshHome: join(base, "dshhome"),
		bridge: join(base, "bridge"),
		probe: join(base, "probe.jsonl"),
		receiverLog: join(base, "receiver-debug.log"),
		hostOut: join(base, "host.out.log"),
		hostErr: join(base, "host.err.log"),
		patch: join(base, "lab.patch.yml"),
		summary: join(base, "summary.json")
	};
	for (const dir of [base, paths.dshHome, paths.bridge]) mkdirSync(dir, { recursive: true });
	for (const name of [".credentials.yaml", ".anonymous-user-id"]) {
		const from = join(SOURCE_HOME, name);
		if (existsSync(from)) copyFileSync(from, join(paths.dshHome, name));
	}
	return paths;
}

/** Remove the copied credentials, whatever happened. */
function scrubCredentials(paths) {
	for (const name of [".credentials.yaml", ".anonymous-user-id"]) rmSync(join(paths.dshHome, name), { force: true });
}

/**
 * Run the mailbox CLI against one bridge and return its JSON.
 *
 * @param {object} paths - this run's paths.
 * @param {string[]} args - CLI arguments after `--root`.
 * @returns {object|null} the parsed JSON.
 */
function cli(paths, args) {
	const out = execFileSync(process.execPath, [join(REPO, "packages", "cli", "mailbox-v2.mjs"), "--root", paths.bridge, "--json", ...args], {
		encoding: "utf8",
		env: { ...process.env, DSH_HOME: paths.dshHome }
	});
	return out.trim() === "" ? null : JSON.parse(out);
}

/**
 * Materialize the isolated profile and write the receiver + instrument overlay.
 *
 * A dump-config pass is what creates `$DSH_HOME/profiles/<name>` from the shipped template, and it
 * also proves that template composes before anything is added to it.
 *
 * @param {object} paths - this run's paths.
 * @param {string} profile - the profile to boot.
 * @param {string[]} extraPatches - additional `--patch` files to apply.
 * @returns {string} the patch path.
 */
function wireProfile(paths, profile, extraPatches) {
	const profileDir = join(paths.dshHome, "profiles", profile);
	execFileSync(COMSPEC, ["/d", "/s", "/c", `%DSH_LAB_CMD% --profile ${profile} --dump-config`], {
		encoding: "utf8",
		env: { ...process.env, DSH_HOME: paths.dshHome, DSH_LAB_CMD: `"${NATIVE(DSH)}"` },
		stdio: ["ignore", "ignore", "pipe"]
	});
	if (!existsSync(profileDir)) throw new Error(`acp-turn-boundary: profile ${profile} was not initialized at ${profileDir}`);

	const localDir = join(profileDir, "node_modules", "@local");
	mkdirSync(localDir, { recursive: true });
	// Junctions, not copies: the profile must load the working tree under test, so an edit is visible
	// to the next boot with no reinstall, and the probe cannot drift from the repository copy.
	const links = [
		[join(localDir, "harnessmux"), join(REPO, "packages", "receiver-dsh")],
		[join(localDir, "hx-probe"), join(HERE, "turn-boundary-probe")]
	];
	for (const [link, target] of links) {
		if (existsSync(link)) rmSync(link, { recursive: true, force: true });
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(target, link, "junction");
		if (!existsSync(join(link, "index.js"))) throw new Error(`acp-turn-boundary: junction ${link} was not created`);
	}

	const patch = [
		"# Generated by examples/live/acp-turn-boundary.mjs — isolated receiver + instrument.",
		"- insert:",
		"    - id: harnessmux",
		"      name: '@local/harnessmux'",
		"      config:",
		`        bridgeRoot: '${POSIX(paths.bridge)}'`,
		"        actor: dsh",
		"        peer: codex",
		"        protocolVersion: v2",
		"        endpointId: dsh-endpoint",
		"        autoWake: true",
		"        watchIntervalMs: 500",
		`        debugLog: '${POSIX(paths.receiverLog)}'`,
		"    - id: hx-probe",
		"      name: '@local/hx-probe'",
		"      config:",
		`        out: '${POSIX(paths.probe)}'`,
		"        intervalMs: 150",
		""
	].join("\n");
	writeFileSync(paths.patch, patch, "utf8");
	void extraPatches;
	return paths.patch;
}

/** ACP client over the host's stdio, keeping every frame for the artifact. */
class AcpHost {
	constructor(paths, profile) {
		this.paths = paths;
		this.nextId = 1;
		this.pending = new Map();
		this.notes = [];
		this.buffer = "";
		this.exited = false;
		this.exitInfo = null;
		this.out = [];
		this.child = spawn(COMSPEC, ["/d", "/s", "/c", `%DSH_LAB_CMD% --profile ${profile} --patch %DSH_LAB_PATCH%`], {
			cwd: paths.base,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, DSH_HOME: paths.dshHome, DSH_LAB_CMD: `"${NATIVE(DSH)}"`, DSH_LAB_PATCH: `"${paths.patch}"` }
		});
		this.child.stdin.on("error", (error) => this.notes.push(`stdin error: ${String(error?.code ?? error)}`));
		this.child.stdout.on("data", (chunk) => {
			this.out.push(chunk.toString("utf8"));
			this.#consume(chunk.toString("utf8"));
		});
		this.child.stderr.on("data", (chunk) => this.notes.push(`stderr: ${chunk.toString("utf8").trim().slice(0, 400)}`));
		this.child.on("exit", (code, signal) => {
			this.exited = true;
			this.exitInfo = { code, signal, at: new Date().toISOString() };
		});
	}

	#consume(text) {
		this.buffer += text;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			index = this.buffer.indexOf("\n");
			if (line === "") continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				this.notes.push(`non-json stdout: ${line.slice(0, 200)}`);
				continue;
			}
			if (frame.id !== undefined && frame.method === undefined) {
				const waiter = this.pending.get(frame.id);
				if (waiter !== undefined) {
					this.pending.delete(frame.id);
					clearTimeout(waiter.timer);
					if (frame.error !== undefined) waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(frame.error)}`));
					else waiter.resolve(frame.result);
				}
				continue;
			}
			if (frame.method !== undefined && frame.id !== undefined) {
				// A server-initiated request (permissions). Allow once and record that it happened.
				this.notes.push(`server request: ${frame.method}`);
				this.#send({ jsonrpc: "2.0", id: frame.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
			}
		}
	}

	#send(frame) {
		if (this.exited) return;
		try {
			this.child.stdin.write(`${JSON.stringify(frame)}\n`);
		} catch (error) {
			this.notes.push(`write failed: ${String(error?.message ?? error)}`);
		}
	}

	request(method, params, timeoutMs) {
		const id = this.nextId++;
		this.#send({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolveRequest, rejectRequest) => {
			// Cleared when the answer arrives: an armed timer left behind keeps the event loop alive for
			// the whole timeout after the host is gone, which makes a finished run look like a hang.
			const timer = setTimeout(() => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				rejectRequest(new Error(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, method, timer });
		});
	}

	kill() {
		try {
			this.child.kill();
		} catch {
			// Already gone.
		}
	}

	dumpArtifacts() {
		writeFileSync(this.paths.hostOut, this.out.join(""), "utf8");
		writeFileSync(this.paths.hostErr, `${this.notes.join("\n")}\n`, "utf8");
	}
}

/** Read the probe JSONL, tolerating a torn tail line while the host is writing. */
function readProbe(paths) {
	if (!existsSync(paths.probe)) return [];
	const entries = [];
	for (const line of readFileSync(paths.probe, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Half-written line: the next poll sees it complete.
		}
	}
	return entries;
}

/** Raw events of one session from one source, oldest first. */
const eventsOf = (entries, sid, source) =>
	entries.filter((entry) => entry.kind === "event" && entry.sid === sid && entry.source === source).sort((a, b) => a.seq - b.seq);

/** The session's open turn, from its own event list. */
function openTurnOf(log) {
	let open = false;
	let turn = null;
	let turnStartSeq = null;
	for (const entry of log) {
		if (entry.type === "turn/start") {
			open = true;
			turn = entry.data?.turn ?? null;
			turnStartSeq = entry.seq;
		}
		if (entry.type === "turn/end" && entry.data?.turn === turn) open = false;
	}
	return { open, turn, turnStartSeq };
}

/** Execution records in the isolated bridge; one being written is skipped, not fatal. */
function executions(paths) {
	const dir = join(paths.bridge, "executions");
	if (!existsSync(dir)) return [];
	const records = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			records.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
		} catch {
			// Mid-write.
		}
	}
	return records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** The receiver's own trace, which is where a deferral is said out loud. */
const receiverTrace = (paths) => (existsSync(paths.receiverLog) ? readFileSync(paths.receiverLog, "utf8").split("\n").filter(Boolean) : []);

/** Poll until the predicate is done or the deadline passes. */
async function until(label, predicate, timeoutMs, everyMs = 500) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await predicate();
		if (result?.done === true) return { ok: true, value: result.value ?? null };
		await sleep(everyMs);
	}
	return { ok: false, label };
}

/** Summarize one delivery's observable effect, from raw evidence only. */
function digest(entries, sid, { sinceSeq, sinceEventCount }) {
	const log = eventsOf(entries, sid, "log");
	const snapshot = eventsOf(entries, sid, "snapshot");
	const freshLog = log.filter((entry) => entry.seq > sinceSeq);
	const all = log;
	const newEvents = all.slice(sinceEventCount);
	return {
		sinceSeq,
		logLen: log.length,
		snapshotLen: snapshot.length,
		logMaxSeq: log.length === 0 ? -1 : log[log.length - 1].seq,
		snapshotMaxSeq: snapshot.length === 0 ? -1 : snapshot[snapshot.length - 1].seq,
		freshLog: freshLog.map((entry) => ({ seq: entry.seq, type: entry.type })),
		newTurnStarts: freshLog.filter((entry) => entry.type === "turn/start").map((entry) => ({ seq: entry.seq, turn: entry.data?.turn })),
		newTurnEnds: freshLog
			.filter((entry) => entry.type === "turn/end")
			.map((entry) => ({ seq: entry.seq, turn: entry.data?.turn, reason: entry.data?.reason?.kind })),
		newSplices: freshLog.filter((entry) => entry.type === "agent/inbox/spliced").map((entry) => ({ seq: entry.seq, target: entry.data?.target, inserted: (entry.data?.inserted ?? []).length, removed: entry.data?.removedCount ?? 0 })),
		newUserMessages: freshLog.filter((entry) => entry.type === "user/message").map((entry) => ({ seq: entry.seq, id: entry.data?.id ?? null })),
		assistantTexts: freshLog
			.filter((entry) => entry.type === "assistant/message")
			.map((entry) => ({
				seq: entry.seq,
				turn: entry.data?.turn ?? null,
				step: entry.data?.step ?? null,
				text: (entry.data?.message?.content ?? [])
					.filter((block) => block?.type === "text")
					.map((block) => block.text)
					.join("")
			})),
		newEventsByType: newEvents.reduce((accumulator, entry) => {
			accumulator[entry.type] = (accumulator[entry.type] ?? 0) + 1;
			return accumulator;
		}, {})
	};
}

/** Send, bind and deliver one delegated message. */
function deliverDelegated(paths, sessionId, { topic, body, mode = "delegated" }) {
	const sent = cli(paths, ["send", "--from", "codex", "--to", "dsh", "--topic", topic, "--kind", "instruction", "--body", body, "--no-deliver", "--no-route"]);
	cli(paths, ["bind", sent.message.threadId, "--endpoint", "dsh-endpoint", "--session", sessionId, "--mode", mode]);
	const delivered = cli(paths, ["deliver", sent.message.messageId, "--endpoint", "dsh-endpoint", "--session", sessionId, "--mode", mode]);
	return { messageId: sent.message.messageId, threadId: sent.message.threadId, deliveryId: delivered.deliveryId };
}

/** All messages on the bridge. */
const messagesOf = (paths) => cli(paths, ["messages"]) ?? [];

/** Every automatic reply the receiver has posted, oldest first. */
const automaticReplies = (paths) => messagesOf(paths).filter((message) => message.from === "dsh" && String(message.clientRequestId ?? "").startsWith("auto-final:"));

/**
 * Check the explicit route: the executor answered the Commander itself with `disposition=final`.
 *
 * The assertions are the same facts as the automatic route — right thread, right parent, right actor,
 * exactly one logical answer — because the contract is about the Commander receiving one answer, not
 * about which code path carried it. What differs is what must be *absent*: no automatic reply.
 *
 * @param {object} paths - this run's paths.
 * @param {object} origin - `{ messageId, threadId }` of the delegated delivery.
 * @param {object|null} record - the execution.
 * @returns {object} the evidence and the failed assertions.
 */
function checkExplicitReturnLeg(paths, origin, record) {
	const fromHarness = messagesOf(paths).filter((message) => message.from === "dsh");
	const reply = fromHarness.length === 0 ? null : fromHarness[fromHarness.length - 1];
	const delivery = reply === null ? null : findDeliveryFor(paths, reply.messageId);
	const assertions = {
		"the execution records an explicit final reply": record !== null && record.explicitFinalReplyMessageId !== null,
		"no automatic reply was posted": record !== null && record.automaticReplyMessageId === null,
		"the automatic path posted nothing at all": automaticReplies(paths).length === 0,
		"the executor's reply is on the thread the work arrived on": reply !== null && reply.threadId === origin.threadId,
		"the executor's reply answers the message that asked": reply !== null && reply.replyTo === origin.messageId,
		"the executor's reply is addressed to the actor that asked": delivery !== null && delivery.target?.actor === "codex",
		"exactly one logical answer exists for this execution": fromHarness.length === 1,
		"the execution's return leg is complete": record !== null && record.state === "replied",
		"protocol invariants hold": (cli(paths, ["verify"])?.ok ?? false) === true
	};
	const failed = Object.entries(assertions).filter(([, passed]) => passed !== true).map(([name]) => name);
	return {
		route: "explicit",
		reply: reply === null ? null : { messageId: reply.messageId, threadId: reply.threadId, replyTo: reply.replyTo ?? null, from: reply.from, kind: reply.kind },
		delivery: delivery === null ? null : { deliveryId: delivery.deliveryId, target: delivery.target, mode: delivery.mode, state: delivery.state },
		counts: { automaticReplies: automaticReplies(paths).length, explicitAnswers: fromHarness.length },
		assertions,
		failed
	};
}

/**
 * Check the return leg of one delegated round against the Commander contract.
 *
 * Every assertion is about a fact on the bridge, not about a log line: the reply has to exist, be on the
 * thread the work arrived on, answer the very message that asked, be addressed to the actor that asked,
 * carry the captured answer byte for byte, and be the *only* logical reply for that execution.
 *
 * @param {object} paths - this run's paths.
 * @param {object} origin - `{ messageId, threadId, deliveryId }` of the delegated delivery.
 * @param {object|null} record - the execution that answered it.
 * @returns {object} the evidence and the failed assertions.
 */
function checkReturnLeg(paths, origin, record) {
	const replies = automaticReplies(paths);
	const all = messagesOf(paths);
	const mine = record === null ? [] : replies.filter((message) => String(message.clientRequestId ?? "").endsWith(`:${record.finalAssistantMessageSeq}`) && String(message.clientRequestId ?? "").includes(record.executionId));
	const reply = mine.length === 0 ? null : mine[mine.length - 1];
	const delivery = reply === null ? null : findDeliveryFor(paths, reply.messageId);
	const assertions = {
		"a reply exists": reply !== null,
		"one logical reply for this execution": mine.length === 1,
		"reply is on the thread the work arrived on": reply !== null && reply.threadId === origin.threadId,
		"reply answers the message that asked": reply !== null && reply.replyTo === origin.messageId,
		"reply comes from this harness": reply !== null && reply.from === "dsh",
		"reply is addressed to the actor that asked": delivery !== null && delivery.target?.actor === "codex",
		"reply is not routed to a session": delivery !== null && delivery.target?.sessionId === undefined,
		"reply body is the captured answer, byte for byte": reply !== null && record !== null && reply.body === record.finalText,
		"the execution records the reply as sent": record !== null && record.automaticReplyMessageId === (reply?.messageId ?? null),
		"the execution's return leg is complete": record !== null && record.state === "replied",
		"protocol invariants hold": (cli(paths, ["verify"])?.ok ?? false) === true
	};
	const failed = Object.entries(assertions).filter(([, passed]) => passed !== true).map(([name]) => name);
	return {
		route: "automatic",
		reply: reply === null ? null : { messageId: reply.messageId, threadId: reply.threadId, replyTo: reply.replyTo ?? null, from: reply.from, clientRequestId: reply.clientRequestId ?? null, bodyLength: reply.body.length },
		delivery: delivery === null ? null : { deliveryId: delivery.deliveryId, target: delivery.target, mode: delivery.mode, state: delivery.state },
		counts: { automaticReplies: replies.length, logicalRepliesForExecution: mine.length, allMessages: all.length },
		assertions,
		failed
	};
}

/**
 * The delivery that carries one message, from whichever state it is in.
 *
 * The CLI has no "find the delivery for this message" verb, so the three delivery directories are read
 * directly. They are the same store the receiver uses, and the shape is the protocol's own.
 *
 * @param {object} paths - this run's paths.
 * @param {string} messageId - the message to find a delivery for.
 * @returns {object|null} the delivery row, with its `state`, or null.
 */
function findDeliveryFor(paths, messageId) {
	const candidates = [];
	for (const [dir, state] of [["queue", "queued"], ["claims", "claimed"], ["acks", "acked"]]) {
		const base = join(paths.bridge, dir);
		if (!existsSync(base)) continue;
		for (const name of readdirSync(base)) {
			if (!name.endsWith(".json")) continue;
			try {
				const row = JSON.parse(readFileSync(join(base, name), "utf8"));
				if (row.messageId === messageId) candidates.push({ ...row, state });
			} catch {
				// Mid-write: the next poll sees it complete.
			}
		}
	}
	return candidates.length === 0 ? null : candidates[0];
}

/** The compact per-delivery summary printed as the run proceeds. */
function describeExecution(record) {
	if (record === null || record === undefined) return "no execution record";
	return `exec=${record.executionId} state=${record.state} baseline=${record.baselineLogSeq} turns=${JSON.stringify((record.turns ?? []).map((turn) => turn.turn))} finalTurn=${record.finalTurn} finalSeq=${record.finalAssistantMessageSeq} finalText=${JSON.stringify(record.finalText ?? "")}`;
}

async function main() {
	const mode = arg("mode", "smoke");
	const profile = arg("profile", "acp");
	const rounds = Number(arg("rounds", "3"));
	const settleMs = Number(arg("settle", "8000"));
	// `auto` exercises the automatic reply (P1b); `explicit` exercises an executor sending the result
	// itself with `disposition=final`, which must suppress the automatic one (P1c).
	const replyMode = arg("reply-mode", arg("replyMode", "auto")) === "explicit" ? "explicit" : "auto";
	const prompt1 = arg("prompt1", "Reply with exactly the text PROMPT_ONE_OK and nothing else.");
	const paths = newLab();
	const report = { lab: paths.base, mode, profile, repo: REPO, steps: [] };
	process.stdout.write(`acp-turn-boundary: lab ${paths.base}\n`);

	wireProfile(paths, profile, []);
	cli(paths, ["init"]);

	try {
		const host = new AcpHost(paths, profile);
		const initialize = await host.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }, 90_000);
		// The session's working directory is the scratch lab directory by default, not the repository:
		// these sessions run with a real sandbox, and pointing one at the checkout made the host try to
		// grant itself write access to it. `HARNESSMUX_CWD` overrides when a probe needs a real tree.
		const sessionCwd = process.env.HARNESSMUX_CWD?.trim() || paths.base;
		const session = await host.request("session/new", { cwd: sessionCwd, mcpServers: [] }, 90_000);
		const sessionId = session?.sessionId;
		if (typeof sessionId !== "string") throw new Error(`acp-turn-boundary: session/new returned ${JSON.stringify(session)}`);
		report.initialize = initialize;
		report.sessionId = sessionId;
		process.stdout.write(`acp-turn-boundary: session ${sessionId}\n`);

		try {
			// One ordinary prompt. `session/prompt` resolves when the turn it opened has ended, so its
			// resolution is the host's own statement that the session is idle again — and the settle
			// afterwards covers the measured lag before the turn's own events are in the session list.
			const started = Date.now();
			const stop = await host.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt1 }] }, 300_000);
			const ms = Date.now() - started;
			await sleep(settleMs);
			const entries = readProbe(paths);
			const identity = entries.find((entry) => entry.kind === "session-identity" && entry.sid === sessionId) ?? null;
			report.steps.push({
				step: "prompt-1",
				prompt: prompt1,
				stopReason: stop?.stopReason ?? stop,
				ms,
				settleMs,
				sessionHeader: identity?.header ?? null,
				turnStarts: eventsOf(entries, sessionId, "log").filter((entry) => entry.type === "turn/start").map((entry) => entry.seq),
				turnEnds: eventsOf(entries, sessionId, "log").filter((entry) => entry.type === "turn/end").map((entry) => ({ seq: entry.seq, reason: entry.data?.reason?.kind })),
				eventTypes: [...new Set(eventsOf(entries, sessionId, "log").map((entry) => entry.type))],
				// The three sources the receiver could read, compared seq by seq: on this host they agree.
				sources: {
					log: eventsOf(entries, sessionId, "log").map((entry) => entry.seq),
					snapshot: eventsOf(entries, sessionId, "snapshot").map((entry) => entry.seq),
					durable: eventsOf(entries, sessionId, "durable").map((entry) => entry.seq)
				},
				assistantTexts: digest(entries, sessionId, { sinceSeq: -1, sinceEventCount: 0 }).assistantTexts
			});
			process.stdout.write(`acp-turn-boundary: prompt-1 stop=${JSON.stringify(stop?.stopReason ?? stop)} events=${report.steps.at(-1).eventTypes.length} types\n`);

			for (let round = 1; round <= rounds; round += 1) {
				const before = readProbe(paths);
				const logBefore = eventsOf(before, sessionId, "log");
				const sinceSeq = logBefore.length === 0 ? -1 : logBefore[logBefore.length - 1].seq;
				const marker = `ROUND_${round}`;
				// Which return path the round is meant to exercise. The task text decides it, so the run
				// tests the route it claims to test instead of whatever the model happened to choose.
				const body =
					replyMode === "explicit"
						? `${marker}_TASK: This is a delegated task. Send the reply to the commander yourself with the mailbox reply tool, using disposition=final, with the exact body ${marker}_DONE.`
						: `${marker}_TASK: This is a delegated task. Answer with exactly the text ${marker}_DONE as your final visible answer, and do not use the mailbox tool in this round.`;
				const delivered = deliverDelegated(paths, sessionId, { topic: `turn-boundary-${round}`, body });
				const step = { step: `delivery-${round}`, marker, replyMode, idleBefore: openTurnOf(logBefore), sinceSeq, ...delivered };
				const outcome = await until(
					`delivery-${round}`,
					() => {
						const current = eventsOf(readProbe(paths), sessionId, "log").filter((entry) => entry.seq > sinceSeq);
						const turned = current.some((entry) => entry.type === "turn/start");
						const ended = current.some((entry) => entry.type === "turn/end");
						return { done: turned && ended };
					},
					150_000,
					400
				);
				step.timedOut = outcome.ok !== true;
				// The receiver reads the session log on its own tick, so the record is read again after a
				// settle: reading it the instant `turn/end` appears races the capture that observes it.
				await sleep(2_000);
				step.execution = executions(paths).find((candidate) => candidate.deliveryId === delivered.deliveryId) ?? null;
				step.deliveryState = cli(paths, ["state", delivered.deliveryId]);
				step.digest = digest(readProbe(paths), sessionId, { sinceSeq, sinceEventCount: logBefore.length });
				// The return leg: the captured answer has to travel back, once, by the route this round asks for.
				step.returnLeg = replyMode === "explicit" ? checkExplicitReturnLeg(paths, delivered, step.execution) : checkReturnLeg(paths, delivered, step.execution);
				report.steps.push(step);
				process.stdout.write(
					`acp-turn-boundary: round ${round} ownTurns=${JSON.stringify(step.digest.newTurnStarts)} ${describeExecution(step.execution)}\n` +
						`acp-turn-boundary: round ${round} returnLeg failed=${JSON.stringify(step.returnLeg.failed)} counts=${JSON.stringify(step.returnLeg.counts)}\n`
				);
			}

			if (mode === "reply-crash") {
				// The window that matters: the reply is posted, the process dies before the execution records
				// it, and a later reconciliation has only the store to go on.
				//
				// What is real here is the durable state — a reply message that exists under the execution's
				// deterministic request id, and an execution record that does not know about it. That is
				// byte-for-byte what a crash leaves behind, and it is what the reconciler reads. What is
				// simulated is the death itself: the record is rewritten by this probe instead of by a
				// kill. The in-process half (a fresh receiver instance over the same store) is covered by
				// tests/auto-reply.test.mjs A6, which mounts the receiver twice.
				const last = [...report.steps].reverse().find((entry) => String(entry.step ?? "").startsWith("delivery-"));
				const step = { step: "reply-crash" };
				if (last === undefined || last.execution?.automaticReplyMessageId == null) {
					step.note = "no automatic reply exists to crash on; run with --rounds 1 in the same invocation";
					step.failed = ["no automatic reply to test the crash window with"];
				} else {
					const recordPath = join(paths.bridge, "executions", `${last.execution.executionId}.json`);
					const before = JSON.parse(readFileSync(recordPath, "utf8"));
					const replyId = before.automaticReplyMessageId;
					const repliesBefore = automaticReplies(paths).length;
					writeFileSync(
						recordPath,
						`${JSON.stringify({ ...before, state: "reply_pending", automaticReplyMessageId: null, automaticReplyRequestId: null }, null, 2)}\n`,
						"utf8"
					);
					// The receiver's own reconciliation, on its own tick: nothing is poked from here.
					const reconciled = await until(
						"reply-reconcile",
						() => {
							const now = JSON.parse(readFileSync(recordPath, "utf8"));
							return { done: now.automaticReplyMessageId !== null, value: now };
						},
						30_000,
						500
					);
					const after = reconciled.value ?? JSON.parse(readFileSync(recordPath, "utf8"));
					const repliesAfter = automaticReplies(paths);
					const suppressed = receiverTrace(paths).filter((line) => line.includes("duplicateSuppressed=true"));
					step.crashWindow = {
						executionId: after.executionId,
						replyPostedBeforeCrash: replyId,
						recordStateDuringCrash: "reply_pending",
						reconciledMessageId: after.automaticReplyMessageId,
						recordStateAfter: after.state,
						automaticRepliesBefore: repliesBefore,
						automaticRepliesAfter: repliesAfter.length,
						duplicateSuppressedTrace: suppressed.slice(-2)
					};
					step.assertions = {
						"the reply existed before the crash": repliesBefore >= 1,
						"reconciliation recorded a message": after.automaticReplyMessageId !== null,
						"it is the same message, not a new one": after.automaticReplyMessageId === replyId,
						"no second logical reply was posted": repliesAfter.length === repliesBefore,
						"the execution's return leg is complete again": after.state === "replied",
						"the trace records the suppressed duplicate": suppressed.length > 0
					};
					step.failed = Object.entries(step.assertions).filter(([, passed]) => passed !== true).map(([name]) => name);
				}
				report.steps.push(step);
				process.stdout.write(`acp-turn-boundary: reply-crash ${JSON.stringify(step.crashWindow ?? step.note)}\nfailed=${JSON.stringify(step.failed)}\n`);
			}

			if (mode === "contended") {
				// A turn nobody delegated, long enough that a delivery must arrive during it.
				const busyPrompt = arg(
					"busyPrompt",
					"Write a detailed 1200-word explanation of how event sourcing works, for an engineer who has never used it. Reply with the full explanation and nothing else."
				);
				const logBefore = eventsOf(readProbe(paths), sessionId, "log");
				const sinceSeq = logBefore.length === 0 ? -1 : logBefore[logBefore.length - 1].seq;
				const busy = host.request("session/prompt", { sessionId, prompt: [{ type: "text", text: busyPrompt }] }, 600_000);
				busy.catch(() => {});
				const opened = await until(
					"busy-turn-open",
					() => {
						const open = openTurnOf(eventsOf(readProbe(paths), sessionId, "log"));
						return { done: open.open && open.turnStartSeq > sinceSeq, value: open };
					},
					120_000,
					200
				);
				const step = { step: "contended", busyPrompt, busyTurn: opened.value ?? null, sinceSeq };
				if (opened.ok !== true) {
					step.note = "the busy turn never opened, so no contended delivery was attempted";
					report.steps.push(step);
				} else {
					const delivered = deliverDelegated(paths, sessionId, {
						topic: "contended",
						body: "CONTENDED_TASK: This is a delegated task. Reply with exactly the text CONTENDED_DONE and nothing else."
					});
					Object.assign(step, delivered);
					// Watch it while the foreign turn is open. A correct receiver leaves it untouched; a
					// defective one hands it over, which shows as an ack or as a new turn of its own.
					const during = [];
					for (let index = 0; index < 20; index += 1) {
						await sleep(500);
						// The open turn is read *before* the delivery state, so a sample cannot report
						// "open" from a reading taken after the ack that ended the window.
						const open = openTurnOf(eventsOf(readProbe(paths), sessionId, "log"));
						const state = cli(paths, ["state", delivered.deliveryId]);
						during.push({
							ms: 500 * (index + 1),
							deliveryState: state?.state ?? null,
							attempt: state?.attempt ?? null,
							ackedAt: state?.ackedAt ?? null,
							openTurn: open.turn,
							open: open.open
						});
						if (state?.state === "acked" || !open.open) break;
					}
					step.whileBusy = during;
					step.ackedWhileBusy = during.some((entry) => entry.deliveryState === "acked" && entry.open === true);
					step.attemptWhileBusy = during.filter((entry) => entry.open === true).map((entry) => entry.attempt);
					step.foreignTurnSeenOpen = during.some((entry) => entry.open === true);
					step.traceWhileBusy = receiverTrace(paths).filter((line) => /waiting-idle|defer|woke|steered|claimed/u.test(line)).slice(-12);

					// Let the busy turn finish, then require the delivery to open *its own* turn: the newest
					// `turn/start` after the busy one, closed by its own `turn/end`.
					step.busyStopReason = await busy.then((value) => value?.stopReason ?? value).catch((error) => `error: ${String(error?.message ?? error)}`);
					const after = await until(
						"contended-own-turn",
						() => {
							const log = eventsOf(readProbe(paths), sessionId, "log");
							const starts = log.filter((entry) => entry.type === "turn/start" && entry.seq > (opened.value?.turnStartSeq ?? 0));
							if (starts.length === 0) return { done: false };
							const ownTurn = starts[starts.length - 1].data?.turn;
							return { done: log.some((entry) => entry.type === "turn/end" && entry.data?.turn === ownTurn), value: ownTurn };
						},
						240_000,
						500
					);
					await sleep(2_000);
					step.afterBusyTimedOut = after.ok !== true;
					step.ownTurn = after.value ?? null;
					step.execution = executions(paths).find((candidate) => candidate.deliveryId === delivered.deliveryId) ?? null;
					step.deliveryStateAtEnd = cli(paths, ["state", delivered.deliveryId]);
					// The authoritative question — was the delivery accepted *while somebody else's turn was
					// still open? — answered from two timestamps rather than from a sampling race: the ack's
					// own time and the foreign turn's own `turn/end` time. A poll taken just after that turn
					// closed cannot answer it, and one run was misread exactly that way.
					const foreignTurnEnd = eventsOf(readProbe(paths), sessionId, "log").find(
						(entry) => entry.type === "turn/end" && entry.data?.turn === opened.value?.turn
					);
					step.foreignTurnEndedAt = foreignTurnEnd?.at ?? null;
					step.ackedAt = step.deliveryStateAtEnd?.ackedAt ?? null;
					step.ackedBeforeForeignTurnEnded = Boolean(
						step.ackedAt !== null && step.foreignTurnEndedAt !== null && Date.parse(step.ackedAt) < Date.parse(step.foreignTurnEndedAt)
					);
					step.digest = digest(readProbe(paths), sessionId, { sinceSeq: opened.value?.turnStartSeq ?? sinceSeq, sinceEventCount: 0 });
					step.traceAtEnd = receiverTrace(paths).filter((line) => /waiting-idle|defer|woke|steered|claimed|final/u.test(line)).slice(-20);
					report.steps.push(step);
					process.stdout.write(`acp-turn-boundary: contended ackedBeforeForeignTurnEnded=${step.ackedBeforeForeignTurnEnded} attemptsWhileBusy=${JSON.stringify(step.attemptWhileBusy)} ownTurn=${step.ownTurn} ${describeExecution(step.execution)}\n`);
				}
			}

			report.executions = executions(paths).map((record) => ({
				executionId: record.executionId,
				state: record.state,
				deliveryId: record.deliveryId,
				sessionId: record.sessionId,
				dispatchKind: record.dispatchKind,
				baselineLogSeq: record.baselineLogSeq,
				turns: record.turns,
				finalTurn: record.finalTurn,
				finalAssistantMessageSeq: record.finalAssistantMessageSeq,
				finalText: record.finalText,
				automaticReplyMessageId: record.automaticReplyMessageId,
				automaticReplyRequestId: record.automaticReplyRequestId,
				explicitFinalReplyMessageId: record.explicitFinalReplyMessageId
			}));
			report.notes = host.notes.slice(0, 40);
			report.hostExit = host.exitInfo;
			host.dumpArtifacts();
			host.kill();
		} finally {
			host.kill();
		}
	} finally {
		scrubCredentials(paths);
	}

	writeFileSync(paths.summary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	// The assertions are the acceptance gate, not decoration: a failed one has to fail the run, or a
	// green-looking probe would be indistinguishable from a passing one.
	const failures = report.steps.flatMap((entry) => (entry.failed ?? []).map((name) => `${entry.step}: ${name}`));
	report.failures = failures;
	writeFileSync(paths.summary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	if (failures.length > 0) {
		process.stdout.write(`acp-turn-boundary: FAILED ${failures.length} assertion(s):\n${failures.map((name) => `  - ${name}`).join("\n")}\n`);
		process.exitCode = 1;
	}
	process.stdout.write(`acp-turn-boundary: summary -> ${paths.summary}\n`);
}

await main();
