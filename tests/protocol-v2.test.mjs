/**
 * Protocol v2 acceptance test: state invariants and fault injection (T1–T15).
 *
 * The frozen design (DESIGN.md §0.3.5) defines completion as a set of state
 * invariants rather than a directory layout, so this file drives the v2 core
 * through the crash windows and concurrency cases that v1 got wrong.
 *
 * Run: node tests/protocol-v2.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ackDelivery,
	bindThread,
	bridgeStatus,
	claimDelivery,
	enqueueDelivery,
	ensureBridge,
	gc,
	getDelivery,
	getMessage,
	listDeliveries,
	listMessages,
	postMessage,
	readManifest,
	reconcile,
	registerEndpoint,
	releaseDelivery,
	verifyInvariants,
	writeManifest
} from "../lib/core-v2.mjs";

const ROOT = join(import.meta.dirname, "..", "test-bridge-v2");
/**
 * Reset the bridge root. Windows can hold a directory handle for a moment after
 * a write (indexer, antivirus), so removal is retried a few times.
 */
function fresh() {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
			break;
		} catch (error) {
			if (attempt === 9) throw error;
			// Busy handle: wait briefly and retry.
			const waitUntil = Date.now() + 50;
			while (Date.now() < waitUntil) { /* spin */ }
		}
	}
	mkdirSync(ROOT, { recursive: true });
	ensureBridge(ROOT);
}

/**
 * Post a message and queue one delivery.
 *
 * `options.target` semantics: omitted => the default session target;
 * `null` => explicitly unrouted; an object => that exact target.
 */
function seed(body = "do the thing", options = {}) {
	const message = postMessage(ROOT, { from: "codex", topic: options.topic ?? "work", kind: options.kind ?? "instruction", body });
	const target = Object.hasOwn(options, "target")
		? options.target
		: { actor: "dsh", endpointId: "dsh-desktop", sessionId: "session-a" };
	const delivery = enqueueDelivery(ROOT, {
		messageId: message.messageId,
		...(target === null ? {} : { target }),
		mode: options.mode
	});
	return { message, delivery };
}

/** Assert the v2 invariants and return the report. */
function expectOk(label) {
	const report = verifyInvariants(ROOT);
	assert.equal(report.ok, true, `${label}: invariants must hold — ${report.violations.join("; ")}`);
	return report;
}

// --- 0. baseline: message/delivery separation -----------------------------------
fresh();
{
	const { message, delivery } = seed();
	assert.notEqual(message.messageId, delivery.deliveryId, "D1: messageId ≠ deliveryId");
	assert.equal(delivery.messageId, message.messageId, "the delivery only references the message");
	assert.equal(existsSync(join(ROOT, "messages", `${message.messageId}.json`)), true);
	const stored = getMessage(ROOT, message.messageId);
	assert.equal(Object.hasOwn(stored, "target"), false, "D3: routing never lands in the immutable message");
	assert.equal(Object.hasOwn(stored, "mode"), false, "D4: trust mode never lands in the immutable message");
	assert.equal(delivery.mode, "advisory", "unbound deliveries default to advisory");
	expectOk("baseline");
}

