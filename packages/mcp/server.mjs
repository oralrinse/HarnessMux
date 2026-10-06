/**
 * HarnessMux MCP server: the shared client-facing tool layer.
 *
 * This is the surface every MCP-capable client uses — Codex, Claude Code, Cursor,
 * VS Code/Copilot, or anything else that speaks MCP. It owns **no** mailbox logic:
 * every tool calls into `packages/core/core-v2.mjs`, so the protocol semantics stay
 * in one place and a client can never see a different meaning of `ack`, delivery,
 * lease, or binding.
 *
 * Transport: stdio, newline-delimited JSON-RPC 2.0, as the MCP stdio transport
 * specifies. Why hand-rolled instead of the official SDK: the SDK pulls an HTTP
 * stack (express, hono, ajv, jose) for transports this layer does not offer, while
 * the stdio surface is tiny and stable. That trade is recorded in
 * docs/adr/0001-mcp-server-transport.md and can be revisited if Streamable HTTP is
 * ever needed.
 *
 * Entry: `node packages/mcp/server.mjs --root <bridge>` (or HARNESSMUX_DIR).
 *
 * @module harnessmux/mcp
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as core from "../core/core-v2.mjs";

/** Protocol revision this server implements. */
export const PROTOCOL_VERSION = "2024-11-05";

/** Server identity reported in `initialize`. */
export const SERVER_INFO = { name: "harnessmux", version: "0.1.0", title: "HarnessMux" };

/** The actor this client speaks as when none was configured. */
const DEFAULT_ACTOR = process.env.HARNESSMUX_ACTOR?.trim() || "client";

/** JSON-RPC error codes from the MCP specification. */
const RPC = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603
};

/** A tool-level failure the model should see as text, not as a transport error. */
class ToolError extends Error {}

const root = () => core.resolveBridgeRoot(process.env.HARNESSMUX_DIR ?? undefined);

/** Render a message for the model. */
function renderMessage(message, delivery) {
	const head = `[${message.messageId}] ${message.createdAt} ${message.from} (${message.kind}) thread=${message.threadId} topic=${message.topic}`;
	const where = delivery ? `\ndelivery=${delivery.deliveryId} target=${delivery.target ? targetLabel(delivery.target) : "UNROUTED (awaiting a binding)"} mode=${delivery.mode}` : "";
	return `${head}${message.replyTo ? ` replyTo=${message.replyTo}` : ""}${where}\n${message.body}`;
}

/** Human-readable target. */
function targetLabel(target) {
	return `${target.actor}${target.endpointId ? `@${target.endpointId}` : ""}${target.sessionId ? `#${target.sessionId}` : ""}`;
}

/**
 * The tool roster.
 *
 * Each entry declares a JSON Schema (what the client validates against) and a
 * handler (what actually runs). `outputSchema` is advertised where a client can use
 * it; the text content is always present so every client has something to show.
 */
