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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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

// --- 6. the MCP command must not depend on the host's PATH ----------------------
// A bare `"command": "node"` works for the CLI, which inherits a user shell's PATH, and fails
// for the Codex desktop app, which does not. Its log said exactly that:
//   mcp_extension_tool_discovery_failed error="MCP startup failed: No such file or directory
//   (os error 2)" pluginId=harnessmux@harnessmux server=harnessmux
// The plugin was installed, enabled and discovered — and never started.
{
	// The repository keeps a portable template; an absolute path here would leak a machine's
	// layout into a published repo.
	const template = readJson(join(ADAPTER, ".mcp.json"));
	assert.equal(template.mcpServers.harnessmux.command, "node", "the tracked template stays portable");

	const codexHome = mkdtempSync(join(tmpdir(), "hxmux-codex-node-"));
	const cacheDir = join(codexHome, "plugins", "cache", "harnessmux", "harnessmux", "0.2.0");
	const cachedFile = join(cacheDir, ".mcp.json");
	const env = { ...process.env, CODEX_HOME: codexHome };
	const run = (...args) => execFileSync(process.execPath, [INSTALLER, ...args], { encoding: "utf8", env });

	try {
		// Exactly what `codex plugin add` leaves behind: a copy of the plugin, manifest and both
		// launchers included — the installer refuses to rewrite a cache whose launcher is missing,
		// because a silent fallback would reinstate the relative-argument bug. The Windows shim has
		// to be present, otherwise this test silently exercises the non-Windows branch and proves
		// nothing about the path the desktop actually takes.
		mkdirSync(join(cacheDir, "scripts"), { recursive: true });
		writeFileSync(cachedFile, `${JSON.stringify(template, null, 2)}\n`, "utf8");
		copyFileSync(join(ADAPTER, "scripts", "launch-mcp.mjs"), join(cacheDir, "scripts", "launch-mcp.mjs"));
		for (const shim of ["node-shim.cmd", "pending-shim.cmd"]) copyFileSync(join(ADAPTER, "scripts", shim), join(cacheDir, "scripts", shim));
		assert.equal(readJson(cachedFile).mcpServers.harnessmux.command, "node", "the cache starts with the unstartable command");

		const output = run("--codex");
		assert.match(output, /cached plugin file/u, "the installer reports the cached copies it inspected");
		const repairedServer = readJson(cachedFile).mcpServers.harnessmux;
		assert.notEqual(repairedServer.command, "node", "the installed copy no longer relies on PATH");
		assert.equal(isAbsolute(repairedServer.command), true, `the command is an absolute path (got ${JSON.stringify(repairedServer.command)})`);
		assert.equal(existsSync(repairedServer.command), true, "and that path exists on this machine");
		assert.equal(repairedServer.cwd, undefined, "no relative cwd is left for the host to resolve");

		if (process.platform === "win32") {
			// The stable anchor: an interpreter that is permanent and findable by name, plus a shim
			// that resolves node at spawn time. An absolute node path would work only until Codex
			// replaces the versioned runtime directory it points into, which is how this broke twice.
			assert.match(repairedServer.command, /cmd\.exe$/iu, "node is reached through the permanent Windows shell, not an absolute node");
			assert.deepEqual(repairedServer.args.slice(0, 3), ["/d", "/s", "/c"], "invoked in a form the host can pass through");
			assert.equal(isAbsolute(repairedServer.args[3]), true, "the shim itself is addressed absolutely");
			assert.match(repairedServer.args[3], /node-shim\.cmd$/u, "and it is the shim, not a bare script");
			assert.equal(existsSync(repairedServer.args[3]), true, "and it exists");
			assert.equal(repairedServer.args[4], "launch-mcp.mjs", "the shim is told which script to run");

			// The parsed command must not name node: that is the whole point of the shim.
			assert.equal(JSON.stringify(repairedServer).includes("node.exe"), false, "no version-sensitive node path is written into the host config");
		} else {
			assert.equal(isAbsolute(repairedServer.args[0]), true, "on POSIX the launcher is addressed absolutely");
			assert.equal(existsSync(repairedServer.args[0]), true, "and that launcher exists");
		}

		// Idempotent, and it never rewrites the tracked template.
		assert.match(run("--codex"), /already correct/u, "a second install finds nothing to change");
		const templateServer = readJson(join(ADAPTER, ".mcp.json")).mcpServers.harnessmux;
		assert.equal(templateServer.command, "node", "the repository template is still portable");
		assert.equal(templateServer.args[0], "./scripts/launch-mcp.mjs", "and keeps its plugin-relative launcher");
	} finally {
		rmSync(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

// --- 7. the Windows shims must be pure ASCII -----------------------------------
// cmd.exe parses a `.cmd` file in the console's OEM code page, not as UTF-8. A non-ASCII byte in
// one therefore splits into several characters, each of which cmd tries to run as a command. An
// em dash was enough to produce 31 lines of `'m' is not recognized as an internal or external
// command` on a Chinese-locale Windows while the script itself still worked — a hook that both
// succeeds and floods the client with errors. Pure ASCII is the only encoding that behaves.
{
	for (const shim of ["node-shim.cmd", "pending-shim.cmd"]) {
		const bytes = readFileSync(join(ADAPTER, "scripts", shim));
		const offenders = [...bytes].map((byte, index) => ({ byte, index })).filter((entry) => entry.byte > 127);
		assert.equal(
			offenders.length,
			0,
			`${shim} must contain only ASCII (first offending byte ${offenders[0]?.byte} at offset ${offenders[0]?.index})`
		);
		// It also has to reach node without being told where node is.
		const text = bytes.toString("ascii");
		assert.match(text, /HARNESSMUX_NODE/u, `${shim} honours the explicit override`);
		assert.match(text, /where node\.exe/u, `${shim} falls back to PATH`);
		assert.match(text, /runtimes\\cua_node/u, `${shim} falls back to the runtime Codex ships`);
	}
}

// --- 8. an upgraded hook replaces the old entry instead of duplicating it --------
// `isOurHook` originally matched only the `pending.mjs` form. Introducing the shim form without
// widening it left the previous entry in place, so the same listing was delivered twice per turn.
{
	const codexHome = mkdtempSync(join(tmpdir(), "hxmux-codex-hooks-"));
	const hooksPath = join(codexHome, "hooks.json");
	const env = { ...process.env, CODEX_HOME: codexHome };
	const run = (...args) => execFileSync(process.execPath, [INSTALLER, ...args], { encoding: "utf8", env });
	const stale = 'node "H:\\\\somewhere\\\\harnessmux\\\\packages\\\\adapter-codex\\\\scripts\\\\pending.mjs" --actor codex';
	const foreign = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo someone-else", timeoutSec: 5 }] }] } };

	try {
		writeFileSync(hooksPath, `${JSON.stringify(foreign, null, 2)}\n`, "utf8");
		// A previous installation, in the shape this adapter used to write.
		const doc = readJson(hooksPath);
		doc.hooks.SessionStart.push({ hooks: [{ type: "command", command: stale, timeoutSec: 20 }] });
		doc.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: stale, timeoutSec: 20 }] }];
		writeFileSync(hooksPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

		const output = run("--codex");
		assert.match(output, /replaced 2 stale entry/u, "both stale entries are recognised and replaced");

		const after = readJson(hooksPath);
		const ours = (event) => (after.hooks[event] ?? []).flatMap((group) => group.hooks ?? []).filter((hook) => String(hook.command).includes("--actor codex"));
		assert.equal(ours("SessionStart").length, 1, "exactly one SessionStart hook of ours remains");
		assert.equal(ours("UserPromptSubmit").length, 1, "exactly one UserPromptSubmit hook remains");
		assert.equal(JSON.stringify(after).includes("pending.mjs"), false, "the superseded command is gone");
		assert.equal(
			after.hooks.SessionStart.some((group) => (group.hooks ?? []).some((hook) => hook.command === "echo someone-else")),
			true,
			"a foreign hook is preserved untouched"
		);

		// Idempotent: a second install must report nothing replaced and must not rewrite the file.
		// Without this, removing and re-adding our own identical entry looked like a repair on every
		// run — the file text never changed, but the report did.
		const textBefore = readFileSync(hooksPath, "utf8");
		const second = run("--codex");
		assert.equal(/replaced/u.test(second), false, "a settled install reports no replacements");
		assert.equal(readFileSync(hooksPath, "utf8"), textBefore, "and rewrites nothing");
	} finally {
		rmSync(codexHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
}

console.log("adapter-codex.test.mjs: all assertions passed");
