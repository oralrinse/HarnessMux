#!/usr/bin/env node
/**
 * Claude lifecycle hook: report what the mailbox is holding, without consuming it.
 *
 * Claude is not woken while idle, and this project does not claim otherwise. The
 * transport keeps the message; this hook surfaces it on the next lifecycle event
 * (SessionStart, UserPromptSubmit). It is a *pull* — discovery only — so nothing is
 * claimed, acked or deleted, and the MCP tools remain the way to read and answer.
 *
 * Output contract (measured on Claude Code 2.1.215, and documented in the binary):
 * a hook prints JSON, and text reaches the model through
 * `hookSpecificOutput.additionalContext` — with `hookEventName` echoed back, because
 * the field is ignored when the name does not match the firing event. Codex accepted
 * plain stdout instead; relying on that here would be an undocumented bet, so this
 * emits the documented object.
 *
 * A quiet mailbox prints nothing at all: an empty hook cannot add noise to a turn.
 *
 * Run: node hooks-handlers/pending.mjs SessionStart
 *
 * @module @harnessmux/adapter-claude/pending
 */

import { loadCore, bridgeRoot, actor } from "./resolve.mjs";

/** Read the event Claude sends on stdin, tolerating an absent or empty payload. */
async function readEvent() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

const eventName = process.argv[2] ?? "SessionStart";
const event = await readEvent();

try {
	const core = await loadCore();
	const root = bridgeRoot(core);
	if (!core.isBridgeRoot(root)) process.exit(0);

	const self = actor();
	const pending = [];
	for (const state of ["queued", "claimed"]) {
		for (const delivery of core.listDeliveries(root, state)) {
			const message = core.getMessage(root, delivery.messageId);
			if (!message || message.from === self) continue;
			pending.push({ state, delivery, message });
		}
	}
	if (pending.length === 0) process.exit(0);

	const lines = [
		`HarnessMux: ${pending.length} message(s) from a peer agent are waiting for you (${self}).`,
		"They are held durably; reading and answering them uses the HarnessMux MCP tools",
		"(read_messages, reply_message). Listing them here does not consume them.",
		""
	];
	for (const { state, delivery, message } of pending.slice(0, 10)) {
		const body = message.body.length > 500 ? `${message.body.slice(0, 500)}…` : message.body;
		lines.push(`--- [${message.messageId}] ${message.from} (${message.kind}) topic=${message.topic}`);
		lines.push(`thread=${message.threadId} mode=${delivery.mode} state=${state}`);
		lines.push(body, "");
	}
	if (pending.length > 10) lines.push(`(${pending.length - 10} more not shown; use read_messages to see all)`);

	process.stdout.write(`${JSON.stringify({
		hookSpecificOutput: {
			hookEventName: typeof event.hook_event_name === "string" ? event.hook_event_name : eventName,
			additionalContext: lines.join("\n").trimEnd()
		}
	})}\n`);
} catch (error) {
	// Never block a Claude turn because the mailbox could not be inspected: a failing
	// hook is noise, and the MCP tools remain available for a deliberate look.
	process.stderr.write(`harnessmux hook: ${String(error?.message ?? error)}\n`);
	process.exit(0);
}
