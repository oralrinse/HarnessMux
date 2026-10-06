/**
 * Mailbox core and CLI acceptance test.
 *
 * Exercises the protocol end to end against a throwaway bridge directory:
 * posting, listing, consuming, watermarks, replies, and the CLI surface itself.
 *
 * Run: node tests/mailbox.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	bridgeStatus,
	consumeMessage,
	ensureBridge,
	getCursor,
	getMessage,
	listMessages,
	pendingCount,
	postMessage,
	readMessages,
	resolveBridgeRoot,
	setCursor
} from "../lib/core.mjs";

const ROOT = join(import.meta.dirname, "..", "test-bridge");
const CLI = join(import.meta.dirname, "..", "lib", "mailbox.mjs");

/** Run the CLI against the test bridge. */
function cli(...args) {
	return execFileSync(process.execPath, [CLI, "--root", ROOT, ...args], { encoding: "utf8" }).trim();
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

// --- core: manifest and posting -------------------------------------------------
ensureBridge(ROOT);
assert.equal(bridgeStatus(ROOT).exists, true, "bridge manifest exists");

const first = postMessage(ROOT, { from: "codex", to: "dsh", topic: "build", kind: "instruction", body: "run the build", expectReply: true });
const second = postMessage(ROOT, { from: "codex", to: "dsh", topic: "build", body: "and the tests" });
assert.ok(first.id < second.id, "ids sort chronologically");
assert.equal(first.threadId, second.threadId, "same topic shares a thread");
assert.equal(pendingCount(ROOT, "dsh"), 2, "two pending messages for dsh");
assert.equal(pendingCount(ROOT, "codex"), 0, "nothing pending for codex");

// --- core: consume + watermark --------------------------------------------------
const read = readMessages(ROOT, { actor: "dsh" });
assert.equal(read.messages.length, 2, "read returns both messages");
assert.equal(read.messages[0].body, "run the build", "oldest first");
assert.equal(pendingCount(ROOT, "dsh"), 0, "read consumed them");
assert.equal(getCursor(ROOT, "dsh"), second.id, "watermark is the newest id");
assert.equal(bridgeStatus(ROOT).readTotal, 2, "both files moved to read/");

// --- core: watermark never moves backwards -------------------------------------
setCursor(ROOT, "dsh", first.id);
assert.equal(getCursor(ROOT, "dsh"), second.id, "a stale watermark is ignored");

// --- core: replies stay in the thread ------------------------------------------
const answer = postMessage(ROOT, { from: "dsh", to: "codex", topic: first.topic, threadId: first.threadId, replyTo: first.id, kind: "report", body: "build green" });
assert.equal(answer.replyTo, first.id, "reply references its parent");
assert.equal(listMessages(ROOT, { threadId: first.threadId }).length, 3, "thread holds parent, sibling, reply");

// --- core: unknown ids and peeks ------------------------------------------------
assert.equal(getMessage(ROOT, "does-not-exist"), null, "unknown id returns null");
assert.equal(consumeMessage(ROOT, "does-not-exist"), false, "consuming an unknown id is a no-op");
postMessage(ROOT, { from: "codex", to: "dsh", topic: "peek", body: "do not consume me" });
const peeked = readMessages(ROOT, { actor: "dsh", consume: false });
assert.equal(peeked.messages.length, 1, "peek returns the message");
assert.equal(pendingCount(ROOT, "dsh"), 1, "peek does not consume");

// --- core: validation -----------------------------------------------------------
assert.throws(() => postMessage(ROOT, { from: "codex", to: "dsh", body: "   " }), /non-empty body/u, "empty bodies are rejected");
assert.throws(() => postMessage(ROOT, { from: "bad actor!", to: "dsh", body: "x" }), /must be 1-32 characters/u, "invalid actor names are rejected");

// --- CLI: post / list / read / reply / status -----------------------------------
rmSync(ROOT, { recursive: true, force: true });
assert.match(cli("init"), /harnessmux ready/u, "cli init prints the root");
assert.match(cli("post", "--from", "codex", "--to", "dsh", "--topic", "cli test", "--kind", "question", "--body", "are you there?", "--expect-reply"), /codex -> dsh/u, "cli post renders the message");

const bodyFile = join(ROOT, "body.md");
writeFileSync(bodyFile, "body from a file", "utf8");
cli("post", "--from", "codex", "--to", "dsh", "--topic", "cli test", "--body-file", bodyFile);
assert.equal(JSON.parse(cli("list", "--to", "dsh", "--json")).length, 2, "cli list sees both messages");

const listed = JSON.parse(cli("list", "--to", "dsh", "--json"));
const replied = cli("reply", listed[0].id, "--body", "yes");
assert.match(replied, /dsh -> codex/u, "cli reply addresses the sender");
assert.match(replied, new RegExp(`replyTo=${listed[0].id}`, "u"), "cli reply references the parent");

const status = JSON.parse(cli("status", "--json"));
assert.equal(typeof status.pendingTotal, "number", "cli status is machine readable");
assert.equal(cli("read", "--actor", "dsh", "--peek"), cli("read", "--actor", "dsh", "--peek"), "peek is stable across calls");

// --- root resolution -----------------------------------------------------------
process.env.HARNESSMUX_DIR = ROOT;
assert.equal(resolveBridgeRoot(), ROOT, "HARNESSMUX_DIR wins over the cache");

console.log("mailbox.test.mjs: all assertions passed");
