/**
 * Protocol v2 CLI acceptance test.
 *
 * The core is covered by protocol-v2.test.mjs; this file drives the same state
 * machine through the command surface an operator or another agent actually
 * uses, including exit codes for state conflicts.
 *
 * Run: node tests/cli-v2.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "..", "packages", "cli", "mailbox-v2.mjs");
const ROOT = join(import.meta.dirname, "..", "test-bridge-v2-cli");

/**
 * Run the CLI and return `{code, stdout, stderr}`.
 *
 * @param {string[]} args - CLI arguments.
 * @returns {{code: number, stdout: string, stderr: string}} the result.
 */
function cli(...args) {
	try {
		const stdout = execFileSync(process.execPath, [CLI, "--root", ROOT, ...args], { encoding: "utf8" });
		return { code: 0, stdout: stdout.trim(), stderr: "" };
	} catch (error) {
		return {
			code: typeof error?.status === "number" ? error.status : 1,
			stdout: typeof error?.stdout === "string" ? error.stdout.trim() : "",
			stderr: typeof error?.stderr === "string" ? error.stderr.trim() : String(error?.message ?? error)
		};
	}
}

/** Parse a `--json` CLI response, surfacing stderr on failure. */
function json(...args) {
	const result = cli(...args, "--json");
	assert.equal(result.code, 0, `cli ${args.join(" ")} failed (code ${result.code}): ${result.stderr || result.stdout}`);
	return JSON.parse(result.stdout);
}

rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
mkdirSync(ROOT, { recursive: true });

// --- init and policy ------------------------------------------------------------
const init = cli("init");
assert.equal(init.code, 0, "init succeeds");
assert.match(init.stdout, /harnessmux v2 ready/u);
const policy = json("policy", "--lease-ms", "5000", "--mode", "advisory", "--audit-retention-days", "7");
assert.equal(policy.leaseMs, 5000, "policy sets the lease");
assert.equal(policy.audit.retentionDays, 7, "policy sets audit retention");

// --- routing layer --------------------------------------------------------------
const endpoint = json("endpoint", "--id", "dsh-desktop", "--actor", "dsh", "--sessions", "session-a,session-b");
assert.equal(endpoint.sessions.length, 2, "endpoint records its live sessions");
json("endpoint", "--id", "dsh-executor", "--actor", "dsh", "--transport", "acp");

// An unbound thread must stay unrouted, and `inbox` must not offer it.
const sent = json("send", "--from", "codex", "--to", "dsh", "--topic", "unbound topic", "--body", "do not guess my session", "--no-route");
assert.equal(sent.delivery.target, null, "an unbound thread queues an unrouted delivery");
const unroutedInbox = json("inbox", "--actor", "dsh");
assert.equal(unroutedInbox.queued.length, 0, "inbox never offers unrouted deliveries to an endpoint");
assert.deepEqual(unroutedInbox.queued, []);
const unroutedListing = json("inbox", "--unrouted");
assert.equal(unroutedListing.queued.length, 1, "unrouted deliveries are visible for explicit handling");

// --- bound thread routes to the bound session ----------------------------------
const boundMessage = json("send", "--from", "codex", "--topic", "bound topic", "--body", "bound work", "--no-deliver");
json("bind", boundMessage.message.threadId, "--endpoint", "dsh-desktop", "--session", "session-a", "--mode", "delegated");
const delivered = json("deliver", boundMessage.message.messageId);
assert.deepEqual(delivered.target, { actor: "dsh", endpointId: "dsh-desktop", sessionId: "session-a" }, "the binding routes the delivery");
assert.equal(delivered.mode, "delegated", "the binding carries the trust mode");

const inbox = json("inbox", "--actor", "dsh", "--session", "session-a");
assert.equal(inbox.queued.length, 1, "the bound delivery appears for its session only");
const otherSession = json("inbox", "--actor", "dsh", "--session", "session-b");
assert.equal(otherSession.queued.length, 0, "a different session does not see another session's mail");

// --- claim / ack ----------------------------------------------------------------
const deliveryId = inbox.queued[0].deliveryId;
const claimed = json("claim", deliveryId, "--owner", "dsh:session-a");
assert.equal(claimed.claimed, true, "claim succeeds");
assert.equal(claimed.claim.attempt, 1);
const rival = cli("claim", deliveryId, "--owner", "dsh:session-b");
assert.equal(rival.code, 3, "a losing claim exits 3 (state conflict)");
assert.match(rival.stdout, /lease-held/u, "and reports the held lease");

const wrongOwner = cli("ack", deliveryId, "--owner", "dsh:session-b");
assert.equal(wrongOwner.code, 3, "acking as a non-owner exits 3");
const acked = json("ack", deliveryId, "--owner", "dsh:session-a", "--note", "steered into session-a");
assert.equal(acked.acked, true, "the owner acks the hand-off");

// --- invariants hold after the happy path --------------------------------------
const verify = json("verify");
assert.equal(verify.ok, true, `invariants hold: ${verify.violations.join("; ")}`);
assert.equal(verify.acked, 1);
assert.equal(verify.awaitingBinding.length, 1, "the unrouted delivery is still awaiting a binding");

// --- reply inherits the thread and routes back to the sender -------------------
const reply = json("reply", boundMessage.message.messageId, "--body", "bound work done", "--endpoint", "dsh-desktop", "--session", "session-a");
assert.equal(reply.message.threadId, boundMessage.message.threadId, "the reply stays in the thread");
assert.equal(reply.message.replyTo, boundMessage.message.messageId, "the reply references its parent");
assert.equal(reply.delivery.target.actor, "codex", "the reply targets the parent's sender");

// --- release and re-claim keep the attempt history -----------------------------
// `release` is only legal for a held claim, so take the lease first.
json("claim", reply.delivery.deliveryId, "--owner", "dsh:session-a");
const released = json("release", reply.delivery.deliveryId, "--reason", "host-busy");
assert.equal(released.released, true, "a held claim can be released");
const reclaimed = json("claim", reply.delivery.deliveryId, "--owner", "codex:main");
assert.equal(reclaimed.claim.attempt, 2, "the retry is the same deliveryId at attempt 2");

// --- corrupt state is surfaced, not hidden ------------------------------------
const broken = json("state", reclaimed.claim.deliveryId);
assert.equal(broken.deliveryId, reply.delivery.deliveryId, "state reads a claimed delivery");
const missing = cli("state", "00000000-0000-0000-0000-000000000000");
assert.equal(missing.code, 1, "an unknown delivery exits 1");
const usage = cli("nonsense");
assert.equal(usage.code, 1, "an unknown command exits 1");

// --- status ---------------------------------------------------------------------
const status = json("status");
assert.equal(status.version, 2);
assert.equal(status.messages, 3, "three immutable messages: unbound, bound, and the reply");
assert.equal(status.acked, 1);
assert.equal(status.bindings, 1, "one thread binding");

rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
console.log("cli-v2.test.mjs: all assertions passed");
