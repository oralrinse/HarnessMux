#!/usr/bin/env node
/**
 * harnessmux CLI v2 — the protocol-v2 command surface.
 *
 * v2 separates the immutable message from its deliveries, so the verbs are
 * explicit about which layer they touch:
 *
 *   message layer : send, reply, messages, message, thread
 *   routing layer : endpoint, bind, bindings
 *   delivery layer: deliver, inbox, claim, ack, release, reconcile, verify, status
 *   housekeeping  : gc, root
 *
 * Usage highlights:
 *   harnessmux-v2 send --from codex --to dsh --topic "…" --body "…" [--endpoint ID] [--mode advisory]
 *   harnessmux-v2 inbox --actor dsh [--unrouted]
 *   harnessmux-v2 claim <deliveryId> --owner dsh:main [--lease-ms 60000]
 *   harnessmux-v2 ack <deliveryId>            # host accepted the hand-off
 *   harnessmux-v2 release <deliveryId>        # hand-off failed; retry later
 *   harnessmux-v2 verify                      # state invariants
 *
 * @module harnessmux/cli-v2
 */

import { readFileSync } from "node:fs";
import {
	ackDelivery,
	bindThread,
	bridgeStatus,
	claimDelivery,
	enqueueDelivery,
	ensureBridge,
	gc,
	getBinding,
	getDelivery,
	getMessage,
	listBindings,
	listDeliveries,
	listEndpoints,
	listMessages,
	postMessage,
	readManifest,
	reconcile,
	registerEndpoint,
	releaseDelivery,
	resolveBridgeRoot,
	verifyInvariants,
	writeManifest
} from "../core/core-v2.mjs";
import { migrate as migrateV1 } from "../core/migrate.mjs";

/** Switches whose whole name is the flag (`--no-deliver` is not "deliver: false"). */
const BOOLEAN_FLAGS = new Set(["no-deliver", "no-route", "unrouted", "allow-unrouted", "json", "help"]);

/** Parse `--key value`, `--flag`, `--no-key`, and positional arguments. */
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
			if (BOOLEAN_FLAGS.has(key)) {
				options[key] = true;
				continue;
			}
			if (key.startsWith("no-")) {
				options[key.slice(3)] = false;
				continue;
			}
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) options[key] = true;
			else {
				options[key] = next;
				index += 1;
			}
			continue;
		}
		positionals.push(token);
	}
	return { options, positionals };
}

/** Resolve a message body from inline text, a file, or stdin (`-`). */
function resolveBody(inline, file) {
	if (typeof file === "string") return file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
	return typeof inline === "string" ? inline : "";
}

/** Print a value as JSON with `--json`, else as a human line. */
function emit(value, options, human) {
	if (options.json === true || human === undefined) {
		process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
		return;
	}
	process.stdout.write(`${human}\n`);
}

/** One-line rendering of a delivery. */
function renderDelivery(delivery) {
	const target = delivery.target
		? `${delivery.target.actor}${delivery.target.endpointId ? `@${delivery.target.endpointId}` : ""}${delivery.target.sessionId ? `#${delivery.target.sessionId}` : ""}`
		: "UNROUTED";
	return `[${delivery.deliveryId}] ${delivery.state ?? "queued"} -> ${target} mode=${delivery.mode} attempt=${delivery.attempt ?? 0} thread=${delivery.threadId} message=${delivery.messageId}`;
}

/**
 * Build the delivery routing intent for a command.
 *
 * Three outcomes, matching the core's `target` contract:
 *   `null`      — `--no-route`: queue it unrouted on purpose;
 *   `{…}`       — `--endpoint`/`--session` named: that exact target;
 *   `undefined` — nothing named: let the thread binding decide.
 *
 * Passing a bare `{actor}` when the user named no endpoint would silently
 * override the binding, so only a named endpoint or session counts as explicit.
 *
 * @param {object} options - parsed CLI options.
 * @returns {object|null|undefined} the target, or the routing intent.
 */
function routingIntent(options) {
	if (options["no-route"] === true) return null;
	const endpointId = typeof options.endpoint === "string" ? options.endpoint.trim() : "";
	const sessionId = typeof options.session === "string" ? options.session.trim() : "";
	if (!endpointId && !sessionId) return undefined;
	return {
		actor: String(options.to ?? "dsh"),
		...(endpointId ? { endpointId } : {}),
		...(sessionId ? { sessionId } : {})
	};
}

