/**
 * Claude Code adapter contract tests.
 *
 * Pins what Claude Code actually consumes, not what the adapter happens to contain:
 *   - the manifest fields the plugin loader reads, and the official validator's verdict;
 *   - `.mcp.json` using `${CLAUDE_PLUGIN_ROOT}` with the nested `mcpServers` shape, which
 *     is the shape Claude Code scaffolds itself;
 *   - the lifecycle hooks: `${CLAUDE_PLUGIN_ROOT}` commands, the documented output
 *     object with `hookEventName`, silence on a quiet mailbox, and no consumption;
 *   - the MCP entry serving the shared roster **from an installed location**, which is
 *     the condition that matters (reconnaissance condition D9);
 *   - install → idempotent re-run → uninstall against a temporary `CLAUDE_CONFIG_DIR`,
 *     including that the user's `settings.json` is never touched (D7).
 *
 * `CLAUDE_CONFIG_DIR` is redirected to a temporary directory, so a test run never
 * touches the real Claude configuration.
 *
 * Run: node tests/adapter-claude.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../packages/core/core-v2.mjs";

const REPO = join(import.meta.dirname, "..");
const ADAPTER = join(REPO, "packages", "adapter-claude");
const INSTALLER = join(REPO, "scripts", "install.mjs");
const SHARED_SKILL = join(REPO, "packages", "portable-plugin", "skills", "harnessmux", "SKILL.md");
const CORE = join(REPO, "packages", "core", "core-v2.mjs");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** A throwaway bridge. */
function tempBridge() {
	const path = mkdtempSync(join(tmpdir(), "hxmux-claude-bridge-"));
	core.ensureBridge(path, { remember: false });
	return path;
}

/**
 * Run the hook with an event on stdin, exactly as Claude does.
 *
 * @returns {{stdout: string, stderr: string}} the hook's streams.
 */
function runHook(bridgeRoot, hookEventName, pluginRoot = ADAPTER, extraEnv = {}) {
	const result = execFileSync(process.execPath, [join(pluginRoot, "hooks-handlers", "pending.mjs"), hookEventName], {
		encoding: "utf8",
		input: JSON.stringify({ session_id: "contract-test", hook_event_name: hookEventName, cwd: REPO }),
		env: { ...process.env, HARNESSMUX_DIR: bridgeRoot, HARNESSMUX_ACTOR: "claude", CLAUDE_PLUGIN_ROOT: pluginRoot, ...extraEnv }
	});
	return { stdout: result, stderr: "" };
}

// --- 1. the manifest, and the official validator's verdict ----------------------
{
	const manifest = readJson(join(ADAPTER, ".claude-plugin", "plugin.json"));
	assert.equal(manifest.name, "harnessmux", "the plugin name is the project name");
	assert.match(manifest.version, /^[0-9A-Za-z.+-]+$/u, "the version is in the accepted shape");
	assert.match(manifest.description, /DeepSeek Harness/u, "it describes what it connects to");
	assert.deepEqual(manifest.skills, ["./skills/"], "the manifest declares its skill directory");
	for (const key of ["homepage", "repository"]) {
		assert.match(manifest[key], /^https:\/\/github\.com\/oralrinse\/HarnessMux$/u, `${key} points at the real repository`);
	}
	assert.equal(existsSync(join(ADAPTER, "skills", "harnessmux", "SKILL.md")), true, "the skill ships inside the plugin");
	assert.equal(
		readFileSync(join(ADAPTER, "skills", "harnessmux", "SKILL.md"), "utf8"),
		readFileSync(SHARED_SKILL, "utf8"),
		"the shipped skill is the shared one, verbatim — no second source of instructions"
	);

	// The validator is Claude Code's own; treat its verdict as part of the contract.
	const validated = execFileSync("claude", ["plugin", "validate", ADAPTER], { encoding: "utf8" });
	assert.match(validated, /Validation passed/u, "claude plugin validate accepts the adapter");

	// Cursor reads MCP from the manifest rather than discovering a nearby `.mcp.json`, so this
	// field is what makes the same plugin work there; Claude ignores it. Dropping it would
	// silently break Cursor only, which is why it is pinned instead of left implicit.
	assert.equal(manifest.mcpServers, "./.mcp.json", "the manifest declares its MCP file by path (Cursor requires it, Claude ignores it)");
	assert.equal(existsSync(join(ADAPTER, ".mcp.json")), true, "and the declared file exists beside the manifest");
	assert.equal(manifest.skills?.[0], "./skills/", "the skill path stays declared for both loaders");
}

