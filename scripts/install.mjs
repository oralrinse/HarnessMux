/**
 * harnessmux installer for DeepSeek Harness.
 *
 * Does two things, both idempotent and both reversible:
 *   1. builds the bridge mailbox (default: `<workspace>/.harnessmux`);
 *   2. wires this repository into a DSH profile as a local plugin
 *      (`package.json` link + profile `bundles` entry + `cordis.patch.yml` row),
 *      writing `.bak-<timestamp>` copies of every file it edits.
 *
 * Usage:
 *   node scripts/install.mjs --dsh-profile desktop [--bridge <dir>] [--dry-run]
 *   node scripts/install.mjs --print-only          # just show the manual steps
 *
 * The profile patch row accepts (all optional):
 *   bridgeRoot: absolute path of the bridge
 *   actor:      this harness's actor name   (default dsh)
 *   peer:       the other agent's actor     (default codex)
 *   autoWake:   false disables steering     (default true)
 *
 * @module harnessmux/install
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
/** The DSH receiver is its own package inside the monorepo. */
const PLUGIN_DIR = join(REPO_ROOT, "packages", "receiver-dsh");
const PACKAGE_NAME = "@local/harnessmux";

/**
 * Parse `--key value` / `--flag` arguments.
 *
 * @param {string[]} argv - arguments after the script name.
 * @returns {Record<string, string|boolean>} parsed options.
 */
function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("--")) options[key] = true;
		else {
			options[key] = next;
			index += 1;
		}
	}
	return options;
}

/** Timestamped backup next to a file. */
function backup(path) {
	const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 15);
	copyFileSync(path, `${path}.bak-${stamp}`);
}

/** The profile directory for a profile name. */
function profileDir(profile) {
	const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
	return join(home, "profiles", profile);
}

/**
 * The DSH launcher: `DSH_CLI` when set, else a bundled launcher found in the
 * standard install locations, else plain `dsh` from PATH.
 *
 * Note what is deliberately *not* a candidate root: a path derived from
 * `DSH_HOME`. `DSH_HOME` is the harness's data directory (`~/.dsh`), so walking
 * up from it yields the user profile — a guess that silently produced a wrong
 * path and made the bundled-pnpm detection fail.
 */
function dshCommand() {
	const configured = process.env.DSH_CLI?.trim();
	if (configured) return configured;
	for (const candidate of bundledCandidates("cli", "bin", "dsh.cmd")) {
		if (existsSync(candidate)) return candidate;
	}
	return "dsh";
}

/** Candidate paths inside an installed DSH runtime, honouring env overrides. */
function bundledCandidates(...parts) {
	const roots = [
		process.env.DSH_INSTALL_ROOT?.trim(),
		"C:\\Program Files\\DeepSeek Harness",
		process.env.LOCALAPPDATA?.trim() ? join(process.env.LOCALAPPDATA.trim(), "Programs", "DeepSeek Harness") : "",
		process.env.ProgramFiles?.trim() ? join(process.env.ProgramFiles.trim(), "DeepSeek Harness") : ""
	].filter(Boolean);
	return roots.map((root) => join(root, "resources", "runtime", ...parts));
}

/**
 * Find a usable package manager: `DSH_PNPM`, then a DSH-bundled pnpm, then PATH.
 *
 * @returns {string|string[]} a spawnable command (argv array when bundled).
 */
function pnpmCommand() {
	const configured = process.env.DSH_PNPM?.trim();
	if (configured) return configured;
	const candidates = [
		process.env.DSH_RUNTIME_PNPM?.trim(),
		...bundledCandidates("pnpm", "bin", "pnpm.cjs")
	].filter(Boolean);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return [process.execPath, candidate];
	}
	return "pnpm";
}

/** YAML-safe rendering of a Windows/Unix path (forward slashes, single-quoted). */
function yamlPath(path) {
	return `'${path.replace(/\\/gu, "/").replace(/'/gu, "''")}'`;
}

const options = parseArgs(process.argv.slice(2));
const profile = typeof options["dsh-profile"] === "string" ? options["dsh-profile"] : "desktop";
const dryRun = options["dry-run"] === true;
const bridge = resolve(typeof options.bridge === "string" ? options.bridge : join(process.cwd(), ".harnessmux"));
const dir = profileDir(profile);

const MANUAL = `Manual setup (equivalent to what this script does):

1. Create the mailbox:
     node "${join(REPO_ROOT, "packages", "cli", "mailbox.mjs")}" init --root "${bridge}"

2. In ${dir}\\package.json:
     - add to "dependencies":  "${PACKAGE_NAME}": "link:${PLUGIN_DIR.replace(/\\/gu, "/")}"
     - add to "dsh.profile.bundles":  "${PACKAGE_NAME}"

3. In ${dir}\\cordis.patch.yml add (replace a bare \`[]\`; never append after it,
   because two YAML documents make the overlay unparsable):
     - insert:
         - id: harnessmux
           name: '${PACKAGE_NAME}'
           # optional:
           # config:
           #   bridgeRoot: "${bridge.replace(/\\/gu, "/")}"
           #   actor: dsh
           #   peer: codex
           #   autoWake: true

4. Install the link and restart the harness:
     cd "${dir}" && pnpm install
     (then restart the DSH app / relaunch \`dsh web\`)
`;