/** One-line rendering of a message. */
function renderMessage(message) {
	return `[${message.messageId}] ${message.createdAt} ${message.from} (${message.kind}) thread=${message.threadId} topic=${message.topic}${message.replyTo ? ` replyTo=${message.replyTo}` : ""}\n${message.body}`;
}

const COMMANDS = {
	init(root, { options }) {
		emit(ensureBridge(root), options, `harnessmux v2 ready at ${root}`);
	},

	root(root, { options }) {
		ensureBridge(root);
		emit({ root }, options, root);
	},

	send(root, { options }) {
		const message = postMessage(root, {
			from: options.from ?? "codex",
			topic: options.topic,
			kind: options.kind,
			replyTo: options["reply-to"],
			thread: options.thread,
			refs: typeof options.refs === "string" ? options.refs.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
			body: resolveBody(options.body, options["body-file"])
		});
		let delivery = null;
		if (options["no-deliver"] !== true) {
			const intent = routingIntent(options);
			delivery = enqueueDelivery(root, {
				messageId: message.messageId,
				...(intent === undefined ? {} : { target: intent }),
				mode: options.mode
			});
		}
		emit({ message, delivery }, options, `${renderMessage(message)}${delivery ? `\ndelivery ${renderDelivery(delivery)}` : ""}`);
	},

	reply(root, { options, positionals }) {
		const parentId = positionals[0];
		const parent = parentId ? getMessage(root, parentId) : null;
		if (!parent) throw new Error(`harnessmux: unknown messageId ${JSON.stringify(parentId)}`);
		const message = postMessage(root, {
			from: options.from ?? "dsh",
			topic: parent.topic,
			threadId: parent.threadId,
			kind: options.kind ?? "answer",
			replyTo: parent.messageId,
			body: resolveBody(options.body, options["body-file"])
		});
		let delivery = null;
		if (options["no-deliver"] !== true) {
			const intent = routingIntent({ ...options, to: options.to ?? parent.from });
			delivery = enqueueDelivery(root, {
				messageId: message.messageId,
				...(intent === undefined ? {} : { target: intent }),
				mode: options.mode
			});
		}
		emit({ message, delivery }, options, `${renderMessage(message)}${delivery ? `\ndelivery ${renderDelivery(delivery)}` : ""}`);
	},

	deliver(root, { options, positionals }) {
		const intent = routingIntent(options);
		const delivery = enqueueDelivery(root, {
			messageId: positionals[0] ?? String(options.message ?? ""),
			...(intent === undefined ? {} : { target: intent }),
			mode: options.mode,
			deliveryId: options["delivery-id"]
		});
		emit(delivery, options, renderDelivery(delivery));
	},

	messages(root, { options }) {
		const messages = listMessages(root);
		if (options.json === true) emit(messages, options);
		else process.stdout.write(messages.length === 0 ? "(no messages)\n" : `${messages.map(renderMessage).join("\n\n")}\n`);
	},

	message(root, { options, positionals }) {
		const message = getMessage(root, positionals[0] ?? "");
		if (!message) throw new Error(`harnessmux: unknown messageId ${JSON.stringify(positionals[0])}`);
		emit(message, options, renderMessage(message));
	},

	thread(root, { options, positionals }) {
		const threadId = positionals[0] ?? String(options.thread ?? "");
		const messages = listMessages(root).filter((message) => message.threadId === threadId);
		emit({ binding: getBinding(root, threadId), messages }, options, messages.map(renderMessage).join("\n\n") || "(empty thread)");
	},

	endpoint(root, { options }) {
		const endpoint = registerEndpoint(root, {
			actor: options.actor ?? "dsh",
			endpointId: options.id ?? String(options.endpoint ?? ""),
			transport: options.transport,
			sessions: typeof options.sessions === "string" ? options.sessions.split(",").map((item) => item.trim()).filter(Boolean) : undefined
		});
		emit(endpoint, options, `endpoint ${endpoint.endpointId} (${endpoint.actor}) sessions=${endpoint.sessions.join(",") || "-"}`);
	},

	endpoints(root, { options }) {
		const endpoints = listEndpoints(root);
		emit(endpoints, options, endpoints.map((entry) => `${entry.endpointId} actor=${entry.actor} transport=${entry.transport} sessions=${entry.sessions.join(",") || "-"}`).join("\n") || "(no endpoints)");
	},

	bind(root, { options, positionals }) {
		const binding = bindThread(root, {
			threadId: positionals[0] ?? String(options.thread ?? ""),
			endpointId: options.endpoint ?? String(options.id ?? ""),
			sessionId: options.session,
			mode: options.mode
		});
		emit(binding, options, `bound ${binding.threadId} -> ${binding.endpointId}${binding.sessionId ? `#${binding.sessionId}` : ""} mode=${binding.mode}`);
	},

	bindings(root, { options }) {
		const bindings = listBindings(root);
		emit(bindings, options, bindings.map((entry) => `${entry.threadId} -> ${entry.endpointId}${entry.sessionId ? `#${entry.sessionId}` : ""} mode=${entry.mode}`).join("\n") || "(no bindings)");
	},

	inbox(root, { options }) {
		const { deduplicated, expired } = reconcile(root, { now: options.now ? Number(options.now) : undefined });
		const actor = typeof options.actor === "string" ? options.actor : undefined;
		const endpoints = listEndpoints(root).filter((endpoint) => (actor ? endpoint.actor === actor : true));
		const endpointIds = new Set(endpoints.map((endpoint) => endpoint.endpointId));
		const queued = listDeliveries(root, "queued").filter((delivery) => {
			if (options.unrouted === true) return delivery.target === null;
			if (delivery.target === null) return false;
			if (actor && !endpointIds.has(delivery.target.endpointId)) return false;
			if (typeof options.session === "string" && delivery.target.sessionId !== options.session) return false;
			return true;
		});
		const payload = { queued, reconciled: { deduplicated, expired } };
		if (options.json === true) emit(payload, options);
		else {
			const reconciledNote = deduplicated.length + expired.length > 0 ? `(reconciled: ${deduplicated.length} deduplicated, ${expired.length} lease-expired)\n` : "";
			process.stdout.write(`${reconciledNote}${queued.length === 0 ? "(no queued deliveries)\n" : `${queued.map(renderDelivery).join("\n")}\n`}`);
		}
	},

	claim(root, { options, positionals }) {
		const result = claimDelivery(root, positionals[0] ?? String(options.delivery ?? ""), {
			owner: options.owner,
			leaseMs: options["lease-ms"] ? Number(options["lease-ms"]) : undefined,
			allowUnrouted: options["allow-unrouted"] === true
		});
		emit(result, options, result.claimed ? `claimed ${result.claim.deliveryId} owner=${result.claim.claimOwner} attempt=${result.claim.attempt} leaseUntil=${result.claim.leaseUntil}` : `not claimed: ${result.reason}`);
		if (!result.claimed) process.exitCode = 3;
	},

	ack(root, { options, positionals }) {
		const result = ackDelivery(root, positionals[0] ?? String(options.delivery ?? ""), { owner: options.owner, note: options.note });
		emit(result, options, result.acked ? `acked ${positionals[0] ?? options.delivery}` : `not acked: ${result.reason}`);
		if (!result.acked) process.exitCode = 3;
	},

	release(root, { options, positionals }) {
		const result = releaseDelivery(root, positionals[0] ?? String(options.delivery ?? ""), { reason: options.reason });
		emit(result, options, result.released ? `released ${positionals[0] ?? options.delivery} (attempt=${result.attempt})` : `not released: ${result.reason}`);
		if (!result.released) process.exitCode = 3;
	},

	reconcile(root, { options }) {
		const result = reconcile(root, { now: options.now ? Number(options.now) : undefined });
		emit(result, options, `deduplicated=${result.deduplicated.length} expired=${result.expired.length}`);
	},

	verify(root, { options }) {
		const report = verifyInvariants(root);
		if (options.json === true) emit(report, options);
		else process.stdout.write(`${report.ok ? "OK" : "VIOLATIONS"} pending=${report.pending} claimed=${report.claimed} acked=${report.acked}\n${report.violations.map((line) => `  - ${line}`).join("\n")}${report.violations.length ? "\n" : ""}`);
		if (!report.ok) process.exitCode = 4;
	},

	status(root, { options }) {
		const status = bridgeStatus(root);
		emit(status, options, Object.entries(status).filter(([key]) => key !== "root").map(([key, value]) => `${key}=${value}`).join(" "));
	},

	policy(root, { options }) {
		if (options["lease-ms"] || options["audit-retention-days"] || options["audit-enabled"] !== undefined || options.mode) {
			const patch = {};
			if (options["lease-ms"]) patch.leaseMs = Number(options["lease-ms"]);
			if (options.mode) patch.defaultMode = String(options.mode);
			const manifest = readManifest(root);
			if (options["audit-retention-days"]) patch.audit = { ...manifest.audit, retentionDays: Number(options["audit-retention-days"]) };
			if (options["audit-enabled"] !== undefined) patch.audit = { ...(patch.audit ?? manifest.audit), enabled: options["audit-enabled"] !== "false" };
			emit(writeManifest(root, patch), options);
			return;
		}
		emit(readManifest(root), options);
	},

	gc(root, { options }) {
		const result = gc(root, { now: options.now ? Number(options.now) : undefined });
		emit(result, options, `removed=${result.removed.length} kept=${result.kept}`);
	},

	state(root, { options, positionals }) {
		const delivery = getDelivery(root, positionals[0] ?? "");
		if (!delivery) throw new Error(`harnessmux: unknown deliveryId ${JSON.stringify(positionals[0])}`);
		emit(delivery, options, renderDelivery(delivery));
	},

	/**
	 * Import a v1 bridge into this v2 root.
	 *
	 * Historical semantics are preserved: `inbox/` becomes a pending (unrouted)
	 * delivery, `read/` becomes a `legacy-consumed` message with **no** ack, and
	 * `log/`-only copies are imported with no delivery. A conflict between v1's
	 * non-transactional copies aborts the whole migration.
	 */
	migrate(root, { options }) {
		const source = typeof options.source === "string" ? options.source : "";
		if (!source) throw new Error("harnessmux: migrate needs --source <v1 bridge root>");
		const report = migrateV1({ source, target: root, dryRun: options["dry-run"] === true });
		emit(report, options, [
			`${report.ok ? "OK" : report.reason}${report.dryRun ? " (dry-run)" : ""}`,
			`messages: new=${report.counts.newMessages} existing=${report.counts.existingMessages}`,
			`deliveries: new=${report.counts.newDeliveries} existing=${report.counts.existingDeliveries} (all unrouted: v1 had no routing)`,
			`historical: legacy-consumed=${report.counts.legacyConsumed} audit-only=${report.counts.auditOnly}`,
			...(report.conflicts.length > 0 ? [`conflicts:\n  ${report.conflicts.join("\n  ")}`] : []),
			...(report.unreadable.length > 0 ? [`unreadable:\n  ${report.unreadable.join("\n  ")}`] : [])
		].join("\n"));
		if (!report.ok) process.exitCode = 5;
	}
};

const USAGE = `harnessmux v2

  message layer
    send    --from A [--to B] --topic T [--kind K] [--body TEXT | --body-file FILE|-]
            [--endpoint ID] [--session ID] [--mode advisory|delegated] [--no-deliver] [--no-route]
    reply   <messageId> [--from A] [--body TEXT | --body-file FILE|-] [--endpoint ID] [--mode M]
    messages | message <messageId> | thread <threadId>

  routing layer
    endpoint  --id ID --actor A [--transport T] [--sessions a,b]
    endpoints
    bind      <threadId> --endpoint ID [--session ID] [--mode advisory|delegated]
    bindings

  delivery layer
    deliver <messageId> [--to A] [--endpoint ID] [--session ID] [--delivery-id ID] [--no-route]
    inbox   [--actor A] [--session ID] [--unrouted]      (runs reconcile first)
    claim   <deliveryId> [--owner O] [--lease-ms N] [--allow-unrouted]
    ack     <deliveryId> [--owner O] [--note TEXT]
    release <deliveryId> [--reason TEXT]
    state   <deliveryId>
    reconcile [--now MS] | verify | status

  housekeeping
    init | root | policy [--lease-ms N] [--mode M] [--audit-retention-days N] [--audit-enabled true|false] | gc

Global: --root PATH   --json
Exit codes: 0 ok, 1 usage/error, 3 delivery state conflict, 4 invariant violation.
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
