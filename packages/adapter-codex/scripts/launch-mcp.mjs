/**
 * MCP entry point for the Codex adapter.
 *
 * Codex's Agent Plugin MCP overlay rejects an absolute path in `.mcp.json`: every path
 * there must start with `./` and stay inside the plugin root. Codex also copies a
 * plugin into its own cache, so "inside the plugin root" cannot mean "next to the
 * repository". The server is therefore reached through one indirection:
 *
 *   .mcp.json            command: node, args: ./scripts/launch-mcp.mjs   (relative)
 *   scripts/launch-mcp.mjs  this file: resolves the real server, runs it in-process
 *
 * Resolution order for the server:
 *   1. `HARNESSMUX_MCP_SERVER` — an explicit override, for tests and unusual layouts;
 *   2. `<this file>/../../mcp/server.mjs` — the monorepo, when the adapter runs in place;
 *   3. a checkout path recorded by the installer in `~/.codex/harnessmux.json`, which is
 *      how an installed *copy* of the plugin still finds the server.
 *
 * When nothing resolves, the failure is reported on stderr and the process exits
 * non-zero so the client shows a diagnosable error instead of a dead tool list.
 *
 * @module @harnessmux/adapter-codex/launch-mcp
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where the installer records this machine's checkout. */
export const POINTER_PATH = join(homedir(), ".codex", "harnessmux.json");

const HERE = dirname(fileURLToPath(import.meta.url));

/** Candidate server locations, in priority order. */
export function candidates() {
	const found = [];
	const override = process.env.HARNESSMUX_MCP_SERVER?.trim();
	if (override) found.push(override);
	// In the monorepo: packages/adapter-codex/scripts -> packages/mcp/server.mjs
	found.push(resolve(HERE, "..", "..", "mcp", "server.mjs"));
	// An installed copy: ask the pointer file the installer wrote.
	try {
		const pointer = JSON.parse(readFileSync(POINTER_PATH, "utf8"));
		if (typeof pointer.checkout === "string" && pointer.checkout.trim()) {
			found.push(join(pointer.checkout, "packages", "mcp", "server.mjs"));
		}
	} catch {
		// No pointer file is a normal state: the monorepo candidate above usually wins.
	}
	return found;
}

/** The first candidate that exists, or null. */
export function resolveServer() {
	for (const candidate of candidates()) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

const server = resolveServer();
if (server === null) {
	process.stderr.write([
		"harnessmux: cannot find the MCP server.",
		`looked in:\n  ${candidates().join("\n  ")}`,
		"Run `node scripts/install.mjs --codex` from the HarnessMux checkout to record its location,",
		"or set HARNESSMUX_MCP_SERVER to packages/mcp/server.mjs.",
		""
	].join("\n"));
	process.exit(78);
}

// Import the server in this process so stdio is the only transport: a wrapper that
// spawned a child would have to forward two streams and would break the client's
// process lifetime assumptions. The server's own `serve()` is gated on being run
// directly, so it is started here explicitly.
const mcp = await import(pathToFileURL(server).href);
await mcp.serve();
