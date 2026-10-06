/**
 * MCP contract tests.
 *
 * These pin what a *client* sees, not what the server happens to export:
 *   - the tool roster (names, input schemas, required arguments);
 *   - the JSON-RPC envelope for initialize / tools/list / tools/call;
 *   - that a tool-level failure comes back as `isError` content the model can read,
 *     never as a transport error;
 *   - that every tool acts on the same v2 state through the shared core and produces
 *     the same semantics the receiver relies on (immutable message, unrouted delivery,
 *     binding enforcement, invariants).
 *
 * Run: node tests/mcp-contract.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../packages/core/core-v2.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "hxmux-mcp-"));
process.env.HARNESSMUX_DIR = ROOT;
// The server reads its actor at load time, and otherwise falls back to an installed
// client adapter's recorded identity (`~/.codex/harnessmux.json`). Pin it before the
// import so this suite cannot depend on the state of the machine it runs on.
process.env.HARNESSMUX_ACTOR = "client";
const { handle, PROTOCOL_VERSION, SERVER_INFO, TOOLS } = await import("../packages/mcp/server.mjs");
core.ensureBridge(ROOT, { remember: false });

/** Call a JSON-RPC method and assert the envelope. */
function call(method, params, id = 1) {
	const response = handle({ jsonrpc: "2.0", id, method, params });
	assert.ok(response, `${method} must answer a request`);
	assert.equal(response.jsonrpc, "2.0", "jsonrpc version");
	assert.equal(response.id, id, "the response echoes the request id");
	return response;
}

/** Call a tool and assert it succeeded. */
function tool(name, args = {}, id = 10) {
	const response = call("tools/call", { name, arguments: args }, id);
	assert.equal(response.error, undefined, `${name} must not fail at the transport level: ${JSON.stringify(response.error)}`);
	assert.equal(response.result.isError, false, `${name} must not report a tool error: ${JSON.stringify(response.result.content)}`);
	assert.ok(Array.isArray(response.result.content) && response.result.content[0].type === "text", `${name} returns text content`);
	return response.result;
}

/** Call a tool expecting a tool-level error. */
function toolError(name, args = {}) {
	const response = call("tools/call", { name, arguments: args });
	assert.equal(response.error, undefined, `${name} must not surface as a transport error`);
	assert.equal(response.result.isError, true, `${name} must report isError`);
	return response.result.content[0].text;
}

