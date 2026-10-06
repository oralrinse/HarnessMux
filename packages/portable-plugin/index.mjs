/**
 * The portable plugin layer.
 *
 * Client adapters (Codex today; Claude Code, Cursor, VS Code/Copilot later) must not
 * each re-implement how HarnessMux is presented. They share:
 *
 *   - the MCP server entry (`packages/mcp/server.mjs`),
 *   - the mailbox skill (`skills/harnessmux/SKILL.md`),
 *   - the MCP registration template (`mcp.json`),
 *   - and this module, which resolves those paths and renders a client-specific
 *     registration block.
 *
 * A client adapter is then a manifest plus whatever lifecycle integration that host
 * actually offers — not a second copy of the plugin.
 *
 * @module @harnessmux/portable-plugin
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's directory. */
export const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

/** Repository root (three levels up: portable-plugin -> packages -> repo). */
export const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");

/** Absolute path of the MCP server entry point. */
export const MCP_SERVER_PATH = join(REPO_ROOT, "packages", "mcp", "server.mjs");

/** Absolute path of the shared skill directory. */
export const SKILL_DIR = join(PACKAGE_DIR, "skills");

/** Absolute path of the MCP registration template. */
export const MCP_TEMPLATE_PATH = join(PACKAGE_DIR, "mcp.json");

/** The environment variables the MCP server understands. */
export const ENV = {
	/** Bridge root; falls back to the remembered root, then `$DSH_HOME/harnessmux`. */
	dir: "HARNESSMUX_DIR",
	/** Actor this client speaks as (default `client`). */
	actor: "HARNESSMUX_ACTOR",
	/** Opt-in trace file for the DSH receiver. */
	debug: "HARNESSMUX_DEBUG"
};

/**
 * Render the MCP registration block for one client.
 *
 * The command is absolute on purpose: MCP clients do not resolve npm package names in
 * this field, and a relative path would depend on the client's working directory.
 *
 * @param {object} [options] - registration options.
 * @param {string} [options.bridgeRoot] - bridge root this client should use.
 * @param {string} [options.actor] - actor name this client speaks as.
 * @param {string} [options.nodePath] - node executable to use (default `node`).
 * @returns {object} a `mcpServers` block ready to paste into a client config.
 */
export function mcpRegistration(options = {}) {
	const env = { [ENV.actor]: options.actor ?? "client" };
	if (options.bridgeRoot) env[ENV.dir] = options.bridgeRoot;
	return {
		mcpServers: {
			harnessmux: {
				command: options.nodePath ?? "node",
				args: [MCP_SERVER_PATH],
				env
			}
		}
	};
}

/**
 * A one-screen summary for installers and skill loaders.
 *
 * @returns {{server: string, skill: string, template: string, env: object}} the paths.
 */
export function describe() {
	return { server: MCP_SERVER_PATH, skill: SKILL_DIR, template: MCP_TEMPLATE_PATH, env: ENV };
}