// --- 1. routing: binding decides, never a guess (T7) ---------------------------
fresh();
{
	const { delivery } = seed("unbound work", { target: null, topic: "unbound thread" });
	assert.equal(delivery.target, null, "no binding and no explicit target => unrouted");
	const claim = claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main" });
	assert.equal(claim.claimed, false, "T7: an unrouted delivery must never be auto-claimed");
	assert.equal(claim.reason, "unrouted");
	assert.equal(listDeliveries(ROOT, "queued").length, 1, "it stays queued for an explicit binding");
	const report = verifyInvariants(ROOT);
	assert.deepEqual(report.awaitingBinding, [delivery.deliveryId], "T7: unrouted deliveries are reported as awaiting a binding, not as a violation");
	assert.equal(report.ok, true, "T7: waiting for a binding is a legal state");
	expectOk("T7 unrouted");
}
{
	registerEndpoint(ROOT, { actor: "dsh", endpointId: "dsh-desktop", transport: "in-process", sessions: ["session-a", "session-b"] });
	const message = postMessage(ROOT, { from: "codex", topic: "routed work", body: "after binding" });
	bindThread(ROOT, { threadId: message.threadId, endpointId: "dsh-desktop", sessionId: "session-a", mode: "delegated" });
	const delivery = enqueueDelivery(ROOT, { messageId: message.messageId });
	assert.deepEqual(delivery.target, { actor: "dsh", endpointId: "dsh-desktop", sessionId: "session-a" }, "the binding supplies the full target");
	assert.equal(delivery.mode, "delegated", "D4: the binding supplies the trust mode");
	const claim = claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:session-a" });
	assert.equal(claim.claimed, true, "a bound delivery is claimable");
	// Two live sessions on one endpoint must not change the choice: the binding decides.
	assert.equal(claim.claim.target.sessionId, "session-a", "T7: the bound session wins over any other live session");
	expectOk("binding");
}

// --- 2. claim → ack happy path --------------------------------------------------
fresh();
{
	const { delivery } = seed();
	const claim = claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main", leaseMs: 60_000 });
	assert.equal(claim.claimed, true);
	assert.equal(claim.claim.attempt, 1, "the first attempt is 1");
	assert.equal(getDelivery(ROOT, delivery.deliveryId).state, "claimed");
	const ack = ackDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main" });
	assert.equal(ack.acked, true, "D2: ack means the host accepted the hand-off");
	assert.equal(getDelivery(ROOT, delivery.deliveryId).state, "acked");
	assert.equal(listDeliveries(ROOT, "queued").length, 0, "invariant 2: nothing acked stays queued");
	assert.equal(listDeliveries(ROOT, "claimed").length, 0, "invariant 2: nothing acked stays claimed");
	expectOk("happy path");
}

// --- 3. two readers race one delivery (T6) -------------------------------------
fresh();
{
	const { delivery } = seed();
	const first = claimDelivery(ROOT, delivery.deliveryId, { owner: "reader-1" });
	const second = claimDelivery(ROOT, delivery.deliveryId, { owner: "reader-2" });
	assert.equal(first.claimed, true, "one claim wins");
	assert.equal(second.claimed, false, "T6: the other claim loses");
	assert.equal(second.reason, "lease-held");
	assert.equal(second.claim.claimOwner, "reader-1", "the winner owns the lease");
	assert.equal(listDeliveries(ROOT, "claimed").length, 1, "invariant 5: exactly one owner");
	expectOk("T6 concurrency");
}

// --- 4. crash window 1: queue → claim, then crash (T2) ------------------------
fresh();
{
	const { delivery } = seed();
	claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main", leaseMs: 1_000 });
	// Simulate the crash: the claim exists and its lease has passed, nothing else ran.
	const repaired = reconcile(ROOT, { now: Date.now() + 5_000 });
	assert.deepEqual(repaired.expired, [delivery.deliveryId], "T2: the expired claim is recovered");
	assert.equal(getDelivery(ROOT, delivery.deliveryId).state, "queued", "T2: the delivery returns to the queue");
	assert.equal(getDelivery(ROOT, delivery.deliveryId).attempt, 1, "T2: the attempt count is preserved, not lost");
	expectOk("T2");
}

// --- 5. crash window 2: claim → steer, then crash (T3) ------------------------
fresh();
{
	const { delivery } = seed();
	claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main", leaseMs: 60_000 });
	releaseDelivery(ROOT, delivery.deliveryId, { reason: "steer failed" });
	const requeued = getDelivery(ROOT, delivery.deliveryId);
	assert.equal(requeued.state, "queued", "T3: a failed hand-off returns to the queue");
	const second = claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main" });
	assert.equal(second.claim.attempt, 2, "T3: the retry is the same deliveryId, attempt 2");
	assert.equal(second.claim.messageId, delivery.messageId, "the retry still points at the same message");
	expectOk("T3");
}

