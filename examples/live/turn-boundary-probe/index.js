/**
 * hx-probe — a read-only instrument for the HarnessMux turn-boundary investigation.
 *
 * It answers one question with evidence rather than inference: **what does a live
 * DeepSeek Harness session's own event list contain while a turn is running, and what
 * does each delivered follow-up actually produce?**
 *
 * It deliberately does not judge, decide, or fix anything. Every tick it copies the
 * raw events out of each live session and appends them to a JSONL file, tagged with
 * the source it read them from:
 *
 *   sessions/<id>.cache.jsonl   (the durable session log the receiver's gate reads)
 *   snapshotEvents()            (the projection snapshot the receiver's dispatch path reads)
 *
 * Both are dumped because the receiver reads one for the ownership gate and the other
 * for the dispatch baseline, and a disagreement between them is exactly the kind of
 * fact that has been guessed at rather than measured.
 *
 * Output is never truncated silently: `data` is passed through a bounded, cycle-safe
 * projection and the byte size of the original is recorded next to it.
 *
 * Mount it with a patch row:
 *
 *   - id: hx-probe
 *     name: '@local/hx-probe'
 *     config:
 *       out: '<absolute path>/probe.jsonl'
 *
 * @module @local/hx-probe
 */

import { appendFileSync } from "node:fs";

/** Cordis plugin name. */
export const name = "hx-probe";

/**
 * The only service this instrument needs.
 *
 * Declared as an array so Cordis defers `apply` until `agents` exists; property access
 * to an undeclared service throws, which is why the receiver itself declares this.
 */
export const inject = ["agents"];

/** Longest string kept for one field before it is cut and its length recorded. */
const MAX_STRING = 1_500;

/** Depth beyond which a nested value is replaced by its constructor name. */
const MAX_DEPTH = 6;

/**
 * Project an arbitrary value into something JSON-serializable and bounded.
 *
 * @param {unknown} value - the value.
 * @param {number} depth - current nesting depth.
 * @returns {unknown} the projection.
 */