export const TOOLS = [
	{
		name: "send_message",
		title: "Send a message to the harness",
		description: "Create a message on a thread and hand it to a receiver. The thread's binding decides where it goes; an unbound thread stays queued as awaitingBinding until something is bound to it.",
		inputSchema: {
			type: "object",
			properties: {
				body: { type: "string", description: "Markdown body of the message." },
				topic: { type: "string", description: "Thread topic. A new topic starts a new thread." },
				thread_id: { type: "string", description: "Continue an existing thread instead of starting one." },
				kind: { type: "string", enum: ["instruction", "question", "answer", "report", "note"], description: "Defaults to note." },
				to: { type: "string", description: "Target actor when delivering directly, e.g. dsh." },
				endpoint_id: { type: "string", description: "Explicit target endpoint; overrides the binding." },
				session_id: { type: "string", description: "Explicit target session; overrides the binding." },
				mode: { type: "string", enum: ["advisory", "delegated"], description: "Trust mode for the delivery." },
				expect_reply: { type: "boolean", description: "Mark the message as waiting for an answer." }
			},
			required: ["body"],
			additionalProperties: false
		},
		handler(args) {
			const bridge = root();
			const body = String(args.body ?? "").trim();
			if (!body) throw new ToolError("body must not be empty");
			const message = core.postMessage(bridge, {
				from: typeof args.from === "string" && args.from.trim() ? args.from.trim() : DEFAULT_ACTOR,
				topic: args.topic,
				threadId: args.thread_id,
				kind: args.kind,
				body
			});
			const explicit = args.endpoint_id !== undefined || args.session_id !== undefined
				? { actor: typeof args.to === "string" && args.to.trim() ? args.to.trim() : "dsh", ...(args.endpoint_id ? { endpointId: args.endpoint_id } : {}), ...(args.session_id ? { sessionId: args.session_id } : {}) }
				: undefined;
			const delivery = core.enqueueDelivery(bridge, {
				messageId: message.messageId,
				...(explicit === undefined ? {} : { target: explicit }),
				mode: args.mode
			});
			return {
				text: `sent ${renderMessage(message, delivery)}${args.expect_reply === true ? "\n(expects a reply)" : ""}`,
				structured: { messageId: message.messageId, threadId: message.threadId, deliveryId: delivery.deliveryId, target: delivery.target, mode: delivery.mode }
			};
		}
	},
	{
		name: "read_messages",
		title: "Read messages addressed to me",
		description: "List messages the harness delivered (or is waiting to deliver) to this client. Consumption belongs to the receiver, so this never marks anything as delivered.",
		inputSchema: {
			type: "object",
			properties: {
				to: { type: "string", description: "Actor to read for; defaults to this client's actor." },
				thread_id: { type: "string", description: "Restrict to one thread." },
				include_delivered: { type: "boolean", description: "Include deliveries that were already acked." }
			},
			additionalProperties: false
		},
		handler(args) {
			const bridge = root();
			const forActor = typeof args.to === "string" && args.to.trim() ? args.to.trim() : DEFAULT_ACTOR;
			const states = args.include_delivered === true ? ["queued", "claimed", "acked"] : ["queued", "claimed"];
			const rows = [];
			for (const state of states) {
				for (const delivery of core.listDeliveries(bridge, state)) {
					const message = core.getMessage(bridge, delivery.messageId);
					if (!message) continue;
					if (message.from === forActor) continue;
					if (args.thread_id && message.threadId !== args.thread_id) continue;
					rows.push({ state, delivery, message });
				}
			}
			if (rows.length === 0) return { text: "no messages are waiting", structured: { count: 0, messages: [] } };
			return {
				text: rows.map((row) => `(${row.state}) ${renderMessage(row.message, row.delivery)}`).join("\n\n"),
				structured: {
					count: rows.length,
					messages: rows.map((row) => ({ state: row.state, messageId: row.message.messageId, threadId: row.message.threadId, from: row.message.from, kind: row.message.kind, topic: row.message.topic, body: row.message.body }))
				}
			};
		}
	},
	{
		name: "reply_message",
		title: "Reply on a thread",
		description: "Answer a specific message. The reply keeps the parent's thread and topic, and is delivered back to the parent's sender.",
		inputSchema: {
			type: "object",
			properties: {
				message_id: { type: "string", description: "The message being answered." },
				body: { type: "string", description: "Markdown body of the reply." },
				kind: { type: "string", enum: ["answer", "report", "note"], description: "Defaults to answer." }
			},
			required: ["message_id", "body"],
			additionalProperties: false
		},
		handler(args) {
			const bridge = root();
			const parent = core.getMessage(bridge, String(args.message_id ?? ""));
			if (!parent) throw new ToolError(`no message with id ${JSON.stringify(args.message_id)}`);
			const body = String(args.body ?? "").trim();
			if (!body) throw new ToolError("body must not be empty");
			const message = core.postMessage(bridge, {
				from: DEFAULT_ACTOR,
				topic: parent.topic,
				threadId: parent.threadId,
				kind: args.kind ?? "answer",
				replyTo: parent.messageId,
				body
			});
			const delivery = core.enqueueDelivery(bridge, { messageId: message.messageId });
			return { text: `replied ${renderMessage(message, delivery)}`, structured: { messageId: message.messageId, deliveryId: delivery.deliveryId, target: delivery.target } };
		}
	},
	{
		name: "list_threads",
		title: "List threads",
		description: "Threads known to the bridge, with their message counts and whether a binding decides their destination.",
		inputSchema: {
			type: "object",
			properties: { limit: { type: "number", description: "Maximum threads to return (default 50)." } },
			additionalProperties: false
		},
		handler(args) {
			const bridge = root();
			const limit = Number.isFinite(args.limit) ? Number(args.limit) : 50;
			const byThread = new Map();
			for (const message of core.listMessages(bridge)) {
				const row = byThread.get(message.threadId) ?? { threadId: message.threadId, topic: message.topic, messages: 0, lastFrom: null, lastAt: null };
				row.messages += 1;
				if (!row.lastAt || message.createdAt > row.lastAt) {
					row.lastAt = message.createdAt;
					row.lastFrom = message.from;
				}
				byThread.set(message.threadId, row);
			}
			const bindings = new Map(core.listBindings(bridge).map((binding) => [binding.threadId, binding]));
			const threads = [...byThread.values()]
				.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
				.slice(0, limit)
				.map((row) => {
					const binding = bindings.get(row.threadId);
					return { ...row, bound: binding ? { endpointId: binding.endpointId, sessionId: binding.sessionId ?? null, mode: binding.mode } : null };
				});
			return {
				text: threads.length === 0
					? "no threads yet"
					: threads.map((thread) => `${thread.threadId}  messages=${thread.messages}  topic=${thread.topic}  ${thread.bound ? `→ ${thread.bound.endpointId}${thread.bound.sessionId ? `#${thread.bound.sessionId}` : ""} (${thread.bound.mode})` : "UNBOUND (awaiting a binding)"}`).join("\n"),
				structured: { count: threads.length, threads }
			};
		}
	},
	{
		name: "list_endpoints",
		title: "List receiver endpoints",
		description: "Receivers that registered themselves with the bridge, and the sessions each currently reports as live.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler() {
			const bridge = root();
			const endpoints = core.listEndpoints(bridge);
			return {
				text: endpoints.length === 0
					? "no receiver has registered yet"
					: endpoints.map((endpoint) => `${endpoint.endpointId} (actor=${endpoint.actor}, transport=${endpoint.transport}) live sessions: ${endpoint.sessions.length ? endpoint.sessions.join(", ") : "(none reported)"}`).join("\n"),
				structured: { count: endpoints.length, endpoints: endpoints.map(({ endpointId, actor, transport, sessions, updatedAt }) => ({ endpointId, actor, transport, sessions, updatedAt })) }
			};
		}
	},
	{
		name: "list_sessions",
		title: "List bindable sessions",
		description: "Every session any live receiver reports, so a human or client can choose one to bind. Listing is discovery only: the bridge never picks a target by itself.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler() {
			const bridge = root();
			const rows = [];
			for (const endpoint of core.listEndpoints(bridge)) {
				for (const sessionId of endpoint.sessions) rows.push({ endpointId: endpoint.endpointId, actor: endpoint.actor, sessionId });
			}
			return {
				text: rows.length === 0
					? "no live sessions are reported (a receiver publishes them while it runs)"
					: rows.map((row) => `${row.sessionId}  via ${row.endpointId} (${row.actor})`).join("\n"),
				structured: { count: rows.length, sessions: rows }
			};
		}
	},
	{
		name: "bind_thread",
		title: "Bind a thread to a session",
		description: "Decide where a thread's messages go. Until this exists, its deliveries stay queued as awaitingBinding — deliberately, so no session is ever chosen by guesswork.",
		inputSchema: {
			type: "object",
			properties: {
				thread_id: { type: "string", description: "Thread to bind." },
				endpoint_id: { type: "string", description: "Receiving endpoint." },
				session_id: { type: "string", description: "Session inside that endpoint." },
				mode: { type: "string", enum: ["advisory", "delegated"], description: "advisory treats input as context; delegated authorises work." }
			},
			required: ["thread_id", "endpoint_id"],
			additionalProperties: false
		},
		handler(args) {
			const bridge = root();
			const binding = core.bindThread(bridge, {
				threadId: String(args.thread_id ?? ""),
				endpointId: String(args.endpoint_id ?? ""),
				sessionId: args.session_id,
				mode: args.mode
			});
			return { text: `bound ${binding.threadId} → ${binding.endpointId}${binding.sessionId ? `#${binding.sessionId}` : ""} mode=${binding.mode}`, structured: binding };
		}
	},
	{
		name: "get_status",
		title: "Bridge status",
		description: "Counts, the awaiting-binding list, and the invariant report. Use it before claiming something is wrong.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler() {
			const bridge = root();
			const status = core.bridgeStatus(bridge);
			const invariants = core.verifyInvariants(bridge);
			return {
				text: [
					`root: ${status.root}`,
					`protocol: v2   messages=${status.messages} queued=${status.queued} claimed=${status.claimed} acked=${status.acked} bindings=${status.bindings} endpoints=${status.endpoints}`,
					`awaitingBinding=${JSON.stringify(invariants.awaitingBinding)}`,
					`invariants=${invariants.ok ? "ok" : `VIOLATIONS ${JSON.stringify(invariants.violations)}`}`
				].join("\n"),
				structured: { ...status, awaitingBinding: invariants.awaitingBinding, invariantsOk: invariants.ok, violations: invariants.violations }
			};
		}
	}
];

