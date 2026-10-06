/**
 * MCP entry point for the Claude adapter.
 *
 * Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` into `.mcp.json` args and runs this
 * file with node, so there is no launcher indirection here — the Codex adapter needed
 * one only because its MCP overlay rejects absolute paths *and* Codex copies a plugin
 * into its own cache. Reusing that design would have been copying complexity, not
 * solving a problem.
 *
 * This module starts the shared MCP server in the same process, so stdio is the only
 * transport and the client's process lifetime is not complicated by a child process.
 *
 * @module @harnessmux/adapter-claude/mcp-entry
 */

import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { resolveCore } from "./resolve.mjs";

const core = resolveCore();
if (core === null) {
	process.stderr.write([
		"harnessmux: cannot find the MCP server.",
		"Run `node scripts/install.mjs --claude` from the HarnessMux checkout,",
		"or set HARNESSMUX_CORE to packages/core/core-v2.mjs.",
		""
	].join("\n"));
	process.exit(78);
}

// The core lives at <checkout>/packages/core, the MCP server at <checkout>/packages/mcp.
const server = join(dirname(dirname(core)), "mcp", "server.mjs");
const mcp = await import(pathToFileURL(server).href);
await mcp.serve();
