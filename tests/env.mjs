/**
 * Shared environment resolution for the live probes.
 *
 * The probes need two things this repository cannot know: where the DeepSeek
 * Harness launcher is, and which workspace a session should run in. Both are
 * resolved from the environment with sensible fallbacks, so the probes run
 * unchanged on another machine instead of carrying someone's home directory.
 *
 *   DSH_CLI           absolute path to the DSH launcher (dsh.cmd / dsh)
 *   DSH_INSTALL_ROOT  install root, when it is not in a standard location
 *   AGENT_BRIDGE_CWD  workspace the probe sessions should use (default: process.cwd())
 *
 * Importing this module never exits: call `requireDsh()` when a probe actually
 * needs the launcher, so a syntax check or `--help` run still works anywhere.
 *
 * @module agent-bridge/tests/env
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Candidate install roots, most specific first. */
const INSTALL_ROOTS = [
	process.env.DSH_INSTALL_ROOT?.trim(),
	"C:\\Program Files\\DeepSeek Harness",
	process.env.LOCALAPPDATA?.trim() ? join(process.env.LOCALAPPDATA.trim(), "Programs", "DeepSeek Harness") : "",
	join(homedir(), "DeepSeek Harness")
].filter(Boolean);

/** The launcher path, or null when it cannot be found. */
export const DSH = (() => {
	const configured = process.env.DSH_CLI?.trim();
	if (configured) return configured;
	for (const root of INSTALL_ROOTS) {
		for (const relative of [["resources", "runtime", "cli", "bin", "dsh.cmd"], ["resources", "runtime", "cli", "bin", "dsh"]]) {
			const candidate = join(root, ...relative);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
})();

/** Workspace the probe's sessions should run in. */
export const CWD = resolve(process.env.AGENT_BRIDGE_CWD?.trim() || process.cwd());

/** The v2 bridge root the probes expect. */
export const BRIDGE_ROOT = process.env.AGENT_BRIDGE_DIR?.trim() ?? join(CWD, ".agent-bridge-v2");

/**
 * Require the DSH launcher, exiting with an actionable message when absent.
 *
 * @returns {string} the launcher path.
 */
export function requireDsh() {
	if (DSH) return DSH;
	console.error([
		"agent-bridge: cannot find the DeepSeek Harness launcher.",
		"Set DSH_CLI to its absolute path, or DSH_INSTALL_ROOT to the install directory.",
		"Example:  DSH_CLI='C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'"
	].join("\n"));
	process.exit(2);
}
