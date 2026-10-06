/**
 * v1 → v2 migration acceptance test.
 *
 * The rules under test are the ones that are easy to get wrong and expensive to
 * get wrong:
 *   - legacy ids survive verbatim (no UUID rewriting of history);
 *   - v1 `read/` never becomes a v2 ack (it only proved "the file moved");
 *   - inbox/read/log are read as a union, and divergence aborts;
 *   - re-running changes nothing (idempotent + journaled delivery ids);
 *   - migrated pending deliveries are unrouted (v1 had no routing).
 *
 * Run: node tests/migrate.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate, readJournal } from "../lib/migrate.mjs";
import { listDeliveries, listMessages, verifyInvariants } from "../lib/core-v2.mjs";

const V1_CLI = join(import.meta.dirname, "..", "lib", "mailbox.mjs");
const V2_CLI = join(import.meta.dirname, "..", "lib", "mailbox-v2.mjs");
const BASE = join(import.meta.dirname, "..", "test-bridge-migrate");
const V1 = join(BASE, "v1");
const V2 = join(BASE, "v2");

/** Reset both source and target roots. */
function reset() {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
			break;
		} catch (error) {
			if (attempt === 9) throw error;
		}
	}
	mkdirSync(BASE, { recursive: true });
}

/** Run the v1 CLI. */
function v1(...args) {
	return execFileSync(process.execPath, [V1_CLI, "--root", V1, ...args], { encoding: "utf8" }).trim();
}

/** Parse the first `[id]` from a v1 CLI line. */
function idOf(line) {
	const match = /^\[([^\]]+)\]/u.exec(line.trim());
	assert.ok(match, `no id in ${JSON.stringify(line)}`);
	return match[1];
}

/** Count `*.json` files in a v2 subdirectory. */
function count(dir) {
	const path = join(V2, dir);
	return existsSync(path) ? readdirSync(path).filter((entry) => entry.endsWith(".json")).length : 0;
}

// --- 1. inbox / read / log map to three different v2 outcomes -------------------
reset();
v1("init");
// Three v1 messages. v1 `read --limit 1` consumes the oldest by id, so the
// legacy-consumed one is predictable; the other two stay pending in inbox/.
const firstPosted = idOf(v1("post", "--from", "codex", "--to", "dsh", "--topic", "old work", "--body", "was moved by v1 read"));
const stillPending = idOf(v1("post", "--from", "codex", "--to", "dsh", "--topic", "pending work", "--body", "never handed over"));
const alsoPending = idOf(v1("post", "--from", "codex", "--to", "dsh", "--topic", "pending work 2", "--body", "also never handed over"));
v1("read", "--actor", "dsh", "--limit", "1");
assert.equal(existsSync(join(V1, "read", `${firstPosted}.json`)), true, "the oldest message was moved to read/");
assert.equal(existsSync(join(V1, "read", `${stillPending}.json`)), false, "the second message is still pending");

const plan = migrate({ source: V1, target: V2, dryRun: true });
assert.equal(plan.ok, true, `dry-run succeeds: ${JSON.stringify(plan.conflicts)}`);
assert.equal(plan.counts.newMessages, 3, "three v1 messages are imported");
assert.equal(plan.counts.newDeliveries, 2, "each still-pending inbox copy creates one delivery");
assert.equal(existsSync(join(V2, "messages")), false, "dry-run writes nothing");

const result = migrate({ source: V1, target: V2 });
assert.equal(result.ok, true);
assert.equal(result.counts.newMessages, 3, "three messages written");
assert.equal(result.counts.newDeliveries, 2, "two pending deliveries");
assert.equal(result.counts.legacyConsumed, 1, "one legacy-consumed message");
assert.equal(result.counts.auditOnly, 0, "no audit-only messages in this scenario");

// Legacy ids survive verbatim.
const messages = listMessages(V2);
assert.deepEqual(messages.map((message) => message.messageId).sort(), [firstPosted, stillPending, alsoPending].sort(), "legacy ids are preserved exactly");

// The inbox messages are pending; the read message is NOT an ack.
const pending = listDeliveries(V2, "queued");
assert.equal(pending.length, 2, "exactly two pending deliveries");
assert.deepEqual(pending.map((delivery) => delivery.messageId).sort(), [stillPending, alsoPending].sort(), "pending deliveries belong to the inbox copies");
assert.equal(pending.every((delivery) => delivery.target === null), true, "migrated deliveries are unrouted: v1 had no routing to preserve");
assert.equal(pending.every((delivery) => delivery.mode === "advisory"), true, "migrated deliveries default to advisory");
assert.equal(listDeliveries(V2, "acked").length, 0, "v1 read/ must never become a v2 ack");
assert.equal(existsSync(join(V2, "acks")), true, "the acks directory exists but stays empty");
assert.equal(count("acks"), 0, "no acks were fabricated");

