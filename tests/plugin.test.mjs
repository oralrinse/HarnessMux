/**
 * DSH plugin acceptance test.
 *
 * Runs the plugin's `apply()` against a mock Cordis context and a real bridge
 * directory, then asserts the four behaviours the bridge depends on: the
 * `mailbox` tool is registered and works in both directions, the prompt section
 * and session briefing are delivered, and unread mail wakes a running agent.
 *
 * Run: node tests/plugin.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..", "test-bridge");
process.env.HARNESSMUX_DIR = ROOT;

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const core = await import("../packages/core/core.mjs");
core.ensureBridge(ROOT);
core.postMessage(ROOT, { from: "codex", to: "dsh", topic: "wake me", kind: "instruction", body: "run the build and report back", expectReply: true });

/** A mock Cordis context recording everything the plugin registers. */
function mockContext() {
	const registered = [];
	const sections = [];
	const handlers = new Map();
	const injected = [];
	const steered = [];
	const agent = {
		id: "agent-test-1",
		status: "running",
		session: { header: { id: "session-test-1", cwd: ROOT } },
		inject: (message) => injected.push(message),
		steer: (message) => steered.push(message)
	};
	const effects = [];
	return {
		registered,
		sections,
		injected,
		steered,
		agent,
		handlers,
		/** Run every effect's disposer, exactly as the harness does on unload. */
		dispose: () => {
			for (const disposer of effects.reverse()) disposer();
		},
		ctx: {
			logger: { warn: () => {} },
			systemPrompt: { getSectionOrder: () => 5000, section: (value) => sections.push(value) },
			tools: { register: (value) => registered.push(value) },
			agents: { roots: () => [agent] },
			on: (event, handler) => handlers.set(event, handler),
			effect: (factory) => {
				const disposer = factory();
				if (typeof disposer === "function") effects.push(disposer);
			}
		}
	};
}

const plugin = await import(pathToFileURL(join(import.meta.dirname, "..", "packages", "receiver-dsh", "index.js")).href);
const mock = mockContext();
plugin.apply(mock.ctx, { bridgeRoot: ROOT, actor: "dsh", peer: "codex", autoWake: false });

/**
 * Call the tool and return its rendered text.
 *
 * The harness validates the value `execute` returns against the tool's output
 * schema and then renders it; this test enforces the same two steps so a
 * contract violation fails here instead of only inside a live harness.
 *
 * @param {object} tool - the registered tool definition.
 * @param {object} args - tool arguments.
 * @returns {Promise<string>} the rendered text.
 */
async function call(tool, args) {
	const contract = tool.output;
	assert.ok(contract && typeof contract.render === "function", "the tool declares an output contract");
	const produced = await tool.execute(args, { agent: mock.agent });
	const validate = (node, data, path) => {
		if (node.type === "object") {
			assert.equal(typeof data, "object", `${path} must be an object`);
			for (const key of node.required ?? []) assert.ok(Object.hasOwn(data, key), `${path}.${key} is required`);
			if (node.additionalProperties === false) {
				for (const key of Object.keys(data)) assert.ok(Object.hasOwn(node.properties ?? {}, key), `${path}.${key} is not declared`);
			}
			for (const [key, child] of Object.entries(node.properties ?? {})) if (Object.hasOwn(data, key)) validate(child, data[key], `${path}.${key}`);
			return;
		}
		if (node.type === "string") assert.equal(typeof data, "string", `${path} must be a string`);
		else if (node.type === "boolean") assert.equal(typeof data, "boolean", `${path} must be a boolean`);
		else if (node.type === "array") assert.ok(Array.isArray(data), `${path} must be an array`);
	};
	validate(contract.schema, produced, "value");
	const blocks = contract.render(args, produced);
	assert.ok(Array.isArray(blocks) && blocks.length > 0, "render returns content blocks");
	assert.equal(blocks[0].type, "text", "render returns text blocks");
	return blocks[0].text;
}

// 1. registration surface
assert.equal(plugin.name, "harnessmux", "plugin name matches the patch row");
assert.deepEqual(plugin.inject, ["tools", "systemPrompt", "agents"], "plugin declares its services (agents is required by the v2 pump)");
assert.equal(mock.registered.length, 1, "exactly one tool is registered");

// 1b. (the id invariant is asserted after the briefing is delivered, see below)

const tool = mock.registered[0];
assert.equal(tool.name, "mailbox");

// The registry stores what it is given: an uncompiled per-property spec leaves
// the provider-facing function schema without `type: "object"`, which the model
// API rejects on the first turn. Guard the compiled shape here.
assert.equal(tool.parameters.type, "object", "parameters are an object-rooted JSON Schema");
assert.equal(typeof tool.parameters.properties, "object", "parameters declare properties");
assert.ok(tool.parameters.properties.action, "the tool declares an action parameter");
assert.deepEqual(tool.parameters.required, ["action"], "action is the only required parameter");
for (const [name, schema] of Object.entries(tool.parameters.properties)) {
	assert.ok(typeof schema.type === "string", `parameter ${name} declares a JSON Schema type`);
	assert.equal(Object.hasOwn(schema, "required"), false, `parameter ${name} has no inline required marker`);
}
assert.ok(tool.output?.schema, "the tool declares an output schema");
assert.equal(typeof tool.output?.render, "function", "the tool declares an output renderer");

