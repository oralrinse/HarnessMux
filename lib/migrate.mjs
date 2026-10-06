/**
 * v1 → v2 migration.
 *
 * Governing rule (frozen by review):
 *   **historical state keeps historical semantics; only new state uses v2 semantics.**
 *
 * Concretely, and deliberately:
 *   - a v1 `inbox/` copy becomes an immutable v2 message **plus** a pending
 *     (unrouted) delivery — it was never handed to anyone;
 *   - a v1 `read/` copy becomes an immutable v2 message plus a `legacy-consumed`
 *     audit event — it does **NOT** become a v2 ACK, because v1 `read/` only ever
 *     proved "the mailbox moved the file", never "the host accepted it";
 *   - a v1 `log/`-only copy becomes an immutable v2 message with no delivery at
 *     all (audit import).
 *
 * Invariants this module must not break:
 *   - **Legacy ids are preserved verbatim.** Random/UUID ids are a *generation*
 *     strategy for new messages, never a reason to rewrite history: replyTo
 *     links, thread history, refs, and audit records all point at those ids.
 *   - **The three v1 copies were not transactional**, so the source is read as
 *     the *union* of inbox/read/log grouped by id, and any disagreement is a hard
 *     `MIGRATION_CONFLICT` — never "log wins", never "newest mtime wins".
 *   - **Idempotent and resumable.** Re-running creates nothing: message and
 *     delivery ids are journaled on first creation rather than re-derived.
 *
 * @module agent-bridge/migrate
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureBridge, enqueueDelivery, postMessage, writeManifest } from "./core-v2.mjs";

/** Journal path inside the bridge root. */
export const JOURNAL_FILE = join("migration", "v1-to-v2.json");

/** The v1 layout directories. */
const V1_DIRS = ["inbox", "read", "log"];