// --- 6. crash window 3: ack lost after a successful steer (T4) ----------------
fresh();
{
	const { message, delivery } = seed();
	// The host took the message, then died before acking.
	claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main", leaseMs: 1_000 });
	reconcile(ROOT, { now: Date.now() + 5_000 });
	const redelivered = claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main" });
	assert.equal(redelivered.claimed, true, "T4: the delivery is re-delivered after a lost ack");
	assert.equal(redelivered.claim.deliveryId, delivery.deliveryId, "T4: the duplicate keeps the same deliveryId (consumer dedupes)");
	assert.equal(redelivered.claim.attempt, 2, "T4: the duplicate is visible as attempt 2");
	assert.equal(getMessage(ROOT, message.messageId).body, message.body, "T4: the body is never duplicated or mutated");
	assert.equal(listMessages(ROOT).length, 1, "T4: one message, however many attempts");
	expectOk("T4");
}

// --- 7. duplicate delivery of one message (T5) --------------------------------
fresh();
{
	const message = postMessage(ROOT, { from: "codex", topic: "fan out", body: "audit me" });
	const first = enqueueDelivery(ROOT, { messageId: message.messageId, target: { actor: "dsh", endpointId: "dsh-desktop" } });
	const second = enqueueDelivery(ROOT, { messageId: message.messageId, target: { actor: "audit", endpointId: "audit-log" } });
	assert.notEqual(first.deliveryId, second.deliveryId, "T5: two targets => two deliveries");
	assert.equal(listMessages(ROOT).length, 1, "T5: still one immutable message");
	ackDelivery(ROOT, first.deliveryId);
	assert.equal(getDelivery(ROOT, first.deliveryId).state, "acked");
	assert.equal(getDelivery(ROOT, second.deliveryId).state, "queued", "T5: acking one delivery leaves the other alone");
	// Reusing an established deliveryId must fail loudly rather than fork state.
	assert.throws(() => enqueueDelivery(ROOT, { messageId: message.messageId, deliveryId: first.deliveryId, target: { actor: "dsh" } }), /was already used/u);
	const retry = enqueueDelivery(ROOT, { messageId: message.messageId, target: { actor: "audit" } });
	assert.notEqual(retry.deliveryId, first.deliveryId, "a genuine retry gets a fresh deliveryId pointing at the same message");
	assert.equal(retry.messageId, message.messageId, "the retry references the unchanged message");
	expectOk("T5");
}

// --- 8. acked deliveries are terminal (invariant 2) ---------------------------
fresh();
{
	const { delivery } = seed();
	claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main" });
	ackDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main" });
	assert.equal(claimDelivery(ROOT, delivery.deliveryId).reason, "already-acked", "an acked delivery cannot be claimed again");
	assert.equal(releaseDelivery(ROOT, delivery.deliveryId).reason, "not-claimed", "an acked delivery cannot be released");
	assert.equal(ackDelivery(ROOT, delivery.deliveryId).acked, true, "acking twice is idempotent");
	assert.equal(listDeliveries(ROOT, "queued").length + listDeliveries(ROOT, "claimed").length, 0);
	expectOk("terminal ack");
}

// --- 9. owner guard -----------------------------------------------------------
fresh();
{
	const { delivery } = seed();
	claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main" });
	const foreign = ackDelivery(ROOT, delivery.deliveryId, { owner: "someone-else" });
	assert.equal(foreign.acked, false, "a non-owner cannot ack another claim");
	assert.equal(foreign.reason, "not-owner");
	expectOk("owner guard");
}

