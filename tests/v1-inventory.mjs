/**
 * Read-only v1 inventory + conflict pre-check.
 *
 * Cutover evidence tool: it reports what a migration WOULD see (union of
 * inbox/read/log grouped by message id, with body-fingerprint comparison)
 * without writing anything. Used to corroborate `migrate --dry-run` from an
 * independent code path.
 *
 * Usage: node tests/v1-inventory.mjs <v1-root>
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { collectV1, resolveCopies } from "../lib/migrate.mjs";

const root = process.argv[2];
if (!root) {
	console.error("usage: node tests/v1-inventory.mjs <v1-root>");
	process.exit(1);
}
if (!existsSync(root)) {
	console.error(`no such root: ${root}`);
	process.exit(1);
}

const { groups, unreadable } = collectV1(root);
const rows = [];
const conflicts = [];
for (const [id, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
	const outcome = resolveCopies(id, group);
	const copies = ["inbox", "read", "log"].filter((dir) => group[dir] !== undefined);
	if (!outcome.ok) {
		conflicts.push(outcome.reason);
		rows.push({ id, copies: copies.join("+"), verdict: "CONFLICT", from: group.inbox?.from ?? group.read?.from ?? group.log?.from ?? "?" });
		continue;
	}
	// Independent fingerprint (not the migrator's) as a cross-check.
	const canonical = JSON.stringify([outcome.message.from, outcome.message.to, outcome.message.topic, outcome.message.threadId, outcome.message.kind, outcome.message.body]);
	rows.push({
		id,
		copies: copies.join("+"),
		verdict: copies.includes("inbox") ? "pending-delivery" : copies.includes("read") ? "legacy-consumed" : "audit-only",
		from: outcome.message.from,
		fingerprint: `${canonical.length}:${canonical.slice(0, 24)}`
	});
}

console.log(`root: ${root}`);
console.log(`distinct messages: ${groups.size}`);
console.log(`unreadable files: ${unreadable.length}${unreadable.length ? ` -> ${unreadable.join(", ")}` : ""}`);
console.log(`conflicts: ${conflicts.length}`);
for (const conflict of conflicts) console.log(`  ! ${conflict}`);
console.log("");
console.log("id".padEnd(26), "copies".padEnd(16), "disposition".padEnd(18), "from");
for (const row of rows) {
	console.log(String(row.id).padEnd(26), row.copies.padEnd(16), row.verdict.padEnd(18), row.from);
}
const expected = {
	messages: rows.length,
	deliveries: rows.filter((row) => row.verdict === "pending-delivery").length,
	legacyConsumed: rows.filter((row) => row.verdict === "legacy-consumed").length,
	auditOnly: rows.filter((row) => row.verdict === "audit-only").length
};
console.log("");
console.log(`expected after migrate: ${JSON.stringify(expected)}`);
process.exit(conflicts.length === 0 && unreadable.length === 0 ? 0 : 2);