// Journal records the dispositions.
const journal = readJournal(V2);
assert.equal(journal.messageMap[stillPending].disposition, "pending-delivery");
assert.equal(journal.messageMap[firstPosted].disposition, "legacy-consumed");
assert.equal(journal.deliveryMap[stillPending], `migrated-${stillPending}`, "the delivery id is journaled, not re-derived per run");

// Invariants hold; the migrated deliveries are legitimately awaiting a binding.
const report = verifyInvariants(V2);
assert.equal(report.ok, true, `invariants: ${report.violations.join("; ")}`);
assert.deepEqual(report.awaitingBinding.sort(), [`migrated-${alsoPending}`, `migrated-${stillPending}`].sort(), "the migrated deliveries wait for an explicit binding");

// --- 2. idempotency: a second run creates nothing ------------------------------
const second = migrate({ source: V1, target: V2 });
assert.equal(second.ok, true);
assert.equal(second.counts.newMessages, 0, "second run: no new messages");
assert.equal(second.counts.newDeliveries, 0, "second run: no new deliveries");
assert.equal(second.counts.existingMessages, 3, "second run: all messages already present");
assert.equal(second.counts.existingDeliveries, 2, "second run: both deliveries already present");
assert.equal(count("messages"), 3, "still three messages");
assert.equal(count("queue"), 2, "still two queued deliveries");
const third = migrate({ source: V1, target: V2 });
assert.equal(third.counts.newMessages + third.counts.newDeliveries, 0, "third run is also a no-op");

// --- 3. divergent copies abort the migration (MIGRATION_CONFLICT) --------------
reset();
v1("init");
const conflictId = idOf(v1("post", "--from", "codex", "--to", "dsh", "--topic", "conflict", "--body", "original body"));
v1("read", "--actor", "dsh");
// Corrupt one copy's body so the union disagrees.
const readPath = join(V1, "read", `${conflictId}.json`);
const divergent = JSON.parse(readFileSync(readPath, "utf8"));
divergent.body = "tampered body";
writeFileSync(readPath, `${JSON.stringify(divergent, null, 2)}\n`, "utf8");
const conflicted = migrate({ source: V1, target: V2 });
assert.equal(conflicted.ok, false, "divergence aborts");
assert.equal(conflicted.reason, "MIGRATION_CONFLICT");
assert.match(conflicted.conflicts.join(" "), /divergent copies/u);
assert.equal(existsSync(join(V2, "messages")), true, "aborting still leaves an initialised target");
assert.equal(count("messages"), 0, "nothing is imported when copies disagree");
assert.equal(count("queue"), 0, "no deliveries either");

// --- 4. unparsable legacy files abort with a named reason ----------------------
reset();
v1("init");
v1("post", "--from", "codex", "--to", "dsh", "--topic", "good", "--body", "fine");
writeFileSync(join(V1, "inbox", "broken.json"), "{ not json", "utf8");
const broken = migrate({ source: V1, target: V2 });
assert.equal(broken.ok, false);
assert.equal(broken.reason, "MIGRATION_UNREADABLE");
assert.deepEqual(broken.unreadable, ["inbox/broken.json"], "the unreadable file is named");

// --- 5. CLI surface and exit code ----------------------------------------------
reset();
v1("init");
v1("post", "--from", "codex", "--to", "dsh", "--topic", "cli migrate", "--body", "via cli");
const dry = execFileSync(process.execPath, [V2_CLI, "--root", V2, "migrate", "--source", V1, "--dry-run", "--json"], { encoding: "utf8" });
const dryReport = JSON.parse(dry);
assert.equal(dryReport.dryRun, true);
assert.equal(dryReport.counts.newMessages, 1);
const applied = JSON.parse(execFileSync(process.execPath, [V2_CLI, "--root", V2, "migrate", "--source", V1, "--json"], { encoding: "utf8" }));
assert.equal(applied.ok, true);
assert.equal(applied.counts.newDeliveries, 1, "one inbox message becomes one pending delivery");
// Remigrating via the CLI reports success with no new work.
const again = JSON.parse(execFileSync(process.execPath, [V2_CLI, "--root", V2, "migrate", "--source", V1, "--json"], { encoding: "utf8" }));
assert.equal(again.counts.newMessages + again.counts.newDeliveries, 0, "CLI re-run is a no-op");
// A conflict exits 5.
writeFileSync(join(V1, "log", "extra.json"), JSON.stringify({ id: "x", from: "codex", to: "dsh", body: "a" }), "utf8");
writeFileSync(join(V1, "read", "extra.json"), JSON.stringify({ id: "x", from: "codex", to: "dsh", body: "b" }), "utf8");
let conflictExit = 0;
try {
	execFileSync(process.execPath, [V2_CLI, "--root", V2, "migrate", "--source", V1, "--json"], { encoding: "utf8", stdio: "pipe" });
} catch (error) {
	conflictExit = error.status;
}
assert.equal(conflictExit, 5, "a migration conflict exits 5");

reset();
rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
console.log("migrate.test.mjs: all assertions passed");
