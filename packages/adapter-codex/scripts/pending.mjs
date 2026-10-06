#!/usr/bin/env node
/**
 * Codex lifecycle hook: report what the mailbox is holding, without consuming it.
 *
 * This is the Codex half of the "pick up messages when the client is active" contract.
 * Codex cannot be woken while it is idle, and this project does not claim otherwise:
 * the transport keeps the message, and this hook surfaces it on the next lifecycle
 * event (SessionStart, UserPromptSubmit). It is a *pull* — discovery only — so the
 * mailbox's own consumption semantics are untouched: nothing is claimed, acked or
 * deleted here, and the MCP tools remain the way to read and answer.
 *
 * Output contract (Codex bridge): plain stdout on a hook that exits 0 becomes context
 * the model sees. Empty stdout contributes nothing, which is what a quiet mailbox
 * must produce — no "nothing to report" noise in every turn.
 *
 * Run: node scripts/pending.mjs [--actor codex] [--limit 10]
 *
 * @module @harnessmux/adapter-codex/pending
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the installer records this machine's checkout (same pointer as the launcher). */
const POINTER_PATH = join(homedir(), ".codex", "harnessmux.json");

/**
 * Parse `--key value` arguments.
 *
 * @param {string[]} argv - arguments after the script name.
 * @returns {Record<string, string|boolean>} the parsed options.
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

/** The v2 core, resolved the same way the MCP server is. */
async function loadCore() {
	const candidates = [
		process.env.HARNESSMUX_CORE?.trim(),
		resolve(HERE, "..", "..", "core", "core-v2.mjs"),
		readPointerCheckout() ? join(readPointerCheckout(), "packages", "core", "core-v2.mjs") : null
	].filter(Boolean);
	for (const candidate of candidates) {
		if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
	}
	throw new Error(`the protocol core was not found; looked in: ${candidates.join(", ")}`);
}

/** The recorded checkout path, or null. */
function readPointerCheckout() {
	try {
		const pointer = JSON.parse(readFileSync(POINTER_PATH, "utf8"));
		return typeof pointer.checkout === "string" && pointer.checkout.trim() ? pointer.checkout : null;
	} catch {
		return null;
	}
}

const options = parseArgs(process.argv.slice(2));
const actor = typeof options.actor === "string" ? options.actor : process.env.HARNESSMUX_ACTOR?.trim() || "codex";
const limit = Number.isFinite(Number(options.limit)) ? Number(options.limit) : 10;

try {
	const core = await loadCore();
	const root = core.resolveBridgeRoot(process.env.HARNESSMUX_DIR ?? undefined);
	if (!core.isBridgeRoot(root)) process.exit(0);

	const pending = [];
	for (const state of ["queued", "claimed"]) {
		for (const delivery of core.listDeliveries(root, state)) {
			const message = core.getMessage(root, delivery.messageId);
			if (!message || message.from === actor) continue;
			pending.push({ state, delivery, message });
		}
	}
	if (pending.length === 0) process.exit(0);

	const lines = [
		`HarnessMux: ${pending.length} message(s) from a peer agent are waiting for you (${actor}).`,
		"They are held durably; reading and answering them is done with the HarnessMux MCP tools",
		"(read_messages, reply_message). Listing them here does not consume them.",
		""
	];
	for (const { state, delivery, message } of pending.slice(0, limit)) {
		const body = message.body.length > 500 ? `${message.body.slice(0, 500)}…` : message.body;
		lines.push(`--- [${message.messageId}] ${message.from} (${message.kind}) topic=${message.topic}`);
		lines.push(`thread=${message.threadId} mode=${delivery.mode} state=${state}`);
		lines.push(body, "");
	}
	if (pending.length > limit) lines.push(`(${pending.length - limit} more not shown; use read_messages to see all)`);
	process.stdout.write(`${lines.join("\n").trimEnd()}\n`);
} catch (error) {
	// Never block a Codex turn because the mailbox could not be inspected: a hook that
	// fails is noise, and the MCP tools remain available for a deliberate look.
	process.stderr.write(`harnessmux hook: ${String(error?.message ?? error)}\n`);
	process.exit(0);
}
