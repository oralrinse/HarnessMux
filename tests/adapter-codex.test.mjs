/**
 * Codex adapter contract tests.
 *
 * These cover what Codex actually consumes, not what the adapter happens to contain:
 *   - the manifest fields the Codex plugin loader reads (`mcpServers`, `skills`);
 *   - `.mcp.json` inside the plugin-root rules the Agent Plugin MCP overlay enforces
 *     (relative paths only, no absolute path that Codex would reject);
 *   - the launcher resolving the shared MCP server, and serving the real roster;
 *   - the lifecycle hook: silent on a quiet mailbox, informative when work is waiting,
 *     and never consuming anything;
 *   - install → idempotent re-run → uninstall, including that a foreign hook in the
 *     user's own `hooks.json` survives and nothing broken is left behind (C7).
 *
 * `CODEX_HOME` is redirected to a temporary directory, so a test run never touches the
 * real Codex configuration.
 *
 * Run: node tests/adapter-codex.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../packages/core/core-v2.mjs";

const REPO = join(import.meta.dirname, "..");
const ADAPTER = join(REPO, "packages", "adapter-codex");
const INSTALLER = join(REPO, "scripts", "install.mjs");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** A throwaway bridge. */
function tempBridge() {
	const path = mkdtempSync(join(tmpdir(), "hxmux-adapter-bridge-"));
	core.ensureBridge(path, { remember: false });
	return path;
}

/** Run the hook with a bridge root and return its stdout. */
function runHook(bridgeRoot, extraEnv = {}) {
	return execFileSync(process.execPath, [join(ADAPTER, "scripts", "pending.mjs")], {
		encoding: "utf8",
		env: { ...process.env, HARNESSMUX_DIR: bridgeRoot, HARNESSMUX_ACTOR: "codex", ...extraEnv }
	});
}

// --- 1. the manifest Codex reads ------------------------------------------------
{
	const manifest = readJson(join(ADAPTER, ".codex-plugin", "plugin.json"));
	assert.equal(manifest.name, "harnessmux", "the plugin name matches the marketplace entry");
	assert.match(manifest.version, /^[0-9A-Za-z.+-]+$/u, "the version is in the shape Codex accepts");
	assert.equal(manifest.mcpServers, "./.mcp.json", "the manifest points at the MCP overlay");
	assert.equal(manifest.skills, "./skills/", "the manifest declares a skill directory");
	assert.equal(manifest.interface.displayName, "HarnessMux", "the display name is the project name");
	assert.match(manifest.interface.longDescription, /DeepSeek Harness/u, "it describes what it connects to");
	for (const key of ["homepage", "repository"]) {
		assert.match(manifest[key], /^https:\/\/github\.com\/oralrinse\/HarnessMux$/u, `${key} points at the real repository`);
	}
	assert.equal(JSON.stringify(manifest).includes("harnessmux/harnessmux"), false, "no invented upstream URL remains");

	// The skill is copied in by the installer from the single shared source.
	assert.equal(existsSync(join(ADAPTER, "skills")), false, "the adapter does not keep a second copy of the skill");
	assert.equal(existsSync(join(REPO, "packages", "portable-plugin", "skills", "harnessmux", "SKILL.md")), true, "the shared skill exists");
}