// 2. guidance + briefing
assert.equal(mock.sections.length, 1, "one prompt section is registered");
assert.match(mock.sections[0].text, /harnessmux mailbox/u);
const created = mock.handlers.get("agent/created");
assert.ok(created, "agent/created is handled");
await created({ agent: mock.agent });
assert.equal(mock.injected.length, 1, "the briefing is injected once");
assert.match(JSON.stringify(mock.injected[0]), /mailbox/u);

// 2b. every message this plugin hands to the host must carry an id.
//
// Real incident (2026-10-06): the literal fallback produced `{role, content, source}`
// with no `id`; the harness's session read path rejects a `user/message` without an
// identified message and then treats the whole stored session as corrupt. Five
// sessions were damaged, so the invariant is asserted here rather than trusted to the
// `dsh-llm` import — which does not resolve for a symlinked plugin, meaning the
// fallback is the path that actually runs in production.
{
	const produced = [...mock.injected, ...mock.steered];
	assert.ok(produced.length > 0, "there is a message to check");
	for (const message of produced) {
		assert.equal(typeof message.id, "string", "the message has a string id");
		assert.ok(message.id.length > 0, "the id is non-empty");
		assert.equal(message.role, "user", "the message is a user message");
		assert.equal(message.source?.kind, "harnessmux", "the message is stamped with its source");
	}
}

// 3. reading real mail through the tool
const read = await call(tool, { action: "read" });
assert.match(read, /run the build and report back/u, "read returns the peer body");
assert.equal(core.pendingCount(ROOT, "dsh"), 0, "read consumed the message");

// 4. sending back, and answering a specific message
const sent = await call(tool, { action: "send", body: "build is green", topic: "build report", kind: "report" });
assert.match(sent, /dsh -> codex/u, "send addresses the peer");
const peerInbox = core.listMessages(ROOT, { to: "codex", pendingOnly: true });
assert.equal(peerInbox.length, 1, "the peer sees exactly one pending message");
assert.equal(peerInbox[0].body, "build is green");

core.postMessage(ROOT, { from: "codex", to: "dsh", topic: "thread test", body: "question one" });
const parent = core.listMessages(ROOT, { to: "dsh", pendingOnly: true })[0];
const reply = await call(tool, { action: "reply", id: parent.id, body: "answer one" });
assert.match(reply, new RegExp(`replyTo=${parent.id}`, "u"), "reply references the parent id");
assert.equal(core.listMessages(ROOT, { threadId: parent.threadId }).length, 2, "the thread holds both messages");

// 5. get / status / done / unknown action
const got = await call(tool, { action: "get", id: parent.id });
assert.match(got, /question one/u, "get returns a stored message");
const status = await call(tool, { action: "status" });
assert.match(status, /"pendingTotal"/u, "status returns the bridge report");
const missing = await call(tool, { action: "reply", id: "nope", body: "x" });
assert.match(missing, /unknown message id/u, "an unknown reply target is reported, not thrown");
const unknown = await call(tool, { action: "sing" });
assert.match(unknown, /unknown mailbox action/u);
const noBody = await call(tool, { action: "send" });
assert.match(noBody, /needs a non-empty body/u, "send without a body is reported, not thrown");

// 6. auto-wake: unread mail steers a running agent, once per batch
const wakeMock = mockContext();
plugin.apply(wakeMock.ctx, { bridgeRoot: ROOT, actor: "dsh", peer: "codex", autoWake: true });
core.postMessage(ROOT, { from: "codex", to: "dsh", topic: "wake", body: "start the new task" });
const waitUntil = async (predicate, timeoutMs = 15_000) => {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
};
assert.equal(await waitUntil(() => wakeMock.steered.length > 0), true, "the watcher steers a running agent");
assert.match(JSON.stringify(wakeMock.steered[0]), /start the new task/u, "the steer carries the peer message");
const steerCount = wakeMock.steered.length;
await new Promise((resolve) => setTimeout(resolve, 500));
assert.equal(wakeMock.steered.length, steerCount, "the same batch is not steered twice");

// 7. disposal stops the watcher (no lingering timer keeps a harness process alive)
wakeMock.dispose();
const afterDispose = wakeMock.steered.length;
core.postMessage(ROOT, { from: "codex", to: "dsh", topic: "after dispose", body: "should not steer" });
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(wakeMock.steered.length, afterDispose, "a disposed watcher stops steering");

console.log("plugin.test.mjs: all assertions passed");
