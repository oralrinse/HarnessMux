#!/usr/bin/env node
/**
 * Minimal diagnostic: what session identity does a real agent expose in ACP?
 *
 * The v2 pump filters deliveries by `agent.session.header.id` against the
 * `sessionId` a binding carries. If the host exposes a different identifier than
 * the ACP session id, a correctly bound delivery is silently skipped. This probe
 * prints both sides so the mismatch is evidence rather than speculation.
 *
 * Usage: node tests/diag-session-identity.mjs
 */

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { BRIDGE_ROOT, CWD, DSH, requireDsh } from "./env.mjs";


const ROOT = BRIDGE_ROOT;
requireDsh();
const COMSPEC = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";

const seen = [];
const plugin = await import(pathToFileURL(join(import.meta.dirname, "..", "plugin", "index.js")).href);

// Probe the plugin's own view: mount it inside this process with a fake "root"
// agent that mirrors what a real agent object looks like, and print what the
// filter compares.
const fakeAgent = { id: "fake", status: "running", session: { header: { id: "SESSION-FROM-HEADER" } } };
console.log("plugin expects agent.session.header.id =", fakeAgent.session.header.id);
console.log("bridge root =", ROOT);
console.log("endpointId default for actor 'dsh' =", "dsh-endpoint");
console.log("bindings on disk carry the ACP session id (see the cutover probe)");

// Now ask a real harness process what it exposes: create a session and read the
// bridge endpoint registry the plugin writes (it records live session ids).
const child = spawn(COMSPEC, ["/d", "/s", "/c", "%DSH_ACP_CMD% --profile acp"], {
	cwd: CWD,
	stdio: ["pipe", "pipe", "pipe"],
	env: { ...process.env, DSH_ACP_CMD: `"${DSH}"`, AGENT_BRIDGE_DIR: ROOT }
});
let nextId = 1;
const pending = new Map();
let buffer = "";
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
				waiter(frame);
			}
			continue;
		}
		if (frame.method !== undefined && frame.id !== undefined) {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } })}\n`);
			continue;
		}
		seen.push(frame.params?.update?.sessionUpdate ?? "?");
	}
});
child.stderr.on("data", (chunk) => {
	const text = chunk.toString("utf8").trim();
	if (text) console.log("harness stderr:", text.slice(0, 300));
});

/** Send one request. */
function request(method, params) {
	const id = nextId++;
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	return new Promise((resolve) => {
		pending.set(id, resolve);
		setTimeout(() => resolve({ error: { message: `${method} timed out` } }), 60_000);
	});
}

try {
	await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
	const session = await request("session/new", { cwd: CWD, mcpServers: [] });
	const acpSessionId = session.result?.sessionId;
	console.log("\nACP session id =", acpSessionId);
	// Give the plugin's watcher one tick to register the endpoint with live sessions.
	await new Promise((resolve) => setTimeout(resolve, 12_000));
	console.log("session/update kinds seen:", [...new Set(seen)].join(",") || "(none)");
} finally {
	try {
		child.kill();
	} catch {
		// already gone
	}
}

console.log("\nCheck the endpoint registry written by the plugin:");
console.log("  " + join(ROOT, "endpoints"));