// --- 10. same-millisecond burst keeps every message (T8) ----------------------
fresh();
{
	const ids = new Set();
	for (let index = 0; index < 40; index += 1) {
		const message = postMessage(ROOT, { from: "codex", topic: "burst", body: `burst ${index}` });
		ids.add(message.messageId);
		enqueueDelivery(ROOT, { messageId: message.messageId, target: { actor: "dsh", endpointId: "dsh-desktop" } });
	}
	assert.equal(ids.size, 40, "T8: 40 distinct message ids");
	assert.equal(listDeliveries(ROOT, "queued").length, 40, "T8: 40 queued deliveries");
	// Drain them all; nothing may be skipped by any cursor-like rule (D5).
	let drained = 0;
	for (const delivery of listDeliveries(ROOT, "queued")) {
		const claim = claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main" });
		if (claim.claimed) {
			ackDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main" });
			drained += 1;
		}
	}
	assert.equal(drained, 40, "T8: every delivery is delivered exactly once");
	assert.equal(listDeliveries(ROOT, "acked").length, 40);
	expectOk("T8");
}

// --- 11. clock skew does not gate delivery (T9 / D5) -------------------------
fresh();
{
	const { message, delivery } = seed("time travel");
	// A future-dated message inserted after this one must not affect eligibility.
	postMessage(ROOT, { from: "codex", topic: "work", body: "from the future", messageId: "zzz-future" });
	const claim = claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main" });
	assert.equal(claim.claimed, true, "T9: eligibility is directory state, never an id/cursor comparison");
	assert.equal(listMessages(ROOT).find((entry) => entry.messageId === message.messageId).body, "time travel");
	expectOk("T9");
}

// --- 12. corrupt records are isolated (T10) ----------------------------------
fresh();
{
	const { delivery } = seed("survivor");
	writeFileSync(join(ROOT, "messages", "broken.json"), "{ this is not json", "utf8");
	writeFileSync(join(ROOT, "queue", "broken-delivery.json"), "{ nope", "utf8");
	const messages = listMessages(ROOT);
	assert.equal(messages.length, 1, "T10: the corrupt message is skipped, the good one survives");
	assert.equal(listDeliveries(ROOT, "queued").filter((record) => record.deliveryId === delivery.deliveryId).length, 1, "T10: the good delivery still lists");
	const report = verifyInvariants(ROOT);
	assert.equal(report.ok, false, "T10: corruption is reported as a violation, not swallowed");
	assert.match(report.violations.join(" "), /corrupt record/u);
	rmSync(join(ROOT, "queue", "broken-delivery.json"));
	rmSync(join(ROOT, "messages", "broken.json"));
	expectOk("T10 recovered");
}

// --- 13. stray temp files are inert (T11) ------------------------------------
fresh();
{
	const { delivery } = seed("inert temp");
	writeFileSync(join(ROOT, "queue", `${delivery.deliveryId}.json.tmp-999-1-abcdef`), "{}", "utf8");
	const inbox = listDeliveries(ROOT, "queued");
	assert.equal(inbox.length, 1, "T11: temp files are not deliveries");
	const claim = claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main" });
	assert.equal(claim.claimed, true, "T11: the real delivery is unaffected");
	expectOk("T11");
}

// --- 14. audit policy: write success cannot corrupt delivery state (T12) -----
fresh();
{
	writeManifest(ROOT, { audit: { enabled: true, retentionDays: 0, maxBytes: 10 } });
	const { delivery } = seed("audit me");
	assert.equal(getDelivery(ROOT, delivery.deliveryId).state, "queued", "T12: delivery state is the authority, audit is a side stream");
	const collected = gc(ROOT);
	assert.ok(collected.removed.length >= 0, "T12: gc runs without touching delivery state");
	assert.equal(getDelivery(ROOT, delivery.deliveryId).state, "queued", "T12: gc never removes delivery state");
	expectOk("T12");
}

// --- 15. bad input fails loudly, never silently dropped (T13) ----------------
fresh();
{
	const { delivery } = seed("still fine");
	assert.equal(getDelivery(ROOT, delivery.deliveryId).state, "queued");
	assert.throws(() => postMessage(ROOT, { from: "codex", body: "  " }), /non-empty body/u, "T13: an empty body is rejected");
	assert.throws(() => postMessage(ROOT, { from: "bad actor!", body: "x" }), /must be 1-64 characters/u, "T13: a bad actor name is rejected");
	assert.throws(() => enqueueDelivery(ROOT, { messageId: "no-such-message", target: { actor: "dsh" } }), /unknown messageId/u, "a delivery must reference a real message");
	assert.throws(() => bindThread(ROOT, { threadId: "t", endpointId: "bad endpoint!" }), /must be 1-64 characters/u, "T13: a bad endpoint name is rejected");
	assert.equal(getDelivery(ROOT, delivery.deliveryId).state, "queued", "T13: rejected input leaves state untouched");
	expectOk("T13");
}

