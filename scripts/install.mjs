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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
/** The DSH host plugin is its own package inside the repository. */
const PLUGIN_DIR = join(REPO_ROOT, "plugin");
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
     node "${join(REPO_ROOT, "lib", "mailbox.mjs")}" init --root "${bridge}"

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

if (options["print-only"] === true) {
	process.stdout.write(MANUAL);
	process.exit(0);
}

if (!existsSync(dir)) {
	process.stderr.write(`harnessmux: no DSH profile at ${dir}\nCreate it first (run the harness once), or pass --dsh-profile <name>.\n`);
	process.exit(1);
}

// 1. mailbox
if (!dryRun) {
	const { ensureBridge } = await import(new URL("../lib/core.mjs", import.meta.url).href);
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
const dependencyChanged = previousSpec !== linkSpec;
// pnpm keeps an existing link when only its target changed, so retargeting needs --force.
const retargeted = dependencyChanged && typeof previousSpec === "string";
const bundleChanged = !manifest.dsh.profile.bundles.includes(PACKAGE_NAME);
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

process.stdout.write(`\nNext: restart the harness so the plugin mounts (a profile reload also works: \`${dshCommand()}\` from the profile).\nThen verify:\n  node "${join(REPO_ROOT, "lib", "mailbox.mjs")}" status\n  and ask the agent to run \`mailbox action=status\`.\n`);