// --- 1. handshake ---------------------------------------------------------------
{
	const init = call("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "contract-test", version: "1" } });
	assert.equal(init.result.protocolVersion, PROTOCOL_VERSION, "the server answers with its protocol revision");
	assert.deepEqual(init.result.serverInfo, SERVER_INFO, "server identity is stable");
	assert.equal(init.result.capabilities.tools.listChanged, false, "the tool list is static");
	assert.match(init.result.instructions, /bind_thread/u, "the handshake explains the binding rule");
	assert.equal(handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null, "notifications are not answered");
	const ping = call("ping", {});
	assert.deepEqual(ping.result, {}, "ping answers an empty result");
}

// --- 2. the roster a client sees ------------------------------------------------
{
	const listed = call("tools/list", {});
	const names = listed.result.tools.map((entry) => entry.name);
	const required = [
		"send_message", "read_messages", "reply_message", "list_threads",
		"list_endpoints", "list_sessions", "bind_thread", "get_status"
	];
	for (const name of required) assert.ok(names.includes(name), `the roster exposes ${name}`);
	assert.equal(names.length, TOOLS.length, "the roster has no unnamed extras");
	for (const entry of listed.result.tools) {
		assert.equal(typeof entry.description, "string", `${entry.name} has a description`);
		assert.ok(entry.description.length > 20, `${entry.name} describes itself for a model`);
		assert.equal(entry.inputSchema.type, "object", `${entry.name} declares an object input schema`);
		assert.equal(entry.inputSchema.additionalProperties, false, `${entry.name} rejects unknown arguments`);
		for (const [key, schema] of Object.entries(entry.inputSchema.properties ?? {})) {
			assert.equal(typeof schema.type, "string", `${entry.name}.${key} declares a JSON Schema type`);
		}
		for (const key of entry.inputSchema.required ?? []) {
			assert.ok(entry.inputSchema.properties?.[key], `${entry.name} requires a declared property ${key}`);
		}
	}
	// The transport-visible roster must not leak handler internals.
	for (const entry of listed.result.tools) assert.equal(Object.hasOwn(entry, "handler"), false, "handlers stay server-side");
}

// --- 3. an empty bridge answers truthfully --------------------------------------
{
	const status = tool("get_status", {});
	assert.match(status.content[0].text, /protocol: v2/u, "status names the protocol");
	assert.match(status.content[0].text, /messages=0/u, "status counts nothing yet");
	assert.match(status.content[0].text, /invariants=ok/u, "a fresh bridge satisfies its invariants");
	assert.equal(JSON.parse(JSON.stringify(status.structuredContent)).invariantsOk, true, "structured content carries the invariant verdict");

	assert.match(tool("list_endpoints", {}).content[0].text, /no receiver has registered/u, "no endpoints yet");
	assert.match(tool("list_sessions", {}).content[0].text, /no live sessions/u, "no sessions yet");
	assert.match(tool("list_threads", {}).content[0].text, /no threads yet/u, "no threads yet");
	assert.match(tool("read_messages", {}).content[0].text, /no messages are waiting/u, "nothing waiting");
}

// --- 4. send → unbound stays queued (no guessing) -------------------------------
let sent;
{
	sent = tool("send_message", { body: "please run the suite", topic: "contract thread", kind: "instruction" });
	const structured = sent.structuredContent;
	assert.equal(typeof structured.messageId, "string", "send returns the message id");
	assert.equal(typeof structured.deliveryId, "string", "send returns the delivery id");
	assert.equal(structured.target, null, "an unbound thread produces an unrouted delivery");
	assert.match(sent.content[0].text, /UNROUTED/u, "the model is told it is unrouted, not silently queued");

	const delivery = core.getDelivery(ROOT, structured.deliveryId);
	assert.equal(delivery.state, "queued", "the delivery is queued");
	assert.equal(delivery.attempt, 0, "nothing has tried to deliver it");
	const message = core.getMessage(ROOT, structured.messageId);
	assert.equal(message.body, "please run the suite", "the body is stored verbatim");
	assert.equal(message.kind, "instruction", "the kind is stored");

	const report = core.verifyInvariants(ROOT);
	assert.equal(report.ok, true, `invariants hold: ${report.violations.join("; ")}`);
	assert.ok(report.awaitingBinding.includes(structured.deliveryId), "an unrouted delivery is awaitingBinding, not a violation");
}

// --- 5. discovery, binding, and the delivery that follows -----------------------
{
	core.registerEndpoint(ROOT, { actor: "dsh", endpointId: "dsh-endpoint", transport: "in-process", sessions: ["session-live"] });
	const endpoints = tool("list_endpoints", {});
	assert.match(endpoints.content[0].text, /dsh-endpoint/u, "the endpoint is listed");
	assert.match(endpoints.content[0].text, /session-live/u, "its live sessions are listed");

	const sessions = tool("list_sessions", {});
	assert.equal(sessions.structuredContent.count, 1, "one bindable session");
	assert.equal(sessions.structuredContent.sessions[0].sessionId, "session-live", "the session id is reported");

	const bound = tool("bind_thread", { thread_id: sent.structuredContent.threadId, endpoint_id: "dsh-endpoint", session_id: "session-live", mode: "delegated" });
	assert.equal(bound.structuredContent.mode, "delegated", "the binding carries the trust mode");

	// Binding is not retroactive: the earlier unrouted delivery stays as it was.
	assert.equal(core.getDelivery(ROOT, sent.structuredContent.deliveryId).target, null, "an existing unrouted delivery is not silently re-routed");

	// A new message on the bound thread routes to the session.
	const second = tool("send_message", { body: "second message", thread_id: sent.structuredContent.threadId });
	assert.equal(second.structuredContent.target.endpointId, "dsh-endpoint", "the binding decides the endpoint");
	assert.equal(second.structuredContent.target.sessionId, "session-live", "the binding decides the session");
	assert.equal(second.structuredContent.mode, "delegated", "the delivery inherits the binding's mode");

	const threads = tool("list_threads", {});
	assert.match(threads.content[0].text, /dsh-endpoint#session-live/u, "the bound thread reports where it goes");
	// A second, deliberately unbound thread is what proves the listing distinguishes them.
	tool("send_message", { body: "on a thread nobody bound", topic: "unbound thread" });
	const mixed = tool("list_threads", {}).structuredContent.threads;
	const boundRow = mixed.find((entry) => entry.threadId === sent.structuredContent.threadId);
	const unboundRow = mixed.find((entry) => entry.topic === "unbound thread");
	assert.notEqual(boundRow, undefined, "the bound thread is listed");
	assert.equal(boundRow.bound.endpointId, "dsh-endpoint", "its binding is reported structurally");
	assert.notEqual(unboundRow, undefined, "the unbound thread is listed");
	assert.equal(unboundRow.bound, null, "an unbound thread reports no binding");
	assert.match(tool("list_threads", {}).content[0].text, /UNBOUND \(awaiting a binding\)/u, "and the text says so explicitly");
}

// --- 6. read and reply are consistent with the receiver's semantics -------------
{
	const waiting = tool("read_messages", { to: "dsh" });
	const structured = waiting.structuredContent;
	assert.ok(structured.count >= 1, "the bound delivery is visible to its actor");
	const secondRow = structured.messages.find((entry) => entry.body === "second message");
	assert.notEqual(secondRow, undefined, "the routed message is listed");
	assert.equal(secondRow.from, "client", "messages are attributed to this client's actor");
	// Reading must not consume: the pump owns claim/ack.
	const stillQueued = core.listDeliveries(ROOT, "queued").map((entry) => entry.deliveryId);
	assert.ok(stillQueued.length >= 2, "read_messages leaves the queue untouched");

	const reply = tool("reply_message", { message_id: sent.structuredContent.messageId, body: "done" });
	assert.equal(core.getMessage(ROOT, reply.structuredContent.messageId).kind, "answer", "a reply defaults to kind answer");
	assert.equal(core.getMessage(ROOT, reply.structuredContent.messageId).replyTo, sent.structuredContent.messageId, "the reply references its parent");
	assert.equal(core.getMessage(ROOT, reply.structuredContent.messageId).threadId, sent.structuredContent.threadId, "the reply stays on the thread");
	// The thread is bound, so the binding decides — not the parent's own routing.
	assert.equal(reply.structuredContent.target.endpointId, "dsh-endpoint", "a bound thread routes the reply through its binding");
	assert.equal(reply.structuredContent.mode, "delegated", "the reply inherits the binding's mode");
}

// --- 6b. a reply follows its parent's route when no binding exists ---------------
// This is the conversation Codex actually has with a session: an explicitly addressed
// message with no thread binding. Without this, the second turn of that conversation
// silently became unrouted and the peer never heard back.
{
	const parent = tool("send_message", {
		body: "explicitly addressed, never bound",
		topic: "reply routing",
		endpoint_id: "dsh-endpoint",
		session_id: "session-live",
		mode: "delegated"
	});
	assert.equal(parent.structuredContent.target.sessionId, "session-live", "the parent carries an explicit target");
	assert.equal(core.listBindings(ROOT).some((entry) => entry.threadId === parent.structuredContent.threadId), false, "and the thread stays unbound");

	const reply = tool("reply_message", { message_id: parent.structuredContent.messageId, body: "answering without a binding" });
	assert.notEqual(reply.structuredContent.target, null, "the reply is routed, not left unrouted");
	assert.equal(reply.structuredContent.target.endpointId, "dsh-endpoint", "it reuses the parent's endpoint");
	assert.equal(reply.structuredContent.target.sessionId, "session-live", "it reuses the parent's session");
	assert.equal(reply.structuredContent.mode, "delegated", "and the parent's trust mode");
	assert.match(reply.content[0].text, /target=dsh@dsh-endpoint#session-live/u, "the model is told where it went");

	// A binding still outranks the parent's route once one exists.
	tool("bind_thread", { thread_id: parent.structuredContent.threadId, endpoint_id: "dsh-endpoint", session_id: "session-other", mode: "advisory" });
	const afterBinding = tool("reply_message", { message_id: parent.structuredContent.messageId, body: "now bound elsewhere" });
	assert.equal(afterBinding.structuredContent.target.sessionId, "session-other", "the binding wins over the inherited route");
	assert.equal(afterBinding.structuredContent.mode, "advisory", "and its mode wins too");

	// A reply whose parent was never routed anywhere stays unrouted rather than guessing.
	const orphan = tool("send_message", { body: "nobody addressed", topic: "orphan reply" });
	const orphanReply = tool("reply_message", { message_id: orphan.structuredContent.messageId, body: "no route to inherit" });
	assert.equal(orphanReply.structuredContent.target, null, "with no binding and no parent route, the reply waits unrouted");
	assert.match(orphanReply.content[0].text, /UNROUTED/u, "and says so plainly");
}

// --- 7. tool-level failures are content, not transport errors -------------------
{
	assert.match(toolError("send_message", { body: "   " }), /must not be empty/u, "an empty body is a tool error");
	assert.match(toolError("reply_message", { message_id: "does-not-exist", body: "x" }), /no message with id/u, "an unknown parent is a tool error");
	assert.match(toolError("bind_thread", { thread_id: "t", endpoint_id: "bad endpoint!" }), /must be 1-64 characters/u, "a bad endpoint name is a tool error");
	const unknown = call("tools/call", { name: "nope", arguments: {} });
	assert.equal(unknown.error.code, -32602, "an unknown tool is an invalid-params error");
	const notObject = call("tools/call", { name: "get_status", arguments: [] });
	assert.equal(notObject.error.code, -32602, "non-object arguments are rejected");
}

// --- 8. transport-level behaviour ------------------------------------------------
{
	const missing = call("no/such/method", {});
	assert.equal(missing.error.code, -32601, "an unknown method is method-not-found");
	assert.equal(handle({ jsonrpc: "2.0", method: "no/such/notification" }), null, "an unknown notification is ignored");

	// The stdio loop must answer line-delimited requests and ignore blank lines.
	const { serve } = await import("../packages/mcp/server.mjs");
	const { Readable, Writable } = await import("node:stream");
	const written = [];
	const input = Readable.from(["", `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} })}\n`, "not json\n", ""]);
	const output = new Writable({ write(chunk, _encoding, done) { written.push(chunk.toString("utf8")); done(); } });
	await serve({ input, output });
	const frames = written.join("").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(frames.length, 2, "one response per non-blank line, including the bad one");
	assert.ok(Array.isArray(frames[0].result.tools), "the roster arrives over stdio");
	assert.equal(frames[1].error.code, -32700, "unparsable input is a parse error");
}

// --- 9. the bridge is left the way the protocol describes ----------------------
{
	const report = core.verifyInvariants(ROOT);
	assert.equal(report.ok, true, `final invariants: ${report.violations.join("; ")}`);
	assert.equal(report.claimed, 0, "MCP calls never hold a claim");
	const status = tool("get_status", {});
	assert.match(status.content[0].text, /invariants=ok/u, "and the client can see that");
}

rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
console.log("mcp-contract.test.mjs: all assertions passed");