/** Read JSON or return null. */
function readJsonOrNull(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** List `*.json` names in a directory. */
function listJson(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort();
}

/** Write JSON atomically (temp file in the same directory, then rename). */
function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** The migration journal, or null. */
export function readJournal(root) {
	return readJsonOrNull(join(root, JOURNAL_FILE));
}

/**
 * Collect the union of v1 copies, grouped by message id.
 *
 * @param {string} source - the v1 bridge root.
 * @returns {{groups: Map<string, object>, unreadable: string[]}} grouped copies.
 */
export function collectV1(source) {
	const groups = new Map();
	const unreadable = [];
	for (const dir of V1_DIRS) {
		for (const entry of listJson(join(source, dir))) {
			const record = readJsonOrNull(join(source, dir, entry));
			if (record === null || typeof record.id !== "string") {
				unreadable.push(`${dir}/${entry}`);
				continue;
			}
			const group = groups.get(record.id) ?? {};
			group[dir] = record;
			groups.set(record.id, group);
		}
	}
	return { groups, unreadable };
}

/**
 * Compare one message's copies and produce the canonical record.
 *
 * @param {string} id - legacy message id.
 * @param {object} group - `{inbox?, read?, log?}`.
 * @returns {{ok: true, message: object} | {ok: false, reason: string}} the outcome.
 */
export function resolveCopies(id, group) {
	const copies = V1_DIRS.map((dir) => group[dir]).filter(Boolean);
	const fingerprint = (record) => JSON.stringify([
		record.from ?? null,
		record.to ?? null,
		record.topic ?? null,
		record.threadId ?? null,
		record.kind ?? null,
		record.body ?? null,
		record.replyTo ?? null,
		record.refs ?? null
	]);
	const expected = fingerprint(copies[0]);
	for (const copy of copies.slice(1)) {
		if (fingerprint(copy) !== expected) {
			return {
				ok: false,
				reason: `message ${id} has divergent copies (${V1_DIRS.filter((dir) => group[dir]).join(", ")}); refusing to guess which copy is authoritative`
			};
		}
	}
	const first = copies[0];
	return {
		ok: true,
		message: {
			id,
			createdAt: first.createdAt,
			from: first.from ?? "unknown",
			to: first.to ?? "dsh",
			topic: first.topic ?? "(no topic)",
			threadId: first.threadId,
			kind: first.kind ?? "note",
			body: first.body ?? "",
			replyTo: first.replyTo,
			refs: first.refs
		}
	};
}

/**
 * Migrate a v1 bridge into v2.
 *
 * @param {object} input - input.
 * @param {string} input.source - v1 bridge root.
 * @param {string} input.target - v2 bridge root.
 * @param {boolean} [input.dryRun] - plan only, write nothing.
 * @returns {object} the report (`ok`, counts, per-message dispositions, conflicts).
 */
export function migrate(input) {
	const { source, target } = input;
	const dryRun = input.dryRun === true;
	if (!existsSync(source)) throw new Error(`agent-bridge: no v1 bridge at ${source}`);
	const report = {
		ok: true,
		dryRun,
		source,
		target,
		sourceVersion: 1,
		targetVersion: 2,
		conflicts: [],
		unreadable: [],
		messages: [],
		counts: { newMessages: 0, existingMessages: 0, newDeliveries: 0, existingDeliveries: 0, legacyConsumed: 0, auditOnly: 0, pendingDelivery: 0 }
	};
	if (!dryRun) ensureBridge(target, { remember: false });
	const journal = readJournal(target) ?? {
		sourceVersion: 1,
		targetVersion: 2,
		startedAt: new Date().toISOString(),
		completedAt: null,
		messageMap: {},
		deliveryMap: {}
	};

	const { groups, unreadable } = collectV1(source);
	if (unreadable.length > 0) {
		report.unreadable = unreadable;
		return { ...report, ok: false, reason: "MIGRATION_UNREADABLE" };
	}

	// Pass 1: resolve everything first, so a conflict aborts before any write.
	const resolved = [];
	for (const [id, group] of groups) {
		const outcome = resolveCopies(id, group);
		if (!outcome.ok) {
			report.conflicts.push(outcome.reason);
			continue;
		}
		resolved.push({ id, message: outcome.message, inInbox: group.inbox !== undefined, wasRead: group.read !== undefined });
	}
	if (report.conflicts.length > 0) return { ...report, ok: false, reason: "MIGRATION_CONFLICT" };

	// Pass 2: immutable messages, then deliveries for inbox-only work.
	for (const item of resolved) {
		const { id, message, inInbox, wasRead } = item;
		const messageExists = existsSync(join(target, "messages", `${id}.json`));
		const disposition = inInbox ? "pending-delivery" : wasRead ? "legacy-consumed" : "audit-only";
		if (!dryRun && !messageExists) {
			postMessage(target, {
				from: message.from,
				topic: message.topic,
				threadId: message.threadId,
				kind: message.kind,
				replyTo: message.replyTo,
				refs: message.refs,
				body: message.body,
				messageId: id
			});
			journal.messageMap[id] = { disposition, migratedAt: new Date().toISOString() };
		}
		if (messageExists) report.counts.existingMessages += 1;
		else report.counts.newMessages += 1;

		if (!inInbox) {
			if (wasRead) report.counts.legacyConsumed += 1;
			else report.counts.auditOnly += 1;
			report.messages.push({ legacyId: id, disposition, legacyRecipient: message.to });
			continue;
		}

		// Journaled on first creation so a re-run never invents a new delivery.
		const deliveryId = journal.deliveryMap[id] ?? `migrated-${id}`;
		const deliveryExists = existsSync(join(target, "queue", `${deliveryId}.json`))
			|| existsSync(join(target, "claims", `${deliveryId}.json`))
			|| existsSync(join(target, "acks", `${deliveryId}.json`));
		if (!dryRun && !deliveryExists) {
			enqueueDelivery(target, {
				messageId: id,
				// v1 carried no endpoint/session routing, so v2 must not guess one:
				// the delivery waits for an explicit binding (frozen design §0.3.4).
				target: null,
				mode: "advisory",
				deliveryId
			});
			journal.deliveryMap[id] = deliveryId;
		}
		if (deliveryExists) report.counts.existingDeliveries += 1;
		else {
			report.counts.newDeliveries += 1;
			report.counts.pendingDelivery += 1;
		}
		report.messages.push({ legacyId: id, disposition, deliveryId, legacyRecipient: message.to });
	}

	if (!dryRun) {
		journal.completedAt = new Date().toISOString();
		writeJsonAtomic(join(target, JOURNAL_FILE), journal);
		writeManifest(target, { migratedFrom: { version: 1, source, at: journal.completedAt } });
		report.journal = journal;
	}
	return report;
}