// --- 2. the MCP overlay Codex enforces ------------------------------------------
{
	const mcp = readJson(join(ADAPTER, ".mcp.json"));
	assert.deepEqual(Object.keys(mcp.mcpServers), ["harnessmux"], "exactly one server is exposed");
	const server = mcp.mcpServers.harnessmux;
	assert.equal(server.command, "node", "the server runs through node from PATH");
	assert.equal(server.cwd, ".", "the working directory is the plugin root");
	assert.equal(server.args.length, 1, "one argument");
	// Codex's overlay rejects an absolute path here; this is the rule that shapes the design.
	assert.match(server.args[0], /^\.\//u, "the entry point is a relative path");
	assert.equal(/^[A-Za-z]:/u.test(server.args[0]), false, "no Windows absolute path is present");
	assert.ok(Array.isArray(server.env_vars) && server.env_vars.includes("HARNESSMUX_DIR"), "the bridge root can be forwarded from the environment");
	assert.ok(server.startup_timeout_sec > 0, "a startup timeout is declared");
	assert.deepEqual(
		Object.keys(server).filter((key) => !["command", "args", "cwd", "env_vars", "startup_timeout_sec", "tool_timeout_sec"].includes(key)),
		[],
		"only MCP config fields Codex documents are used"
	);

	// The hook file follows the same relative-path rule.
	const hooks = readJson(join(ADAPTER, "hooks", "hooks.json"));
	assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionStart", "UserPromptSubmit"], "the two lifecycle events are declared");
	for (const [event, groups] of Object.entries(hooks.hooks)) {
		for (const group of groups) {
			for (const hook of group.hooks) {
				assert.equal(hook.type, "command", `${event} uses the only hook shape that runs`);
				assert.match(hook.command, /^node \.\//u, `${event} uses a relative command`);
				assert.equal(typeof hook.timeoutSec, "number", `${event} declares a timeout in seconds`);
				// UserPromptSubmit has no matcher subject; declaring one is refused upstream.
				if (event === "UserPromptSubmit") assert.equal(group.matcher, undefined, "no matcher on UserPromptSubmit");
			}
		}
	}
}

// --- 3. the launcher resolves the shared server and serves the real roster ------
{
	const launcher = await import(pathToFileURL(join(ADAPTER, "scripts", "launch-mcp.mjs")).href);
	const resolved = launcher.resolveServer();
	assert.equal(resolved, join(REPO, "packages", "mcp", "server.mjs"), "the launcher finds the monorepo MCP server");
	assert.equal(existsSync(launcher.POINTER_PATH), true, "the installer recorded a checkout pointer for installed copies");
	assert.equal(readJson(launcher.POINTER_PATH).checkout !== undefined || process.env.CODEX_HOME !== undefined, true, "the pointer is readable");

	// End to end over stdio: the launcher must behave like the server itself.
	const { Readable, Writable } = await import("node:stream");
	const mcp = await import(pathToFileURL(resolved).href);
	const written = [];
	const input = Readable.from([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`]);
	const output = new Writable({ write(chunk, _encoding, done) { written.push(chunk.toString("utf8")); done(); } });
	await mcp.serve({ input, output });
	const names = JSON.parse(written.join("")).result.tools.map((tool) => tool.name);
	assert.ok(names.includes("get_status") && names.includes("send_message"), "the roster reaches the client through this path");
}

// --- 4. the lifecycle hook ------------------------------------------------------
{
	const bridge = tempBridge();
	try {
		// A quiet mailbox must inject nothing: an empty stdout is the contract.
		assert.equal(runHook(bridge), "", "a quiet mailbox produces no output at all");

		// A message from the peer is reported, once, with enough context to act.
		const message = core.postMessage(bridge, { from: "dsh", topic: "adapter contract", body: "PICKUP-MARKER-1: report this." });
		core.enqueueDelivery(bridge, { messageId: message.messageId });
		const output = runHook(bridge);
		assert.match(output, /1 message\(s\) from a peer agent are waiting/u, "the hook announces waiting work");
		assert.match(output, /PICKUP-MARKER-1/u, "the body is included");
		assert.match(output, new RegExp(message.threadId, "u"), "the thread is named so a reply can target it");
		assert.match(output, /does not consume them/u, "it says the listing is not consumption");

		// Discovery only: the queue is untouched, so the MCP tools remain the consumer.
		assert.equal(core.listDeliveries(bridge, "queued").length, 1, "the delivery stays queued");
		assert.equal(core.listDeliveries(bridge, "claimed").length, 0, "nothing is claimed");
		assert.equal(core.listDeliveries(bridge, "acked").length, 0, "nothing is acked");

		// The sender's own messages are not reported back to it.
		const own = core.postMessage(bridge, { from: "codex", topic: "adapter contract", body: "my own note" });
		core.enqueueDelivery(bridge, { messageId: own.messageId });
		assert.match(runHook(bridge), /1 message\(s\)/u, "a message from this actor is not counted");

		// An unusable bridge must never block a Codex turn.
		const broken = join(tmpdir(), "hxmux-does-not-exist-adapter");
		assert.equal(runHook(broken), "", "a missing bridge stays silent instead of failing the turn");
	} finally {
		rmSync(bridge, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- 5. install → idempotent → uninstall (C7) -----------------------------------
{
	const codexHome = mkdtempSync(join(tmpdir(), "hxmux-codex-home-"));
	const env = { ...process.env, CODEX_HOME: codexHome };
	const run = (...args) => execFileSync(process.execPath, [INSTALLER, ...args], { encoding: "utf8", env });
	const hooksPath = join(codexHome, "hooks.json");
	const skillPath = join(codexHome, "skills", "harnessmux", "SKILL.md");

	try {
		// A hook the user already owns must survive the whole cycle.
		mkdirSync(codexHome, { recursive: true });
		const foreign = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node ./user-own-hook.mjs", timeoutSec: 5 }] }] } };
		writeFileSync(hooksPath, `${JSON.stringify(foreign, null, 2)}\n`, "utf8");

		// Dry run must not write.
		run("--codex", "--dry-run");
		assert.equal(existsSync(skillPath), false, "a dry run writes no skill");
		assert.deepEqual(readJson(hooksPath), foreign, "a dry run leaves hooks.json byte-identical");

		// Install.
		run("--codex");
		assert.equal(existsSync(join(codexHome, "harnessmux.json")), true, "the checkout pointer is written");
		assert.equal(existsSync(skillPath), true, "the shared skill is installed");
		assert.equal(readFileSync(skillPath, "utf8"), readFileSync(join(REPO, "packages", "portable-plugin", "skills", "harnessmux", "SKILL.md"), "utf8"), "the installed skill is the shared one, verbatim");
		const afterInstall = readJson(hooksPath);
		assert.equal(afterInstall.hooks.SessionStart.flatMap((group) => group.hooks).length, 1, "SessionStart was added");
		assert.equal(afterInstall.hooks.UserPromptSubmit.flatMap((group) => group.hooks).length, 2, "the user's UserPromptSubmit hook is preserved next to ours");
		assert.equal(afterInstall.hooks.UserPromptSubmit.some((group) => group.hooks.some((hook) => hook.command === "node ./user-own-hook.mjs")), true, "the foreign hook text is unchanged");

		// Idempotent: a second install must not duplicate anything.
		run("--codex");
		const afterSecond = readJson(hooksPath);
		assert.deepEqual(afterSecond, afterInstall, "re-running the installer changes nothing");
		assert.equal(run("--codex").includes("added"), false, "the second run reports no additions");

		// Upgrade: a user-modified copy is refreshed from the shared source.
		writeFileSync(skillPath, "stale copy\n", "utf8");
		run("--codex");
		assert.equal(readFileSync(skillPath, "utf8"), readFileSync(join(REPO, "packages", "portable-plugin", "skills", "harnessmux", "SKILL.md"), "utf8"), "an out-of-date skill is refreshed");

		// Uninstall.
		const output = run("--codex", "--uninstall");
		assert.match(output, /no longer has the HarnessMux/u, "uninstall reports what it removed");
		assert.equal(existsSync(skillPath), false, "the skill directory is gone");
		assert.equal(existsSync(join(codexHome, "harnessmux.json")), false, "the pointer is gone");
		assert.equal(existsSync(hooksPath), true, "the user's own hooks file survives");
		const afterUninstall = readJson(hooksPath);
		assert.deepEqual(afterUninstall, foreign, "hooks.json is back to exactly the user's content");
		assert.equal(JSON.stringify(afterUninstall).includes("pending.mjs"), false, "no harnessmux hook is left behind");
	} finally {
		rmSync(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

console.log("adapter-codex.test.mjs: all assertions passed");
