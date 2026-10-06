/**
 * Live ACP probe for the mounted harnessmux plugin.
 *
 * Spawns the real DSH ACP server (`dsh --profile acp`), completes the ACP v1
 * handshake, creates a session, and reports:
 *   - which of our mailbox messages the plugin's auto-wake injects (proving the
 *     plugin mounted and its steer path works in a real harness process),
 *   - every tool call the agent makes (proving the `mailbox` tool is registered),
 *   - the assistant's final answer.
 *
 * Run: node <this file> [timeoutMs]
 */

import { spawn } from "node:child_process";
import { BRIDGE_ROOT, CWD, DSH, requireDsh } from "./env.mjs";


const TIMEOUT_MS = Number(process.argv[2] ?? 120_000);

// Windows refuses to spawn a .cmd shim directly, and `shell: true` would splice
// arguments into a command string. Hand the path to cmd.exe through the
// environment so quoting never has to survive argument joining.
requireDsh();
const COMSPEC = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
const child = spawn(COMSPEC, ["/d", "/s", "/c", "%DSH_ACP_CMD% --profile acp"], {
	cwd: CWD,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, DSH_ACP_CMD: `"${DSH}"` }
});
child.stdin.on("error", (error) => notes.push(`stdin error: ${String(error?.code ?? error)}`));
let nextId = 1;
const pending = new Map();
const toolCalls = [];
const assistantText = [];
const notes = [];
let buffer = "";

/** Send one JSON-RPC request and resolve with its result. */
function request(method, params) {
	const id = nextId++;
	const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
	child.stdin.write(frame);
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

/** Answer a server-initiated request (permissions, etc.). */
function respond(id, result) {
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

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
			notes.push(`non-json stdout: ${line.slice(0, 200)}`);
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
		if (frame.method === undefined && frame.id !== undefined) continue;
		// server -> client request
		if (frame.method !== undefined && frame.id !== undefined) {
			notes.push(`server request: ${frame.method}`);
			respond(frame.id, { outcome: { outcome: "selected", optionId: "allow_once" } });
			continue;
		}
		// notification
		if (frame.method === "session/request_permission") {
			respond(frame.id, { outcome: { outcome: "selected", optionId: "allow_once" } });
			continue;
		}
		const update = frame.params?.update ?? frame.params;
		if (frame.method === "session/update" || frame.method === undefined) {
			const kind = update?.sessionUpdate ?? update?.kind ?? "?";
			if (kind === "tool_call" || kind === "tool_call_update") {
				const title = update.title ?? update.toolCall?.title ?? "";
				const status = update.status ?? update.toolCall?.status ?? "";
				const entry = `${kind} ${title} ${status}`.trim();
				if (!toolCalls.includes(entry)) toolCalls.push(entry);
			} else if (kind === "agent_message_chunk" || kind === "agent_message") {
				const text = update.content?.text ?? update.content?.map?.((block) => block.text).join("") ?? "";
				if (text) assistantText.push(text);
			} else {
				notes.push(`update: ${kind} ${JSON.stringify(update).slice(0, 160)}`);
			}
		}
	}
});

child.stderr.on("data", (chunk) => notes.push(`stderr: ${chunk.toString("utf8").trim().slice(0, 300)}`));

const finish = (code) => {
	try {
		child.kill();
	} catch {}
	console.log("\n=== RESULT ===");
	console.log("tool calls seen:", toolCalls.length ? toolCalls.join(" | ") : "(none)");
	console.log("assistant text:", assistantText.join("").slice(0, 1200) || "(none)");
	console.log("notes:", notes.length ? notes.slice(0, 12).join("\n  ") : "(none)");
	process.exit(code);
};

setTimeout(() => {
	notes.push("global timeout reached");
	finish(2);
}, TIMEOUT_MS + 30_000);

try {
	const init = await request("initialize", {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
	});
	console.log("initialize:", JSON.stringify(init).slice(0, 400));

	const session = await request("session/new", { cwd: CWD, mcpServers: [] });
	const sessionId = session.sessionId;
	console.log("session:", sessionId, "config options:", JSON.stringify(session.configOptions ?? []).slice(0, 200));

	await request("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: "Use the mailbox tool with action=status, then answer with the exact string MAILBOX_OK followed by the pending total." }]
	});
	finish(0);
} catch (error) {
	notes.push(`probe error: ${String(error?.message ?? error)}`);
	finish(1);
}
