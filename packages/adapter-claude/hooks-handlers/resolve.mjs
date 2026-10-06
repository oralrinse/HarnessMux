/**
 * Shared path resolution for the Claude adapter.
 *
 * Everything here exists to answer two questions with no machine-specific
 * configuration:
 *
 *   1. where is the HarnessMux protocol core?
 *   2. which bridge root should this client use?
 *
 * Claude Code solves the problem Codex forced a pointer file for: it substitutes
 * `${CLAUDE_PLUGIN_ROOT}` into MCP `args` and hook commands, and it exports the same
 * value to those processes. So the adapter can always find *itself*; what it cannot
 * know is where the rest of the checkout is, and that is what the candidate list
 * below is for.
 *
 * Three install shapes are supported, and none of them is guessed at:
 *
 *   - **in place** — the plugin root is `packages/adapter-claude` of a checkout
 *     (`node scripts/install.mjs --claude --link`), so the core is `../core`;
 *   - **copied** — the plugin was installed into `~/.claude/skills/harnessmux`, and
 *     the installer recorded the checkout in `~/.claude/harnessmux.json`;
 *   - **overridden** — `HARNESSMUX_CORE` names the core file outright.
 *
 * @module @harnessmux/adapter-claude/resolve
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Where the installer records this machine's checkout.
 *
 * It must follow `CLAUDE_CONFIG_DIR` exactly like the installer does: hard-coding
 * `~/.claude` here made the resolver look in a directory the installer never wrote to
 * whenever the config directory was redirected, and the failure showed up only as
 * "no core resolved".
 */
export const POINTER_PATH = join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "harnessmux.json");

/** This module's directory, the adapter package root, and the plugin root. */
export const HERE = dirname(fileURLToPath(import.meta.url));
export const ADAPTER_ROOT = resolve(HERE, "..");
export const PLUGIN_ROOT = resolve(process.env.CLAUDE_PLUGIN_ROOT?.trim() || ADAPTER_ROOT);

/** The checkout recorded by the installer, or null. */
export function recordedCheckout() {
	try {
		const pointer = JSON.parse(readFileSync(POINTER_PATH, "utf8"));
		return typeof pointer.checkout === "string" && pointer.checkout.trim() ? pointer.checkout.trim() : null;
	} catch {
		return null;
	}
}

/**
 * Candidate locations of the protocol core, in priority order.
 *
 * @returns {string[]} absolute paths to try.
 */
export function coreCandidates() {
	const candidates = [];
	const override = process.env.HARNESSMUX_CORE?.trim();
	if (override) candidates.push(override);
	// In place: this file is <checkout>/packages/adapter-claude/hooks-handlers/resolve.mjs,
	// so the core is two levels up from hooks-handlers and across into core/.
	candidates.push(resolve(HERE, "..", "..", "core", "core-v2.mjs"));
	// The plugin root is the adapter package itself; its sibling is packages/core.
	candidates.push(resolve(PLUGIN_ROOT, "..", "core", "core-v2.mjs"));
	// Copied: ask the installer's record.
	const checkout = recordedCheckout();
	if (checkout) candidates.push(join(checkout, "packages", "core", "core-v2.mjs"));
	return [...new Set(candidates)];
}

/** The first existing core path, or null. */
export function resolveCore() {
	for (const candidate of coreCandidates()) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Load the protocol core.
 *
 * @returns {Promise<object>} the core module namespace.
 * @throws {Error} when no candidate exists, with the list that was tried.
 */
export async function loadCore() {
	const core = resolveCore();
	if (core === null) {
		throw new Error(`the HarnessMux core was not found; tried:\n  ${coreCandidates().join("\n  ")}\nRun \`node scripts/install.mjs --claude\` from the checkout, or set HARNESSMUX_CORE.`);
	}
	return import(pathToFileURL(core).href);
}

/**
 * The bridge root this client should use.
 *
 * `HARNESSMUX_DIR` wins, then the root the DSH side remembered, then the workspace
 * default. Resolution itself belongs to the core; this only decides what to offer it.
 *
 * @param {object} core - the loaded core module.
 * @returns {string} an absolute bridge root.
 */
export function bridgeRoot(core) {
	return core.resolveBridgeRoot(process.env.HARNESSMUX_DIR ?? undefined);
}

/** The actor this client speaks as. */
export function actor() {
	const configured = process.env.HARNESSMUX_ACTOR?.trim();
	if (configured) return configured;
	const pointer = (() => {
		try {
			return JSON.parse(readFileSync(POINTER_PATH, "utf8"));
		} catch {
			return null;
		}
	})();
	return pointer?.actor?.trim() || "claude";
}