if (!existsSync(dir)) {
	process.stderr.write(`harnessmux: no DSH profile at ${dir}\nCreate it first (run the harness once), or pass --dsh-profile <name>.\n`);
	process.exit(1);
}

/** This machine's Codex home (`CODEX_HOME` wins, then `~/.codex`). */
function codexHome() {
	return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** Paths the Codex adapter owns, so uninstall removes exactly what install created. */
function codexPaths() {
	const home = codexHome();
	return {
		home,
		pointer: join(home, "harnessmux.json"),
		skill: join(home, "skills", "harnessmux", "SKILL.md"),
		hooks: join(home, "hooks.json"),
		pluginDir: join(REPO_ROOT, "packages", "adapter-codex")
	};
}

/**
 * The hook entries this adapter owns inside `~/.codex/hooks.json`.
 *
 * The command must be **absolute**. Codex resolves a hook command against the directory holding
 * the hooks file (`~/.codex`), not against the plugin or the project, so the relative form
 * `node ./scripts/pending.mjs` fails there with `Cannot find module` — observed as
 * `hook: SessionStart Failed`.
 *
 * It also must not name node by an absolute path, for the same reason the MCP entry does not:
 * Codex's runtime lives in a versioned directory that an update replaces, which silently breaks
 * the command. The hooks therefore go through the same `cmd.exe` + `.cmd` shim as the server, so
 * node is resolved at run time.
 *
 * Kept as data so install and uninstall cannot drift apart.
 */
function codexHooks() {
	const shim = join(REPO_ROOT, "packages", "adapter-codex", "scripts", "node-shim.cmd");
	const pending = join(REPO_ROOT, "packages", "adapter-codex", "scripts", "pending.mjs");
	// `cmd.exe` is deliberately **not** quoted and **not** given as a full path.
	//
	// A hook is not necessarily executed by Windows: Codex honours `integratedTerminalShell`, and
	// when that is `wsl` the command runs through a POSIX shell, where a quoted
	// `"C:\WINDOWS\System32\cmd.exe"` is looked up as a program whose *name includes the quotes* and
	// the hook dies with `exited with code 127`. Measured from WSL, three forms and what they do:
	//
	//   "C:\WINDOWS\System32\cmd.exe" …   -> not found, 127      (what this used to write)
	//   cmd.exe …                         -> runs               (chosen)
	//   /mnt/c/Windows/System32/cmd.exe … -> runs
	//
	// Bare `cmd.exe` is the only form that works in both: Windows resolves it through PATH, and WSL
	// resolves it through interop, which puts the Windows system directories on PATH.
	const command = process.platform === "win32"
		? `cmd.exe /d /s /c "${join(dirname(shim), "pending-shim.cmd")}" --actor codex`
		: `"${process.execPath}" "${pending}" --actor codex`;
	return { SessionStart: command, UserPromptSubmit: command };
}

/**
 * Whether a hook entry was written by this adapter.
 *
 * Recognises both shapes this adapter has ever written, so an install after an upgrade
 * **replaces** the old entry instead of adding a second one beside it:
 *   - `node "<…>/pending.mjs" --actor codex`                      the original form
 *   - `"…/cmd.exe" /d /s /c "<…>/pending-shim.cmd" --actor codex` the PATH-independent form
 * Matching only the first is what produced duplicate hooks when the second was introduced, and
 * duplicates mean the same listing is delivered to the model twice per turn.
 *
 * @param {object} hook - one hook entry from `hooks.json`.
 * @returns {boolean} true when this adapter owns it.
 */
/** The exact commands this adapter wants installed, as a set for membership tests. */
const wantedCommandSet = new Set(Object.values(codexHooks()));

/**
 * Whether a command string (not a hook object) belongs to this adapter.
 *
 * @param {string} command - the command text.
 * @returns {boolean} true when this adapter wrote it.
 */
function isOurHookText(command) {
	if (typeof command !== "string") return false;
	const script = command.includes("pending.mjs") || command.includes("pending-shim.cmd");
	return script && command.includes("--actor codex");
}
function isOurHook(hook) {
	if (typeof hook?.command !== "string") return false;
	const script = hook.command.includes("pending.mjs") || hook.command.includes("pending-shim.cmd");
	// The actor flag is part of the identity: it keeps this entry distinguishable from any other
	// tool's hook that happens to run a similarly named script.
	return script && hook.command.includes("--actor codex");
}

/**
 * Install, upgrade or remove the Codex side of HarnessMux.
 *
 * Owns three things and touches nothing else:
 *   1. `~/.codex/harnessmux.json` — where this checkout is, so the plugin's launcher can
 *      find the MCP server even after Codex copies the plugin into its own cache;
 *   2. `~/.codex/skills/harnessmux/SKILL.md` — a copy of the one shared skill. A copy on
 *      purpose: the source of truth stays in `packages/portable-plugin`, and re-running
 *      the installer is what refreshes it, so the two cannot drift silently;
 *   3. `~/.codex/hooks.json` — the two lifecycle hooks, merged into whatever is already
 *      there, and removed by exact ownership on uninstall.
 *
/**
 * An absolute path to a node executable the Codex host can actually start.
 *
 * `.mcp.json` used to say `"command": "node"`, which relies on PATH. The Codex CLI resolves that
 * because it inherits a user shell's PATH; the Codex **desktop app** does not, and its own log
 * records the consequence:
 *
 *   mcp_extension_tool_discovery_failed error="MCP startup failed: No such file or directory
 *   (os error 2)" pluginId=harnessmux@harnessmux server=harnessmux
 *
 * The plugin was installed, enabled and *discovered*, and its server was never started. An
 * absolute path removes the dependency on the host's PATH, and every candidate below exists
 * because this machine's harness or Codex itself ships it.
 *
 * @returns {string|null} an absolute node path, or null when none can be found.
 */
function resolveNodeForMcp() {
	const explicit = process.env.HARNESSMUX_NODE?.trim() || process.env.CODEX_MCP_NODE_PATH?.trim();
	if (explicit && existsSync(explicit)) return explicit;
	// A system installation is preferred over whatever node happens to be running this script:
	// the plugin has to keep working when the editor, or the shell that ran the installer, is
	// gone. Candidate order is "stable first, incidental last", and the platform-specific lists
	// are separate so a POSIX machine is not left with only the last resort.
	const candidates = [];
	if (process.platform === "win32") {
		candidates.push(
			"C:\\Program Files\\nodejs\\node.exe",
			join(homedir(), "AppData", "Roaming", "npm", "node.exe"),
			join(homedir(), "AppData", "Local", "Programs", "nodejs", "node.exe"),
			join(process.env["ProgramFiles"] ?? "C:\\Program Files", "nodejs", "node.exe")
		);
		// The Codex desktop app ships a node runtime; the versioned directory is discovered
		// rather than pinned, so a Codex update does not invalidate this.
		const runtimes = join(homedir(), "AppData", "Local", "OpenAI", "Codex", "runtimes", "cua_node");
		try {
			for (const entry of readdirSync(runtimes)) candidates.push(join(runtimes, entry, "bin", "node.exe"));
		} catch {
			// No bundled runtime is a normal outcome on a machine without the desktop app.
		}
	} else {
		candidates.push("/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node", join(homedir(), ".local", "bin", "node"));
	}
	// Whatever `node` resolves to on this shell's PATH, which covers nvm/fnm/volta layouts that
	// no fixed list can enumerate. Skipped when it is the same incidental interpreter as below.
	const onPath = whichNode();
	if (onPath !== null) candidates.push(onPath);
	// Last resort: the interpreter running this script. On a machine with no system-wide node —
	// this one, for example, where the only node belongs to an editor's toolchain — this is what
	// gets written, and it is a genuinely fragile choice: moving or removing that editor breaks
	// the MCP server. It is preferred over nothing, and `HARNESSMUX_NODE` overrides it.
	candidates.push(process.execPath);
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate !== "" && existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * The absolute path `node` resolves to on this process's PATH, or null.
 *
 * `process.execPath` would be wrong here: it is the interpreter running the *installer*, which is
 * not necessarily what the user's shell means by `node`. Asking the shell is what makes nvm,
 * fnm and volta layouts work without enumerating them.
 *
 * @returns {string|null} an absolute path, or null when `node` is not on PATH.
 */
function whichNode() {
	const probe = process.platform === "win32" ? ["cmd", "/d", "/s", "/c", "where node"] : ["sh", "-c", "command -v node"];
	try {
		const out = execFileSync(probe[0], probe.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const first = out.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== "");
		return first && existsSync(first) ? first : null;
	} catch {
		return null;
	}
}

/**
 * Point the copies Codex actually loads at an absolute node.
 *
 * The repository keeps `"command": "node"` on purpose: an absolute path there would leak one
 * machine's layout into a published repo, differ per contributor, and be wrong the moment an
 * editor moves. Codex loads from its own cache, so the absolute path belongs there, regenerated
 * on every install.
 *
 * Codex stores plugins as `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>/`, so the
 * cache is walked rather than assumed — a version bump must not leave the fix behind.
 *
 * @param {string|null} node - absolute node path to write; null disables the rewrite.
 * @returns {{node: string|null, files: string[], changed: number}} what was found and updated.
 */
function refreshCachedMcpConfigs(node) {
	const files = [];
	if (node === null) return { node, files, changed: 0 };
	const walk = (dir, depth) => {
		// `<cache>/<marketplace>/<plugin>/<version>/.mcp.json` is depth 4 from the cache root, so
		// the limit has to leave room for the file itself; a tighter bound silently found nothing.
		if (depth > 5) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			// A missing directory is normal. A *programming* error here is not, and swallowing it
			// cost a debugging round trip: `readdirSync` was not imported, the walk found zero
			// files, and the installer reported "no Codex plugin cache yet" while one existed. So
			// only silence the expected case.
			if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") return;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const path = join(dir, entry.name);
			if (existsSync(join(path, ".mcp.json"))) files.push(join(path, ".mcp.json"));
			walk(path, depth + 1);
		}
	};
	walk(join(codexHome(), "plugins", "cache"), 0);
	let changed = 0;
	for (const file of files) {
		let config;
		try {
			config = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		const server = config?.mcpServers?.harnessmux;
		if (!server) continue;
		// The launcher is addressed absolutely too, and for the same reason as node: the argument
		// used to be `./scripts/launch-mcp.mjs` with `"cwd": "."`, and the host resolves both
		// against *its own* working directory rather than the plugin root. Reproduced by running
		// the documented command from any other directory:
		//   Cannot find module 'C:\Users\…\scripts\launch-mcp.mjs'
		// which is the desktop's `os error 2`. The launcher itself still locates the shared server
		// relative to its own file, so nothing else has to be absolute.
		const launcher = join(dirname(file), "scripts", "launch-mcp.mjs");
		// The launcher has to be there; `codex plugin add` copies it with the manifest. Falling back
		// to the relative argument would silently reinstate the bug this fix removes, so a missing
		// launcher is reported instead.
		if (!existsSync(launcher)) {
			process.stderr.write(`harnessmux: ${launcher} is missing, so the MCP server cannot be started from the cache. Re-run \`codex plugin add harnessmux@harnessmux\` first, then this installer.\n`);
			continue;
		}
		// Windows is addressed through `cmd.exe` plus a `.cmd` shim, not through an absolute node.
		//
		// Two host facts force this, and both were measured rather than assumed:
		//   1. the desktop app does not put node on the PATH of what it spawns, so `"command": "node"`
		//      fails with `MCP startup failed: No such file or directory (os error 2)`;
		//   2. an absolute node path works only until that node goes away, and Codex's own runtime
		//      lives in a *versioned* directory (`runtimes\cua_node\<hash>\bin\node.exe`) that is
		//      replaced on update. That is exactly how this broke the second time.
		// `cmd.exe` is the one executable that is both findable by name and permanent, and the shim
		// resolves node at spawn time, so an update cannot invalidate the entry.
		const shim = join(dirname(file), "scripts", "node-shim.cmd");
		const shimExists = existsSync(shim);
		const wantedCommand = process.platform === "win32" && shimExists ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe") : node;
		const wantedArgs = process.platform === "win32" && shimExists ? ["/d", "/s", "/c", shim, "launch-mcp.mjs"] : [launcher];
		const sameArgs = JSON.stringify(server.args) === JSON.stringify(wantedArgs);
		// `cwd: "."` is dropped: the host resolved it against its own directory anyway, and both
		// launchers need nothing from the working directory.
		const dropCwd = server.cwd !== undefined;
		if (server.command === wantedCommand && sameArgs && !dropCwd) continue;
		server.command = wantedCommand;
		server.args = wantedArgs;
		delete server.cwd;
		if (!dryRun) {
			backup(file);
			writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		}
		changed += 1;
	}
	return { node, files, changed };
}

/**
 * Install, upgrade or remove the Codex side of HarnessMux.
 *
 * Owns three things and touches nothing else:
 *
 *   1. `~/.codex/harnessmux.json`  — where this checkout is, so the plugin's launcher
 *      can find the MCP server even after Codex copies the plugin into its cache;
 *   2. `~/.codex/skills/harnessmux/SKILL.md` — a copy of the one shared skill. It is a
 *      copy on purpose: the source of truth stays in `packages/portable-plugin`, and
 *      re-running the installer is what refreshes it, so the two cannot drift silently;
 *   3. `~/.codex/hooks.json` — the two lifecycle hooks, merged into whatever is already
 *      there, and removed by exact ownership on uninstall.
 *
 * It also points the plugin's `.mcp.json` at an absolute node (see `resolveNodeForMcp`), because
 * the desktop host does not inherit a PATH that resolves `node`.
 *
 * @returns {Promise<void>} resolves when the change is applied or reported.
 */
async function installCodexAdapter() {	const paths = codexPaths();
	const remove = options.uninstall === true;
	const skillSource = join(REPO_ROOT, "packages", "portable-plugin", "skills", "harnessmux", "SKILL.md");

	if (remove) {
		process.stdout.write("harnessmux: removing the Codex adapter\n");
		if (existsSync(paths.pointer)) {
			if (!dryRun) rmSync(paths.pointer, { force: true });
			process.stdout.write(`${dryRun ? "[dry-run] " : ""}removed ${paths.pointer}\n`);
		}
		if (existsSync(paths.skill)) {
			if (!dryRun) rmSync(dirname(paths.skill), { recursive: true, force: true });
			process.stdout.write(`${dryRun ? "[dry-run] " : ""}removed ${dirname(paths.skill)}\n`);
		}
		if (existsSync(paths.hooks)) {
			const current = JSON.parse(readFileSync(paths.hooks, "utf8"));
			let removed = 0;
			for (const event of Object.keys(current.hooks ?? {})) {
				const groups = current.hooks[event];
				if (!Array.isArray(groups)) continue;
				const kept = [];
				for (const group of groups) {
					const hooks = (group.hooks ?? []).filter((hook) => {
						if (!isOurHook(hook)) return true;
						removed += 1;
						return false;
					});
					if (hooks.length > 0) kept.push({ ...group, hooks });
				}
				if (kept.length > 0) current.hooks[event] = kept;
				else delete current.hooks[event];
			}
			if (removed > 0) {
				if (Object.keys(current.hooks ?? {}).length === 0) {
					// Only ever removed when we are the ones who emptied it.
					if (!dryRun) rmSync(paths.hooks, { force: true });
					process.stdout.write(`${dryRun ? "[dry-run] " : ""}removed ${removed} harnessmux hook(s) and the now-empty ${paths.hooks}\n`);
				} else {
					if (!dryRun) {
						backup(paths.hooks);
						writeFileSync(paths.hooks, `${JSON.stringify(current, null, 2)}\n`, "utf8");
					}
					process.stdout.write(`${dryRun ? "[dry-run] " : ""}removed ${removed} harnessmux hook(s), kept the user's own in ${paths.hooks}\n`);
				}
			} else {
				process.stdout.write(`no harnessmux hooks present in ${paths.hooks}\n`);
			}
		}
		process.stdout.write("\nCodex no longer has the HarnessMux MCP server, skill or hooks.\n");
		return;
	}

	// 1. the pointer file: how an installed copy finds its server.
	const pointer = {
		checkout: REPO_ROOT,
		mcpServer: join(REPO_ROOT, "packages", "mcp", "server.mjs"),
		adapter: paths.pluginDir,
		// Each adapter knows its own client identity, so the actor is stamped here rather
		// than defaulted to a generic "client" in every message the client sends.
		actor: "codex"
	};
	if (!dryRun) {
		mkdirSync(paths.home, { recursive: true });
		if (existsSync(paths.pointer)) backup(paths.pointer);
		writeFileSync(paths.pointer, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
	}
	process.stdout.write(`${dryRun ? "[dry-run] " : ""}recorded the checkout in ${paths.pointer}\n`);

	// 2. the skill: copied from the single shared source.
	if (!existsSync(skillSource)) {
		process.stderr.write(`harnessmux: the shared skill is missing at ${skillSource}\n`);
		process.exit(1);
	}
	const skillText = readFileSync(skillSource, "utf8");
	const skillChanged = !existsSync(paths.skill) || readFileSync(paths.skill, "utf8") !== skillText;
	if (skillChanged && !dryRun) {
		mkdirSync(dirname(paths.skill), { recursive: true });
		writeFileSync(paths.skill, skillText, "utf8");
	}
	process.stdout.write(`${dryRun ? "[dry-run] " : ""}${skillChanged ? "installed" : "already current"}: ${paths.skill}\n`);

	// 3. point the copies Codex actually loads at an absolute node.
	const mcp = refreshCachedMcpConfigs(resolveNodeForMcp());
	if (mcp.node === null) {
		process.stderr.write("harnessmux: no node executable found, so the MCP server cannot be started by a host without node on PATH.\nSet HARNESSMUX_NODE to an absolute node path and re-run.\n");
	} else if (mcp.files.length === 0) {
		process.stdout.write(`${dryRun ? "[dry-run] " : ""}no Codex plugin cache yet; \`codex plugin add harnessmux@harnessmux\` will copy the manifest, then re-run this installer to fix its node path\n`);
	} else {
		process.stdout.write(`${dryRun ? "[dry-run] " : ""}${mcp.changed > 0 ? `updated ${mcp.changed}` : "already correct"}: node = ${mcp.node} in ${mcp.files.length} cached plugin file(s)\n`);
	}

	// 4. the lifecycle hooks, merged rather than overwritten.
	//
	// Merge means: our own entries are removed first (in any shape this adapter has ever written)
	// and then re-added in the current shape; everything that is not ours is left exactly as it
	// was. Without the removal step an upgrade that changes the command string leaves the old
	// entry in place beside the new one, and the model receives the same listing twice per turn.
	let hooksDoc = { hooks: {} };
	if (existsSync(paths.hooks)) {
		try {
			hooksDoc = JSON.parse(readFileSync(paths.hooks, "utf8"));
			hooksDoc.hooks ??= {};
		} catch (error) {
			process.stderr.write(`harnessmux: ${paths.hooks} is not valid JSON (${String(error?.message ?? error)}).\nRefusing to overwrite it; move it aside first.\n`);
			process.exit(1);
		}
	}
	const wanted = codexHooks();
	let hooksChanged = 0;
	let hooksReplaced = 0;
	// Existing state, recorded per event *and* globally before anything is removed.
	const currentFor = (event) => (Array.isArray(hooksDoc.hooks[event]) ? hooksDoc.hooks[event] : []).flatMap((group) => (group?.hooks ?? []).map((hook) => hook?.command));
	const before = Object.fromEntries(Object.keys(hooksDoc.hooks).map((event) => [event, currentFor(event)]));
	const beforeAll = Object.values(before).flat();
	// Entries we own that are not already the exact command we write are stale, wherever they sit.
	const stale = beforeAll.filter((command) => wantedCommandSet.has(command) === false && isOurHookText(command));
	hooksReplaced = stale.length;

	for (const event of new Set([...Object.keys(hooksDoc.hooks), ...Object.keys(wanted)])) {
		const groups = Array.isArray(hooksDoc.hooks[event]) ? hooksDoc.hooks[event] : [];
		const kept = [];
		for (const group of groups) {
			// Our own entries are removed here and re-added below, so that every event ends up with
			// exactly one — whether it had none, one, or several.
			const remaining = (group?.hooks ?? []).filter((hook) => !isOurHook(hook));
			if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
		}
		hooksDoc.hooks[event] = kept;
	}
	for (const [event, command] of Object.entries(wanted)) {
		hooksDoc.hooks[event] ??= [];
		hooksDoc.hooks[event].push({ hooks: [{ type: "command", command, timeoutSec: 20 }] });
	}
	// Drop an event key we emptied rather than leaving an empty array behind.
	for (const [event, groups] of Object.entries(hooksDoc.hooks)) {
		if (Array.isArray(groups) && groups.length === 0) delete hooksDoc.hooks[event];
	}
	const after = Object.fromEntries(Object.keys(hooksDoc.hooks).map((event) => [event, currentFor(event)]));
	// The file is written only when the result actually differs from what was there. Removing and
	// re-adding an identical entry leaves identical text, and treating that as a change made a
	// correct install look like it repaired something on every run.
	const unchanged = JSON.stringify(before) === JSON.stringify(after)
		&& JSON.stringify(Object.keys(before).sort()) === JSON.stringify(Object.keys(after).sort());
	hooksChanged = unchanged ? 0 : 1;
	if (stale.length > 0) hooksChanged = 1;
	if (hooksChanged > 0 && !dryRun) {
		if (existsSync(paths.hooks)) backup(paths.hooks);
		writeFileSync(paths.hooks, `${JSON.stringify(hooksDoc, null, 2)}\n`, "utf8");
	}
	process.stdout.write(`${dryRun ? "[dry-run] " : ""}hooks ${hooksReplaced > 0 ? `replaced ${hooksReplaced} stale entry(ies)` : "installed"}: ${paths.hooks}\n`);

	process.stdout.write([
		"",
		"Next, in Codex:",
		"  1. add this repository as a local marketplace and install the plugin:",
		`       codex plugin marketplace add "${REPO_ROOT}"`,
		"       codex plugin add harnessmux@harnessmux",
		"  2. re-run this installer afterwards: `codex plugin add` copies the manifest into Codex's",
		"     cache, and this step points that copy at an absolute node (the desktop host has no",
		"     node on PATH, and a bare \"node\" makes its MCP server fail to start).",
		"",
		"Then drive it from Codex (CLI or desktop). Verify with a call to `get_status`; the run",
		"prints:  mcp: harnessmux/get_status started / completed",
		""
	].join("\n"));
}

/** This machine's Claude Code home (`CLAUDE_CONFIG_DIR` wins, then `~/.claude`). */
function claudeHome() {
	return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

/** Paths the Claude adapter owns. */
function claudePaths() {
	const home = claudeHome();
	return {
		home,
		// Claude auto-loads every directory under skills/ as `<name>@skills-dir`.
		plugin: join(home, "skills", "harnessmux"),
		pointer: join(home, "harnessmux.json"),
		adapter: join(REPO_ROOT, "packages", "adapter-claude")
	};
}

/**
 * Install, upgrade or remove the Claude Code side of HarnessMux.
 *
 * Deliberately smaller than the Codex side. Reconnaissance showed which complexity
 * Codex forced and Claude does not need:
 *
 *   - no launcher indirection — `${CLAUDE_PLUGIN_ROOT}` is substituted into `.mcp.json`
 *     args, so the plugin can address its own files;
 *   - no user-level hooks file — a plugin ships `hooks/hooks.json`, and it runs with no
 *     trust step;
 *   - no settings mutation — a directory under `~/.claude/skills/` auto-loads as
 *     `<name>@skills-dir`.
 *
 * What remains is one link into the skills directory, plus a record of where the
 * checkout is, because a *copied* plugin cannot reach `packages/core` on its own.
 *
 * @returns {Promise<void>} resolves when the change is applied or reported.
 */
async function installClaudeAdapter() {
	const paths = claudePaths();
	const remove = options.uninstall === true;
	const useLink = options.link === true;

	if (remove) {
		process.stdout.write("harnessmux: removing the Claude Code adapter\n");
		if (existsSync(paths.plugin)) {
			// A junction is removed as a link, never through its target.
			const isLink = lstatSync(paths.plugin).isSymbolicLink();
			if (!dryRun) {
				if (isLink) rmSync(paths.plugin, { force: true });
				else rmSync(paths.plugin, { recursive: true, force: true });
			}
			process.stdout.write(`${dryRun ? "[dry-run] " : ""}removed ${paths.plugin}${isLink ? " (link)" : ""}\n`);
		} else {
			process.stdout.write(`nothing installed at ${paths.plugin}\n`);
		}
		if (existsSync(paths.pointer)) {
			if (!dryRun) rmSync(paths.pointer, { force: true });
			process.stdout.write(`${dryRun ? "[dry-run] " : ""}removed ${paths.pointer}\n`);
		}
		process.stdout.write("\nClaude Code no longer has the HarnessMux MCP server, skill or hooks.\n");
		process.stdout.write(`Your own ${join(paths.home, "settings.json")} was never modified.\n`);
		return;
	}

	// 1. the plugin: linked for development, copied otherwise.
	if (!existsSync(paths.adapter)) {
		process.stderr.write(`harnessmux: the Claude adapter is missing at ${paths.adapter}\n`);
		process.exit(1);
	}
	mkdirSync(dirname(paths.plugin), { recursive: true });
	const existing = existsSync(paths.plugin);
	const existingIsLink = existing && lstatSync(paths.plugin).isSymbolicLink();
	const currentTarget = existingIsLink ? realpathSync(paths.plugin) : null;
	const wantedTarget = realpathSync(paths.adapter);
	const action = !existing ? "installed" : existingIsLink && currentTarget === wantedTarget ? "already current" : "updated";
	if (action !== "already current" && !dryRun) {
		if (existing) rmSync(paths.plugin, { recursive: true, force: true });
		if (useLink) symlinkSync(paths.adapter, paths.plugin, "junction");
		else cpSync(paths.adapter, paths.plugin, { recursive: true });
	}
	process.stdout.write(`${dryRun ? "[dry-run] " : ""}${action} ${paths.plugin} (${useLink ? "linked" : "copied"})\n`);

	// 2. the pointer file: how a *copy* finds the rest of the checkout.
	if (!dryRun) {
		if (existsSync(paths.pointer)) backup(paths.pointer);
		writeFileSync(paths.pointer, `${JSON.stringify({
			checkout: REPO_ROOT,
			core: join(REPO_ROOT, "packages", "core", "core-v2.mjs"),
			adapter: paths.adapter,
			actor: "claude"
		}, null, 2)}\n`, "utf8");
	}
	process.stdout.write(`${dryRun ? "[dry-run] " : ""}recorded the checkout in ${paths.pointer}\n`);

	// 3. prove it rather than assume it: the *installed* plugin must resolve the shared
	// core from where it now lives, with CLAUDE_PLUGIN_ROOT pointing at the install.
	const installedEntry = join(paths.plugin, "hooks-handlers", "resolve.mjs");
	if (!dryRun) {
		if (!existsSync(installedEntry)) {
			process.stderr.write(`harnessmux: ${installedEntry} is missing — the install did not complete.\n`);
			process.exit(1);
		}
		const probe = execFileSync(process.execPath, [
			"-e",
			`import(${JSON.stringify(pathToFileURL(installedEntry).href)}).then((m) => { const found = m.resolveCore(); if (!found) { console.error("no core resolved; tried:\\n  " + m.coreCandidates().join("\\n  ")); process.exit(1); } console.log(found); })`
		], { encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_ROOT: paths.plugin } }).trim();
		process.stdout.write(`verified: the installed plugin resolves the core at ${probe}\n`);
	}

	process.stdout.write([
		"",
		"Next, in Claude Code:",
		"  1. restart the session (or run /reload-plugins); it loads as harnessmux@skills-dir",
		"  2. the HarnessMux MCP server (8 mailbox tools) and the mailbox skill come with it",
		"",
		"Verify:",
		"  claude plugin details harnessmux",
		"  node packages/adapter-claude/hooks-handlers/pending.mjs SessionStart   (silent when nothing waits)",
		""
	].join("\n"));
}

// --- dispatch -------------------------------------------------------------------
// Kept after every declaration: each branch below runs at module top level, so a
// `const` declared later in the file would still be in its temporal dead zone here.
if (options["print-only"] === true && options.codex !== true && options.claude !== true) {
	process.stdout.write(MANUAL);
	process.exit(0);
}

if (options.codex === true) {
	await installCodexAdapter();
	process.exit(0);
}

if (options.claude === true) {
	await installClaudeAdapter();
	process.exit(0);
}

// 1. mailbox
if (!dryRun) {
	const { ensureBridge } = await import(new URL("../packages/core/core.mjs", import.meta.url).href);
	ensureBridge(bridge);
}
process.stdout.write(`${dryRun ? "[dry-run] " : ""}mailbox ready at ${bridge}\n`);

// 2. package.json
const manifestPath = join(dir, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.dependencies ??= {};
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
const linkSpec = `link:${PLUGIN_DIR.replace(/\\/gu, "/")}`;
const previousSpec = manifest.dependencies[PACKAGE_NAME];

/**
 * Does the installed symlink resolve to this package?
 *
 * Comparing `package.json` alone is not enough: after a directory move the spec can
 * already be correct while `node_modules` still holds a link to the old path — a
 * silently broken bundle that the harness only reports much later as
 * "failed to import". The real link is therefore inspected, and a stale one is
 * removed so the install actually rebuilds it (pnpm keeps an existing link when the
 * spec itself is unchanged, even under --force).
 *
 * @returns {{stale: boolean, target: string|null}} link state.
 */
function inspectLink() {
	const linkPath = join(dir, "node_modules", "@local", PACKAGE_NAME.split("/")[1]);
	if (!existsSync(linkPath)) return { stale: true, target: null };
	try {
		const target = realpathSync(linkPath);
		return { stale: resolve(target) !== resolve(PLUGIN_DIR), target };
	} catch {
		return { stale: true, target: null };
	}
}

const link = inspectLink();
const dependencyChanged = previousSpec !== linkSpec;
const retargeted = dependencyChanged || link.stale;
const bundleChanged = !manifest.dsh.profile.bundles.includes(PACKAGE_NAME);
if (dependencyChanged) manifest.dependencies[PACKAGE_NAME] = linkSpec;
if (bundleChanged) manifest.dsh.profile.bundles.push(PACKAGE_NAME);
if (retargeted && !dryRun && link.target !== null) {
	// Remove the stale link before installing, so pnpm has to recreate it.
	rmSync(join(dir, "node_modules", "@local", PACKAGE_NAME.split("/")[1]), { recursive: true, force: true });
}
if (dependencyChanged) manifest.dependencies[PACKAGE_NAME] = linkSpec;
if (bundleChanged) manifest.dsh.profile.bundles.push(PACKAGE_NAME);
if (dependencyChanged || bundleChanged) {
	if (!dryRun) {
		backup(manifestPath);
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	}
	process.stdout.write(`${dryRun ? "[dry-run] " : ""}updated ${manifestPath} (dependency=${dependencyChanged}, bundle=${bundleChanged})\n`);
} else {
	process.stdout.write(`package.json already wired\n`);
}

// 3. cordis.patch.yml
const patchPath = join(dir, "cordis.patch.yml");
const patch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
/** Strip comments and whitespace; several shipped profiles start with a bare `[]`. */
function meaningfulYaml(text) {
	return text
		.split(/\r?\n/u)
		.map((line) => line.replace(/\s+#.*$/u, "").trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.join("\n")
		.trim();
}
if (patch.includes(`name: '${PACKAGE_NAME}'`) || patch.includes(`name: "${PACKAGE_NAME}"`)) {
	process.stdout.write(`cordis.patch.yml already has the harnessmux row\n`);
} else {
	const row = [
		"",
		"# harnessmux: a mailbox shared with a peer coding agent (see the harnessmux repo)",
		"- insert:",
		"    - id: harnessmux",
		`      name: '${PACKAGE_NAME}'`,
		`      config:`,
		`        bridgeRoot: ${yamlPath(bridge)}`,
		"        actor: dsh",
		"        peer: codex",
		// Protocol v2 is the current protocol, so a fresh install gets it rather than v1. The
		// `endpointId` is this harness's routing identity; without it the receiver invents
		// `<actor>-endpoint` and every binding has to name that invented value.
		"        protocolVersion: v2",
		"        endpointId: dsh-endpoint",
		"        autoWake: true",
		""
	].join("\n");
	// An empty sequence/mapping is a whole YAML document: appending a second one
	// makes the overlay unparsable, so replace it instead.
	const existing = meaningfulYaml(patch);
	const isEmptyDocument = existing === "" || existing === "[]" || existing === "{}";
	const header = isEmptyDocument
		? "# Your patch layer for this dsh profile, applied after every bundle layer.\n"
		: `${patch.replace(/\s*$/u, "")}\n`;
	if (!dryRun) {
		if (patch) backup(patchPath);
		writeFileSync(patchPath, `${header}${row}`, "utf8");
	}
	process.stdout.write(`${dryRun ? "[dry-run] " : ""}${isEmptyDocument ? "replaced the empty overlay with" : "appended"} the harnessmux row in ${patchPath}\n`);
}

// 4. pnpm install
if (!dryRun) {
	const pnpm = pnpmCommand();
	const force = retargeted ? ["--force"] : [];
	try {
		if (Array.isArray(pnpm)) execFileSync(pnpm[0], [...pnpm.slice(1), "install", ...force], { cwd: dir, stdio: "inherit" });
		else execFileSync(pnpm, ["install", ...force], { cwd: dir, stdio: "inherit" });
		process.stdout.write(`link installed with ${Array.isArray(pnpm) ? pnpm.join(" ") : pnpm}${retargeted ? " (forced after a link retarget)" : ""}\n`);
	} catch (error) {
		process.stdout.write(`could not run \`pnpm install\` automatically (${String(error?.message ?? error)}).\nRun it yourself:\n  cd "${dir}" && pnpm install${retargeted ? " --force" : ""}\n`);
	}
}

process.stdout.write(`\nNext: restart the harness so the plugin mounts (a mounted plugin is not hot-reloaded; a profile reload also works: \`${dshCommand()}\` from the profile).\nThen verify:\n  node "${join(REPO_ROOT, "packages", "cli", "mailbox-v2.mjs")}" --root "${bridge}" status\n  and ask the agent to run \`mailbox action=status\`.\n\nIf you want to confirm the wake capability is actually loaded, read the trace after the restart:\n  apply: root=… protocol=v2 autoWake=true currentSessionControl=true …\n\`currentSessionControl=true\` means a delegated delivery to an explicitly bound idle session can\nopen a turn by itself; a missing flag means the process predates the feature.\n`);