// --- 16. plugin reload / restart recovery (T14, T15) -------------------------
fresh();
{
	registerEndpoint(ROOT, { actor: "dsh", endpointId: "dsh-desktop", sessions: ["session-a"] });
	const message = postMessage(ROOT, { from: "codex", topic: "restart", body: "survive me" });
	bindThread(ROOT, { threadId: message.threadId, endpointId: "dsh-desktop", sessionId: "session-a", mode: "delegated" });
	const delivery = enqueueDelivery(ROOT, { messageId: message.messageId });
	claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main", leaseMs: 1_000 });
	// "Restart": a fresh process only sees the files.
	const status = bridgeStatus(ROOT);
	assert.equal(status.version, 2, "the manifest is v2");
	assert.equal(status.bindings, 1, "T15: the binding survives a restart");
	assert.equal(status.claimed, 1, "T14: the in-flight claim is visible after a restart");
	const repaired = reconcile(ROOT, { now: Date.now() + 5_000 });
	assert.deepEqual(repaired.expired, [delivery.deliveryId], "T14: the stale claim is recovered after a restart");
	const again = claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:after-restart" });
	assert.equal(again.claimed, true, "T14: redelivery after a restart");
	assert.equal(again.claim.attempt, 2);
	ackDelivery(ROOT, delivery.deliveryId, { owner: "dsh:after-restart" });
	assert.equal(listDeliveries(ROOT, "acked").length, 1, "T14: the redelivery settles");
	expectOk("T14/T15");
}

// --- 17. reconcile repairs a split claim/queue record (invariant 1) ----------
fresh();
{
	const { delivery } = seed();
	claimDelivery(ROOT, delivery.deliveryId, { owner: "dsh:main", leaseMs: 60_000 });
	// A crash between "claim written" and "queue removed" leaves both.
	writeFileSync(join(ROOT, "queue", `${delivery.deliveryId}.json`), JSON.stringify({ deliveryId: delivery.deliveryId, messageId: delivery.messageId }), "utf8");
	const repaired = reconcile(ROOT);
	assert.deepEqual(repaired.deduplicated, [delivery.deliveryId], "invariant 1: the split state is repaired");
	assert.equal(getDelivery(ROOT, delivery.deliveryId).state, "claimed", "the claim wins during its lease");
	expectOk("split repair");
}

// --- 18. audit retention is configurable (R13) -------------------------------
fresh();
{
	writeManifest(ROOT, { audit: { enabled: true, retentionDays: 1, maxBytes: 1024 } });
	const auditDir = join(ROOT, "audit");
	writeFileSync(join(auditDir, "2000-01-01.jsonl"), "{\"old\":true}\n", "utf8");
	writeFileSync(join(auditDir, "2999-01-01.jsonl"), "{\"new\":true}\n", "utf8");
	const result = gc(ROOT);
	assert.deepEqual(result.removed, ["2000-01-01.jsonl"], "old audit days are removed");
	assert.equal(existsSync(join(auditDir, "2999-01-01.jsonl")), true, "recent audit days are kept");
	writeManifest(ROOT, { audit: { enabled: false, retentionDays: 1, maxBytes: 1024 } });
	const before = readdirSync(auditDir).length;
	postMessage(ROOT, { from: "codex", topic: "quiet", body: "no audit line" });
	assert.equal(readdirSync(auditDir).length, before, "audit can be switched off");
}

rmSync(ROOT, { recursive: true, force: true });
console.log("protocol-v2.test.mjs: all assertions passed (T1–T15 + invariants)");
