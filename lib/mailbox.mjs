#!/usr/bin/env node
/**
 * harnessmux CLI — the agent-facing (and human-facing) side of the mailbox.
 *
 * Every participant talks to the same directory through this one program, so
 * the on-disk format has exactly one implementation. It is dependency-free and
 * needs Node 22+.
 *
 * Usage:
 *   harnessmux init
 *   harnessmux post   --from codex --to dsh --kind instruction \
 *                       --topic "ship the bridge" --body-file -
 *   harnessmux reply  <message-id> --body "done"
 *   harnessmux read   --actor dsh [--peek] [--limit N] [--from-cursor]
 *   harnessmux list   [--to dsh] [--from codex] [--thread ID] [--all]
 *   harnessmux get    <message-id>
 *   harnessmux done   <message-id>
 *   harnessmux status
 *   harnessmux cursor --actor dsh [--set <message-id>]
 *
 * Global options: `--root PATH`, `--json`.
 *
 * @module harnessmux/cli
 */

import { readFileSync } from "node:fs";
import {
	bridgeStatus,
	consumeMessage,
	ensureBridge,
	formatMessage,
	getCursor,
	getMessage,
	listMessages,
	postMessage,
	readMessages,
	rememberRoot,
	resolveBridgeRoot,
	setCursor
} from "./core.mjs";

/**
 * Parse `--key value`, `--flag`, and positional arguments.
 *
 * @param {string[]} argv - arguments after the script name.
 * @returns {{options: Record<string, string|boolean>, positionals: string[]}} parse result.
 */
function parseArgs(argv) {
	const options = {};
	const positionals = [];
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (token.startsWith("--")) {
			const key = token.slice(2);
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) {
				options[key] = true;
			} else {
				options[key] = next;
				index += 1;
			}
			continue;
		}
		positionals.push(token);
	}
	return { options, positionals };
}

/**
 * Resolve a message body from an inline string, a file, or stdin (`-`).
 *
 * @param {unknown} inline - `--body` value.
 * @param {unknown} file - `--body-file` value.
 * @returns {string} the body text.
 */
function resolveBody(inline, file) {
	if (typeof file === "string") return file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
	return typeof inline === "string" ? inline : "";
}

/** Print a value as JSON with `--json`, else in the block rendering. */
function emit(value, options) {
	if (options.json === true) {
		process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
		return;
	}
	if (Array.isArray(value)) {
		process.stdout.write(value.length === 0 ? "(no messages)\n" : `${value.map(formatMessage).join("\n\n")}\n`);
		return;
	}
	if (value && typeof value === "object" && typeof value.body === "string" && typeof value.id === "string") {
		process.stdout.write(`${formatMessage(value)}\n`);
		return;
	}
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Command implementations keyed by subcommand name. */
const COMMANDS = {
	init(root, { options }) {
		const manifest = ensureBridge(root);
		if (options.json === true) emit({ root, manifest }, options);
		else process.stdout.write(`harnessmux ready at ${root}\n`);
	},

	post(root, { options }) {
		const message = postMessage(root, {
			from: String(options.from ?? "codex"),
			to: String(options.to ?? "dsh"),
			topic: typeof options.topic === "string" ? options.topic : "(no topic)",
			kind: typeof options.kind === "string" ? options.kind : "note",
			replyTo: typeof options["reply-to"] === "string" ? options["reply-to"] : undefined,
			threadId: typeof options.thread === "string" ? options.thread : undefined,
			expectReply: options["expect-reply"] === true || options["expect-reply"] === "true",
			refs: typeof options.refs === "string" ? options.refs.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
			body: resolveBody(options.body, options["body-file"])
		});
		emit(message, options);
	},

	reply(root, { options, positionals }) {
		const parentId = positionals[0];
		const parent = parentId ? getMessage(root, parentId) : null;
		if (!parent) throw new Error(`harnessmux: unknown message id ${JSON.stringify(parentId)}`);
		const message = postMessage(root, {
			from: parent.to,
			to: parent.from,
			topic: parent.topic,
			threadId: parent.threadId,
			kind: typeof options.kind === "string" ? options.kind : "answer",
			replyTo: parent.id,
			body: resolveBody(options.body, options["body-file"])
		});
		emit(message, options);
	},

	read(root, { options }) {
		const result = readMessages(root, {
			actor: String(options.actor ?? "dsh"),
			consume: options.peek !== true,
			fromCursor: options["from-cursor"] === true,
			limit: typeof options.limit === "string" ? Number(options.limit) : undefined
		});
		if (options.json === true) emit(result, options);
		else if (result.messages.length === 0) process.stdout.write("(no new messages)\n");
		else process.stdout.write(`${result.messages.map(formatMessage).join("\n\n")}\n`);
	},

	list(root, { options }) {
		emit(listMessages(root, {
			to: typeof options.to === "string" ? options.to : undefined,
			from: typeof options.from === "string" ? options.from : undefined,
			threadId: typeof options.thread === "string" ? options.thread : undefined,
			pendingOnly: options.all !== true
		}), options);
	},

	get(root, { options, positionals }) {
		const message = positionals[0] ? getMessage(root, positionals[0]) : null;
		if (!message) throw new Error(`harnessmux: unknown message id ${JSON.stringify(positionals[0])}`);
		emit(message, options);
	},

	done(root, { options, positionals }) {
		const id = positionals[0];
		if (!id) throw new Error("harnessmux: `done` needs a message id");
		emit({ id, consumed: consumeMessage(root, id) }, options);
	},

	status(root, { options }) {
		emit(bridgeStatus(root), options);
	},

	cursor(root, { options }) {
		const actor = String(options.actor ?? "dsh");
		if (typeof options.set === "string") setCursor(root, actor, options.set);
		emit({ actor, cursor: getCursor(root, actor) }, options);
	},

	root(root, { options }) {
		rememberRoot(root);
		emit({ root }, options);
	}
};

const USAGE = `harnessmux mailbox CLI

  init                                     create the bridge tree and manifest
  post   --from A --to B --topic T [--kind K] [--body TEXT | --body-file FILE|-]
                                           send a message (default kind: note)
  reply  <message-id> [--kind K] [--body TEXT | --body-file FILE|-]
                                           answer a message on its own thread
  read   --actor A [--peek] [--limit N] [--from-cursor] [--json]
                                           read (and consume) messages addressed to A
  list   [--to A] [--from B] [--thread ID] [--all] [--json]
                                           browse messages without consuming
  get    <message-id> [--json]
  done   <message-id>                      consume one message manually
  status [--json]                          pending counts and read cursors
  cursor --actor A [--set ID] [--json]     inspect or set a read watermark
  root   [--json]                          remember this root for later calls

Global options: --root PATH   --json
`;

const { options, positionals } = parseArgs(process.argv.slice(2));
const command = positionals.shift();
if (!command || command === "help" || options.help === true) {
	process.stdout.write(USAGE);
	process.exit(command ? 0 : 1);
}
const handler = COMMANDS[command];
if (!handler) {
	process.stderr.write(`harnessmux: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
	process.exit(1);
}
const root = resolveBridgeRoot(typeof options.root === "string" ? options.root : undefined);
try {
	handler(root, { options, positionals });
} catch (error) {
	process.stderr.write(`${String(error?.message ?? error)}\n`);
	process.exit(1);
}
