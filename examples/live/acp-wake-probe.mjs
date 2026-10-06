/**
 * Live ACP wake probe.
 *
 * Answers one question with a real DSH model in a fresh session: "is there
 * anything from the peer agent waiting for me?" Nothing in the prompt names the
 * mailbox tool, so the answer is only correct if the plugin's session briefing
 * told the model about the bridge and the model read it unprompted.
 *
 * Run: node <this file> [timeoutMs]
 */

import { spawn } from "node:child_process";
import { BRIDGE_ROOT, CWD, DSH, requireDsh } from "./env.mjs";


const TIMEOUT_MS = Number(process.argv[2] ?? 120_000);
const PROMPT = process.argv[3] ?? "Do you have anything waiting from the peer agent right now? If yes, quote its body exactly. If no, say NONE.";

requireDsh();
const COMSPEC = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
const child = spawn(COMSPEC, ["/d", "/s", "/c", "%DSH_ACP_CMD% --profile acp"], {
	cwd: CWD,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, DSH_ACP_CMD: `"${DSH}"` }
});

let nextId = 1;
const pending = new Map();
const toolCalls = [];
const assistantText = [];
const notes = [];
let buffer = "";

/** Send one JSON-RPC request and resolve with its result. */
function request(method, params) {
	const id = nextId++;
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject, method });
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`${method} timed out`));
			}
		}, TIMEOUT_MS);
	});
}

child.stdin.on("error", (error) => notes.push(`stdin error: ${String(error?.code ?? error)}`));

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
			notes.push(`non-json stdout: ${line.slice(0, 160)}`);
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
			const entry = `${kind} ${update.title ?? ""} ${update.status ?? ""}`.trim();
			if (!toolCalls.includes(entry)) toolCalls.push(entry);
		} else if (kind === "agent_message_chunk") {
			const text = update.content?.text ?? "";
			if (text) assistantText.push(text);
		} else if (kind === "agent_thought_chunk") {
			const text = update.content?.text ?? "";
			if (text && /mailbox|harnessmux|ZEBRA|pending/i.test(text)) notes.push(`thought: ${text.slice(0, 200)}`);
		}
	}
});

child.stderr.on("data", (chunk) => {
	const text = chunk.toString("utf8").trim();
	if (text) notes.push(`stderr: ${text.slice(0, 300)}`);
});

const finish = (code) => {
	try {
		child.kill();
	} catch {}
	console.log("\n=== RESULT ===");
	console.log("prompt:", PROMPT);
	console.log("tool calls:", toolCalls.length ? toolCalls.join(" | ") : "(none)");
	console.log("assistant text:", assistantText.join("").slice(0, 1500) || "(none)");
	console.log("notes:", notes.length ? notes.slice(0, 8).join("\n  ") : "(none)");
	process.exit(code);
};

setTimeout(() => {
	notes.push("global timeout reached");
	finish(2);
}, TIMEOUT_MS + 30_000);

try {
	await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
	const session = await request("session/new", { cwd: CWD, mcpServers: [] });
	await request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: PROMPT }] });
	finish(0);
} catch (error) {
	notes.push(`probe error: ${String(error?.message ?? error)}`);
	finish(1);
}