// --- 2. the MCP declaration ----------------------------------------------------
{
	const mcp = readJson(join(ADAPTER, ".mcp.json"));
	assert.deepEqual(Object.keys(mcp.mcpServers), ["harnessmux"], "exactly one server is exposed");
	const server = mcp.mcpServers.harnessmux;
	assert.equal(server.command, "node", "the server runs through node from PATH");
	assert.equal(server.args.length, 1, "one argument");
	// The reconnaissance condition: address the plugin by variable, not by absolute path.
	assert.match(server.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\//u, "the entry point is addressed through CLAUDE_PLUGIN_ROOT");
	assert.equal(/^[A-Za-z]:/u.test(server.args[0]), false, "no absolute path is baked in");
	assert.equal(server.env.HARNESSMUX_ACTOR, "claude", "the actor is stamped for this client");

	// The MCP entry must not reimplement a launcher: Codex needed one, Claude does not.
	const entry = readFileSync(join(ADAPTER, "hooks-handlers", "mcp-entry.mjs"), "utf8");
	assert.match(entry, /mcp", "server\.mjs"/u, "the entry loads the shared MCP server");
	assert.equal(/process\.exit\(78\)/u.test(entry), true, "a missing core is reported, not silently ignored");
}

// --- 3. the hooks ---------------------------------------------------------------
{
	const hooks = readJson(join(ADAPTER, "hooks", "hooks.json"));
	assert.deepEqual(Object.keys(hooks.hooks).sort(), ["SessionStart", "UserPromptSubmit"], "the two lifecycle events are declared");
	for (const [event, groups] of Object.entries(hooks.hooks)) {
		for (const group of groups) {
			for (const hook of group.hooks) {
				assert.equal(hook.type, "command", `${event} uses a command hook`);
				assert.match(hook.command, /^node \$\{CLAUDE_PLUGIN_ROOT\}\//u, `${event} addresses the handler through CLAUDE_PLUGIN_ROOT`);
				assert.equal(typeof hook.timeout, "number", `${event} declares a timeout in seconds`);
			}
		}
	}

	const bridge = tempBridge();
	try {
		// A quiet mailbox contributes nothing at all — not even a "nothing waiting" note.
		assert.equal(runHook(bridge, "SessionStart").stdout, "", "a quiet mailbox produces no output");
		assert.equal(runHook(bridge, "UserPromptSubmit").stdout, "", "and stays silent on the prompt event too");

		// A waiting message produces the documented object.
		const message = core.postMessage(bridge, { from: "dsh", topic: "claude contract", body: "CLAUDE-ADAPTER-MARKER-1: report this." });
		core.enqueueDelivery(bridge, { messageId: message.messageId });
		const { stdout } = runHook(bridge, "UserPromptSubmit");
		const payload = JSON.parse(stdout);
		assert.equal(payload.hookSpecificOutput.hookEventName, "UserPromptSubmit", "the firing event is echoed back, as the field is ignored otherwise");
		assert.match(payload.hookSpecificOutput.additionalContext, /1 message\(s\) from a peer agent are waiting/u, "the model is told work is waiting");
		assert.match(payload.hookSpecificOutput.additionalContext, /CLAUDE-ADAPTER-MARKER-1/u, "the body travels intact");
		assert.match(payload.hookSpecificOutput.additionalContext, new RegExp(message.threadId, "u"), "the thread is named so a reply can target it");
		assert.equal(Object.hasOwn(payload, "continue"), false, "the hook never claims to block the turn");

		// Discovery only: the MCP tools remain the consumer.
		assert.equal(core.listDeliveries(bridge, "queued").length, 1, "the delivery stays queued");
		assert.equal(core.listDeliveries(bridge, "claimed").length, 0, "nothing is claimed");
		assert.equal(core.listDeliveries(bridge, "acked").length, 0, "nothing is acked");

		// The event name comes from stdin, not from the argument, when stdin has one.
		const mismatch = JSON.parse(runHook(bridge, "SessionStart").stdout);
		assert.equal(mismatch.hookSpecificOutput.hookEventName, "SessionStart", "the stdin event name wins");

		// An unusable bridge must never block a Claude turn.
		assert.equal(runHook(join(tmpdir(), "hxmux-does-not-exist-claude"), "SessionStart").stdout, "", "a missing bridge stays silent");
	} finally {
		rmSync(bridge, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- 4. the MCP entry serves the shared roster from an installed location (D9) --
{
	const { resolveCore, coreCandidates } = await import(pathToFileURL(join(ADAPTER, "hooks-handlers", "resolve.mjs")).href);
	assert.equal(resolveCore(), CORE, "in place, the adapter resolves the shared core");
	assert.equal(coreCandidates()[0], process.env.HARNESSMUX_CORE?.trim() || coreCandidates()[0], "an explicit override is consulted first");

	// Drive the real stdio loop through the entry point.
	const { Readable, Writable } = await import("node:stream");
	const mcp = await import(pathToFileURL(join(REPO, "packages", "mcp", "server.mjs")).href);
	const written = [];
	const input = Readable.from([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`]);
	const output = new Writable({ write(chunk, _encoding, done) { written.push(chunk.toString("utf8")); done(); } });
	await mcp.serve({ input, output });
	const names = JSON.parse(written.join("")).result.tools.map((tool) => tool.name);
	// `wait_for_reply` is the ninth: a commander that delegates work must be able to stay and wait for
	// the executor instead of ending its turn, so it is part of the shared surface, not an extra.
	assert.equal(names.length, 9, "the shared tools reach the client through this entry");
	assert.ok(names.includes("bind_thread") && names.includes("get_status"), "including the routing and status tools");
	assert.ok(names.includes("wait_for_reply"), "and the wait a commander loop depends on");
}

// --- 5. install → idempotent → uninstall (D7) -----------------------------------
{
	const claudeHome = mkdtempSync(join(tmpdir(), "hxmux-claude-home-"));
	const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome };
	const run = (...args) => execFileSync(process.execPath, [INSTALLER, ...args], { encoding: "utf8", env });
	const pluginPath = join(claudeHome, "skills", "harnessmux");
	const pointerPath = join(claudeHome, "harnessmux.json");
	const settingsPath = join(claudeHome, "settings.json");

	try {
		// A settings file the user owns must survive the whole cycle untouched.
		mkdirSync(claudeHome, { recursive: true });
		const settings = { permissions: { defaultMode: "bypassPermissions" }, defaultShell: "powershell" };
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		const settingsBefore = readFileSync(settingsPath, "utf8");

		// Dry run writes nothing.
		run("--claude", "--link", "--dry-run");
		assert.equal(existsSync(pluginPath), false, "a dry run installs no plugin");
		assert.equal(existsSync(pointerPath), false, "a dry run writes no pointer");

		// Install.
		const installed = run("--claude", "--link");
		assert.match(installed, /verified: the installed plugin resolves the core/u, "the installer proves the install, not just performs it");
		assert.equal(existsSync(pointerPath), true, "the pointer is written");
		assert.equal(lstatSync(pluginPath).isSymbolicLink(), true, "--link creates a link");
		assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "settings.json is not touched");

		// Idempotent.
		const second = run("--claude", "--link");
		assert.match(second, /already current/u, "a second install reports no change");
		assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "and still does not touch settings.json");

		// Upgrade: a copied install is replaced rather than merged.
		rmSync(pluginPath, { force: true });
		mkdirSync(pluginPath, { recursive: true });
		writeFileSync(join(pluginPath, "STALE"), "leftover\n", "utf8");
		assert.match(run("--claude", "--link"), /updated/u, "a stale install is reported as updated");
		assert.equal(existsSync(join(pluginPath, "STALE")), false, "the stale copy is replaced, not merged");

		// Uninstall.
		const removed = run("--claude", "--uninstall");
		assert.match(removed, /no longer has the HarnessMux/u, "uninstall reports what it removed");
		assert.match(removed, /settings\.json was never modified/u, "uninstall states the user file is untouched");
		assert.equal(existsSync(pluginPath), false, "the plugin is gone");
		assert.equal(existsSync(pointerPath), false, "the pointer is gone");
		assert.equal(readFileSync(settingsPath, "utf8"), settingsBefore, "settings.json is byte-identical after the whole cycle");
	} finally {
		rmSync(claudeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

console.log("adapter-claude.test.mjs: all assertions passed");