/** Look up a tool by exact name. */
function tool(name) {
	return TOOLS.find((entry) => entry.name === name) ?? null;
}

/**
 * Handle one JSON-RPC message.
 *
 * @param {object} message - a parsed JSON-RPC request or notification.
 * @returns {object|null} a response, or null for notifications.
 */
export function handle(message) {
	const { id, method, params } = message ?? {};
	const reply = (result) => ({ jsonrpc: "2.0", id, result });
	const fail = (code, text, data) => ({ jsonrpc: "2.0", id, error: { code, message: text, ...(data === undefined ? {} : { data }) } });
	if (typeof method !== "string") return fail(RPC.invalidRequest, "method must be a string");
	switch (method) {
		case "initialize":
			return reply({
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: SERVER_INFO,
				instructions: "HarnessMux connects this client to DeepSeek Harness. Use get_status first, list_sessions to see what can receive work, bind_thread to choose one, then send_message. An unbound thread never delivers — that is intentional."
			});
		case "notifications/initialized":
		case "notifications/cancelled":
			return null;
		case "ping":
			return reply({});
		case "tools/list":
			return reply({
				tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }))
			});
		case "tools/call": {
			const name = params?.name;
			const selected = typeof name === "string" ? tool(name) : null;
			if (!selected) return fail(RPC.invalidParams, `unknown tool ${JSON.stringify(name)}`);
			const args = params?.arguments ?? {};
			if (args === null || typeof args !== "object" || Array.isArray(args)) return fail(RPC.invalidParams, "arguments must be an object");
			try {
				const result = selected.handler(args);
				return reply({
					content: [{ type: "text", text: result.text }],
					...(result.structured === undefined ? {} : { structuredContent: result.structured }),
					isError: false
				});
			} catch (error) {
				// A tool-level failure is content the model can act on, not a broken
				// transport: reporting it as a JSON-RPC error would hide the reason from
				// the conversation.
				const text = error instanceof ToolError ? error.message : `${selected.name} failed: ${String(error?.message ?? error)}`;
				return reply({ content: [{ type: "text", text }], isError: true });
			}
		}
		default:
			if (id === undefined) return null;
			return fail(RPC.methodNotFound, `method not found: ${method}`);
	}
}

/**
 * Serve the stdio transport until stdin ends.
 *
 * @param {object} [streams] - injectable streams for tests.
 * @returns {Promise<void>} resolves when stdin closes.
 */
export async function serve(streams = {}) {
	const input = streams.input ?? process.stdin;
	const output = streams.output ?? process.stdout;
	const lines = createInterface({ input, crlfDelay: Infinity });
	for await (const line of lines) {
		const text = line.trim();
		if (!text) continue;
		let message;
		try {
			message = JSON.parse(text);
		} catch (error) {
			output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: RPC.parse, message: `parse error: ${String(error?.message ?? error)}` } })}\n`);
			continue;
		}
		const response = handle(message);
		if (response !== null) output.write(`${JSON.stringify(response)}\n`);
	}
}

// Run only when invoked directly, so tests can import `handle`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await serve();
}
