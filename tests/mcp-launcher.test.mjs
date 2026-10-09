/**
 * MCP launcher tests — the entry a real client actually executes.
 *
 * The contract suite imports the server module and calls it in-process. That is not the path a client
 * takes: the client runs `scripts/launch-mcp.mjs` through `node-shim.cmd`, and the launcher *resolves* the
 * server (env override, then the monorepo, then the checkout recorded by the installer). A defect that
 * lives in the resolution, in the shim, or at the seam between them is invisible to an in-process test —
 * which is exactly how an asynchronous tool reached a real client while the module-level suite stayed green.
 *
 * So this suite drives the launcher as a child process and speaks JSON-RPC to it over stdio, the way the
 * client does. It covers the two answers `wait_for_reply` has: an immediate reply, and a timeout.
 *
 * Run: node tests/mcp-launcher.test.mjs
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import * as core from "../packages/core/core-v2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const LAUNCHER = join(REPO, "packages", "adapter-codex", "scripts", "launch-mcp.mjs");

const ROOT = mkdtempSync(join(tmpdir(), "hxmux-launcher-"));
core.ensureBridge(ROOT, { remember: false });
const THREAD = "launcher-wait-thread";

/** Start the launcher exactly as the client does, and return a JSON-RPC caller over its stdio. */
function startLauncher() {
	const child = spawn(process.execPath, [LAUNCHER], {
		stdio: ["pipe", "pipe", "pipe"],
		// HARNESSMUX_MCP_SERVER is left unset on purpose: the launcher must resolve the monorepo server by
		// itself, which is the branch an in-place install uses.
		env: { ...process.env, HARNESSMUX_DIR: ROOT, HARNESSMUX_ACTOR: "client" }
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	const pending = new Map();
	let nextId = 1;
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	lines.on("line", (line) => {
		const text = line.trim();
		if (text === "") return;
		let frame;
		try {
			frame = JSON.parse(text);
		} catch {
			return;
		}
		const waiter = pending.get(frame.id);
		if (waiter === undefined) return;
		pending.delete(frame.id);
		waiter(frame);
	});
	/** Send one request and resolve with its raw JSON-RPC frame. */
	const request = (method, params, timeoutMs = 20_000) => {
		const id = nextId++;
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return new Promise((resolveFrame, reject) => {
			pending.set(id, resolveFrame);
			setTimeout(() => {
				if (pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs}ms (stderr: ${stderr.slice(0, 300)})`));
			}, timeoutMs);
		});
	};
	return { child, request, stderrOf: () => stderr };
}

// --- 1. the launcher resolves a server and answers the handshake -------------------
{
	const { child, request, stderrOf } = startLauncher();
	try {
		const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "launcher-test", version: "0" } });
		assert.equal(init.error, undefined, `the launcher must answer initialize: ${JSON.stringify(init.error)} ${stderrOf().slice(0, 200)}`);
		assert.equal(init.result.serverInfo.name, "harnessmux", "the resolved server identifies itself");
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

		const listed = await request("tools/list", {});
		const names = listed.result.tools.map((entry) => entry.name);
		assert.ok(names.includes("wait_for_reply"), "the roster arrives through the launcher");

		// --- 2. an asynchronous tool must be answered, over the launcher, with text --------
		// This is the assertion that failed while the module-level suite passed: without the await, the
		// content block arrives with no `text` at all and a real client rejects it.
		const started = Date.now();
		const timedOut = await request("tools/call", { name: "wait_for_reply", arguments: { thread_id: THREAD, timeout_ms: 60 } });
		const waited = Date.now() - started;
		assert.equal(timedOut.result.isError, false, "waiting is not a tool error");
		assert.equal(typeof timedOut.result.content[0].text, "string", "the waiting tool answers with text through the launcher");
		assert.ok(timedOut.result.content[0].text.length > 0, "and the text is not empty");
		assert.match(timedOut.result.content[0].text, /status=timeout/u, "with no reply yet it reports the timeout");
		assert.ok(waited >= 60, `the call waited: ${waited}ms`);

		// --- 3. and with the reply it waited for -----------------------------------------
		core.postMessage(ROOT, { from: "dsh", threadId: THREAD, body: "the reply through the launcher", kind: "report" });
		const answered = await request("tools/call", { name: "wait_for_reply", arguments: { thread_id: THREAD, timeout_ms: 60 } });
		assert.match(answered.result.content[0].text, /status=reply/u, "a waiting reply is returned through the launcher");
		assert.match(answered.result.content[0].text, /the reply through the launcher/u, "with its body");
		assert.equal(answered.result.structuredContent?.status, "reply", "and the structured payload arrives too");
	} finally {
		child.kill();
	}
}

// --- 4. the launcher fails diagnosably when nothing resolves ----------------------
{
	// A resolution failure has to be visible, not a silently empty tool list. This runs the launcher from a
	// **copy** placed outside the repository, so the monorepo candidate does not exist: the only remaining
	// candidate is the env override, pointed at a file that is not there. (From inside the repository that
	// state cannot be reached — the monorepo candidate always resolves — which is why the copy is needed.)
	const sandbox = join(ROOT, "launcher-copy");
	mkdirSync(join(sandbox, "scripts"), { recursive: true });
	copyFileSync(LAUNCHER, join(sandbox, "scripts", "launch-mcp.mjs"));
	const child = spawn(process.execPath, [join(sandbox, "scripts", "launch-mcp.mjs")], {
		stdio: ["pipe", "pipe", "pipe"],
		// Redirect the home directory too: the launcher's last candidate comes from the installer's pointer
		// file under `~/.codex`, and a real one on this machine would resolve the server and hide the failure.
		env: { ...process.env, HARNESSMUX_MCP_SERVER: join(ROOT, "not-a-server.mjs"), HARNESSMUX_DIR: ROOT, USERPROFILE: sandbox, HOME: sandbox }
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	const code = await new Promise((resolveCode) => {
		child.on("exit", resolveCode);
		setTimeout(() => resolveCode("timed out"), 20_000);
	});
	assert.equal(code, 78, `an unresolvable server exits with the documented code: ${stderr.slice(0, 200)}`);
	assert.match(stderr, /cannot find the MCP server/u, "and says so on stderr");
	child.kill();
}

rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
console.log("mcp-launcher.test.mjs: all assertions passed");