function safe(value, depth = 0) {
	if (value === null || value === undefined) return value ?? null;
	const kind = typeof value;
	if (kind === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING})` : value;
	if (kind === "number" || kind === "boolean") return value;
	if (kind === "bigint") return String(value);
	if (kind === "function") return `[function ${value.name || "anonymous"}]`;
	if (kind === "symbol") return String(value);
	if (depth >= MAX_DEPTH) return `[${value?.constructor?.name ?? "object"} at depth ${depth}]`;
	if (Array.isArray(value)) return value.map((entry) => safe(entry, depth + 1));
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Error) return { __error: value.message };
	const out = {};
	for (const key of Object.keys(value)) out[key] = safe(value[key], depth + 1);
	return out;
}

/**
 * Read a session's events from one source, never throwing.
 *
 * Three sources are read because three candidates exist in the receiver for "where do turns
 * live", and a disagreement between them is the whole question:
 *
 *   `log`       — the array the receiver's ownership gate and dispatch baseline read.
 *   `snapshot`  — `snapshotEvents()`, the projection the receiver's log watcher prefers.
 *   `durable`   — the session's own append-only range (`seq` + `eventAt`), which is what the
 *                 shipped one-shot runner reads its final answer from.
 *
 * @param {object} session - the live session.
 * @param {"log"|"snapshot"|"durable"} source - which list to read.
 * @returns {{events: object[]|null, error: string|null}} the events, or why they could not be read.
 */
function readEvents(session, source) {
	try {
		if (source === "log") {
			const log = session?.log;
			return Array.isArray(log) ? { events: log, error: null } : { events: null, error: `log is ${log === undefined ? "undefined" : typeof log}` };
		}
		if (source === "snapshot") {
			if (typeof session?.snapshotEvents !== "function") return { events: null, error: "snapshotEvents is not a function" };
			const events = session.snapshotEvents();
			return Array.isArray(events) ? { events, error: null } : { events: null, error: `snapshotEvents returned ${typeof events}` };
		}
		if (typeof session?.eventAt !== "function") return { events: null, error: "eventAt is not a function" };
		const length = Number.isInteger(session?.seq) ? session.seq : null;
		if (length === null) return { events: null, error: `seq is ${typeof session?.seq}` };
		const events = [];
		for (let seq = 0; seq < length; seq += 1) {
			const event = session.eventAt(seq);
			if (event === undefined || event === null) break;
			events.push(event);
		}
		return { events, error: null };
	} catch (error) {
		return { events: null, error: String(error?.message ?? error) };
	}
}

/**
 * Mount the instrument.
 *
 * @param {object} ctx - the plugin context carrying `agents`.
 * @param {object} config - `out` (JSONL path), `intervalMs`, `tag`.
 */
export function apply(ctx, config = {}) {
	const out = typeof config.out === "string" ? config.out : "";
	if (out === "") return;
	const intervalMs = Number.isFinite(Number(config.intervalMs)) && Number(config.intervalMs) > 0 ? Math.floor(Number(config.intervalMs)) : 200;
	const tag = typeof config.tag === "string" ? config.tag : "probe";
	const startedAt = Date.now();
	const startedIso = new Date(startedAt).toISOString();

	/** Highest seq already written, per `<sessionId>|<source>`. */
	const written = new Map();
	/** Sessions whose identity has already been dumped. */
	const identified = new Set();

	const write = (entry) => {
		try {
			appendFileSync(out, `${JSON.stringify({ t: Date.now() - startedAt, at: new Date().toISOString(), tag, ...entry })}\n`, "utf8");
		} catch {
			// An instrument must never take the host down.
		}
	};

	write({ kind: "mount", startedIso, pid: process.pid, argv: process.argv.slice(1), dshHome: process.env.DSH_HOME ?? null });

	const tick = () => {
		let roots = null;
		let rootsError = null;
		try {
			roots = ctx.agents?.roots?.() ?? null;
		} catch (error) {
			rootsError = String(error?.message ?? error);
		}
		if (roots === null) {
			write({ kind: "roots-unavailable", error: rootsError });
			return;
		}
		const summary = [];
		for (const agent of roots) {
			const session = agent?.session ?? null;
			if (session === null) {
				summary.push({ sid: null, note: "agent without session" });
				continue;
			}
			const sid = typeof session?.header?.id === "string" ? session.header.id : "(no-id)";
			let status = null;
			let statusError = null;
			try {
				status = typeof agent.status === "string" ? agent.status : (agent.status === undefined ? null : String(agent.status));
			} catch (error) {
				statusError = String(error?.message ?? error);
			}
			const reads = {};
			for (const source of ["log", "snapshot", "durable"]) {
				const { events, error } = readEvents(session, source);
				reads[source] = { count: events === null ? null : events.length, error };
				if (events === null) continue;
				const key = `${sid}|${source}`;
				const last = written.get(key) ?? -1;
				let highest = last;
				for (const event of events) {
					const seq = Number.isInteger(event?.seq) ? event.seq : null;
					if (seq === null || seq <= last) continue;
					write({ kind: "event", source, sid, seq, type: event?.type ?? null, data: safe(event?.data) });
					if (seq > highest) highest = seq;
				}
				written.set(key, highest);
			}
			if (!identified.has(sid)) {
				identified.add(sid);
				let keys = null;
				try {
					keys = Object.keys(session).sort();
				} catch (error) {
					keys = [`unreadable: ${String(error?.message ?? error)}`];
				}
				let seq = null;
				let eventAtReadable = null;
				try {
					seq = Number.isInteger(session.seq) ? session.seq : null;
					eventAtReadable = typeof session.eventAt === "function" ? "function" : typeof session.eventAt;
				} catch (error) {
					eventAtReadable = `unreadable: ${String(error?.message ?? error)}`;
				}
				write({
					kind: "session-identity",
					sid,
					header: safe(session.header),
					sessionKeys: keys,
					sessionSeq: seq,
					eventAt: eventAtReadable,
					agentKeys: (() => {
						try {
							return Object.keys(agent).sort();
						} catch (error) {
							return [`unreadable: ${String(error?.message ?? error)}`];
						}
					})(),
					status,
					statusError
				});
			}
			summary.push({
				sid,
				status,
				phase: (() => {
					try {
						return typeof agent.phase === "string" ? agent.phase : (agent.phase === undefined ? null : String(agent.phase));
					} catch (error) {
						return `unreadable: ${String(error?.message ?? error)}`;
					}
				})(),
				seq: (() => {
					try {
						return Number.isInteger(session.seq) ? session.seq : null;
					} catch (error) {
						return `unreadable: ${String(error?.message ?? error)}`;
					}
				})(),
				log: reads.log,
				snapshot: reads.snapshot,
				durable: reads.durable,
				logMax: written.get(`${sid}|log`) ?? -1,
				snapshotMax: written.get(`${sid}|snapshot`) ?? -1,
				durableMax: written.get(`${sid}|durable`) ?? -1
			});
		}
		// Written every tick, not only on change: a *non*-change is the evidence here. A tick that
		// never moves while the wire protocol says the turn finished is what proves the session's
		// event list did not receive the turn's own events.
		write({ kind: "tick", roots: summary });
	};

	const timer = setInterval(tick, intervalMs);
	tick();
	ctx.effect?.(() => () => {
		clearInterval(timer);
		write({ kind: "dispose" });
	}, "harnessmux: stop the hx-probe instrument");
}
