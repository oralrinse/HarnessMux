/**
 * hx-dispatch-probe — reconnaissance: what identity survives a host dispatch?
 *
 * P1d's question is whether HarnessMux can attach a **deterministic identity** to the input it hands a
 * session, such that the identity is (a) durable in the session's own record and (b) retrievable by a
 * *different* receiver process after a crash. Without that, "the host accepted this dispatch" cannot be
 * decided from the side that caused it, and exactly-once dispatch is not implementable — only fakeable
 * with local state, which is exactly the mistake P1d exists to avoid.
 *
 * This instrument does not implement anything. It tries the candidate shapes in the order of preference
 * and records, for each one, what the host actually did with the identity:
 *
 *   1. `frozen-id`     a caller-supplied `id` on a message passed through `freezeMessage` (which the
 *                      package documents as preserving an identity that already exists)
 *   2. `plain-id`      the same object without the freeze step
 *   3. `custom-field`  `createUserMessage({..., harnessmuxDispatchKey})` — an extra field on the message
 *   4. `source-nested` the key nested in `source`, beside the receiver's own `source.kind`
 *
 * `createUserMessage` is known from source to *overwrite* `id` with a fresh uuid
 * (`createMessage({...input, id: brandString(randomUUID())})`), so 3 and 4 can only work through a
 * field the host carries along. Candidates 1 and 2 need no DSH package at all, which matters because the
 * receiver's own opportunistic import is allowed to fail.
 *
 * Timing is measured the same way, because recovery depends on it: whether the keyed `user/message` is
 * already durable at the instant `followup()` resolves, or only becomes durable afterwards. A recovery
 * pass that re-dispatches on "not found yet" has re-created the duplicate it was meant to prevent.
 *
 * @module @harnessmux/dispatch-probe
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

/** Cordis plugin name. */
export const name = "hx-dispatch-probe";

/** The only service needed; undeclared service access throws in Cordis. */
export const inject = ["agents"];

/** The identity-preserving and identity-overwriting constructors, when they resolve at all. */
let llm = null;
try {
	llm = await import("@deepseek-ai/dsh-llm");
} catch {
	llm = null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A session's events, from whichever accessor works.
 *
 * @param {object} agent - the live agent.
 * @returns {object[]} the events.
 */
function eventsOf(agent) {
	const session = agent?.session ?? null;
	if (session === null) return [];
	const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : session.log;
	return Array.isArray(events) ? events : [];
}

/**
 * How many turns the session has both opened and closed.
 *
 * @param {object[]} events - the session events.
 * @returns {number} the number of closed turns.
 */
function closedTurns(events) {
	let open = null;
	let closed = 0;
	for (const event of events) {
		if (event?.type === "turn/start") open = event.data?.turn ?? null;
		if (event?.type === "turn/end" && event.data?.turn === open) {
			open = null;
			closed += 1;
		}
	}
	return closed;
}

/**
 * Build one candidate dispatch message.
 *
 * @param {string} candidate - which shape to build.
 * @param {string} key - the deterministic key HarnessMux wants to attach.
 * @param {string} text - the model-facing text.
 * @returns {object} the message object to hand to `followup`.
 */
function buildMessage(candidate, key, text) {
	const content = [{ type: "text", text }];
	const base = { id: key, role: "user", content, source: { kind: "harnessmux" } };
	if (candidate === "plain-id") return base;
	if (candidate === "frozen-id") return typeof llm?.freezeMessage === "function" ? llm.freezeMessage(base) : base;
	if (candidate === "custom-field") {
		// The field must ride on the message either way. (An earlier version of this instrument dropped
		// it in the no-dsh-llm fallback, which silently made the candidate untested — the run reported
		// "not found" for a shape that had never been tried.)
		return typeof llm?.createUserMessage === "function"
			? llm.createUserMessage({ content, source: { kind: "harnessmux" }, harnessmuxDispatchKey: key })
			: { ...base, id: randomUUID(), harnessmuxDispatchKey: key };
	}
	if (candidate === "source-nested") {
		const source = { kind: "harnessmux", harnessmuxDispatchKey: key };
		return typeof llm?.createUserMessage === "function" ? llm.createUserMessage({ content, source }) : { ...base, id: randomUUID(), source };
	}
	throw new Error(`hx-dispatch-probe: unknown candidate ${candidate}`);
}

/** Whether an event carries the key, by id or by either metadata location. */
const carriesKey = (event, key) =>
	event?.type === "user/message" &&
	(event?.data?.id === key || event?.data?.harnessmuxDispatchKey === key || event?.data?.source?.harnessmuxDispatchKey === key);

/**
 * Mount the instrument.
 *
 * @param {object} ctx - the plugin context carrying `agents`.
 * @param {object} config - `out` (JSONL path), `keyPrefix`, `candidates` (comma-separated).
 */
export function apply(ctx, config = {}) {
	const out = typeof config.out === "string" ? config.out : "";
	if (out === "") return;
	const keyPrefix = typeof config.keyPrefix === "string" && config.keyPrefix !== "" ? config.keyPrefix : "hxmux-dispatch:recon";
	const candidates = (typeof config.candidates === "string" && config.candidates !== "" ? config.candidates : "frozen-id,plain-id,custom-field,source-nested")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const startedAt = Date.now();

	const write = (entry) => {
		try {
			appendFileSync(out, `${JSON.stringify({ t: Date.now() - startedAt, at: new Date().toISOString(), tag: "dispatch-probe", ...entry })}\n`, "utf8");
		} catch {
			// An instrument must never take the host down.
		}
	};

	write({
		kind: "dispatch-probe-mount",
		pid: process.pid,
		candidates,
		llmAvailable: llm !== null,
		freezeMessage: typeof llm?.freezeMessage,
		createUserMessage: typeof llm?.createUserMessage
	});

	ctx.on("agent/created", ({ agent }) => {
		void (async () => {
			try {
				// Wait for the host's own first turn to finish, so the dispatch under test is the only
				// thing happening and its timeline is unambiguous.
				const bootDeadline = Date.now() + 180_000;
				while (closedTurns(eventsOf(agent)) < 1 && Date.now() < bootDeadline) await delay(100);
				write({ kind: "dispatch-probe-ready", closedTurns: closedTurns(eventsOf(agent)) });

				let closed = closedTurns(eventsOf(agent));
				for (const [index, candidate] of candidates.entries()) {
					const key = `${keyPrefix}:${index + 1}`;
					const text = `DISPATCH_RECON_${index + 1}: reply with exactly RECON_${index + 1} and nothing else.`;
					let message;
					try {
						message = buildMessage(candidate, key, text);
					} catch (error) {
						write({ kind: "dispatch", candidate, key, error: String(error?.message ?? error), timing: null });
						continue;
					}
					const seqsBefore = new Set(eventsOf(agent).map((event) => event.seq));
					const calledAt = Date.now();
					let resolvedAt = null;
					let error = null;
					try {
						// Awaited exactly as the receiver awaits it: the question includes whether the host's
						// promise resolving means the dispatch is durable.
						await agent.followup(message);
					} catch (failure) {
						error = String(failure?.message ?? failure);
					}
					resolvedAt = Date.now();
					// The synchronous check: what is durable at the instant followup() resolved?
					const atResolve = eventsOf(agent).filter((event) => !seqsBefore.has(event.seq));
					const atResolveTypes = atResolve.map((event) => event.type);

					// And how much later the keyed user/message becomes visible, if it is not already.
					let keyed = null;
					let foundAt = null;
					const deadline = Date.now() + 15_000;
					while (Date.now() < deadline) {
						const found = eventsOf(agent).find((event) => carriesKey(event, key));
						if (found !== undefined) {
							keyed = found;
							foundAt = Date.now();
							break;
						}
						await delay(25);
					}
					const spliced = eventsOf(agent).find(
						(event) =>
							event?.type === "agent/inbox/spliced" &&
							(event?.data?.inserted ?? []).some((entry) => entry?.id === key || entry?.harnessmuxDispatchKey === key || entry?.source?.harnessmuxDispatchKey === key)
					);
					write({
						kind: "dispatch",
						candidate,
						key,
						error,
						followupResolved: resolvedAt !== null,
						timing: {
							callAt: new Date(calledAt).toISOString(),
							resolvedAt: new Date(resolvedAt).toISOString(),
							resolvedMs: resolvedAt - calledAt,
							keyedUserMessageSeenMsAfterResolve: foundAt === null ? null : foundAt - resolvedAt,
							durableAtResolve: atResolveTypes.includes("user/message")
						},
						atResolve: { types: atResolveTypes, seqs: atResolve.map((event) => event.seq) },
						keyedUserMessageFound: keyed !== null,
						userMessage: keyed === null ? null : { seq: keyed.seq, id: keyed.data?.id ?? null, dataKeys: Object.keys(keyed.data ?? {}).sort(), data: keyed.data },
						idSurvived: keyed !== null && keyed.data?.id === key,
						customFieldSurvived: keyed !== null && keyed.data?.harnessmuxDispatchKey === key,
						sourceFieldSurvived: keyed !== null && keyed.data?.source?.harnessmuxDispatchKey === key,
						splicedEcho: spliced === undefined ? null : { seq: spliced.seq, inserted: spliced.data?.inserted ?? null }
					});

					// One candidate per turn: wait for this turn to close before the next dispatch.
					const target = closed + 1;
					const closeDeadline = Date.now() + 180_000;
					while (closedTurns(eventsOf(agent)) < target && Date.now() < closeDeadline) await delay(100);
					closed = closedTurns(eventsOf(agent));
				}

				// The cross-process half of the question: a *different* receiver has only the durable store,
				// so the key has to be readable from there too — and by which API. Called twice, because the
				// durable write is asynchronous: once as soon as the last turn closed, once after a settle.
				const sessionId = agent?.session?.header?.id ?? "";
				for (const [attempt, delayMs] of [[1, 0], [2, 5_000]]) {
					if (delayMs > 0) await delay(delayMs);
					const entry = { kind: "durable-read", attempt, sessionId, at: new Date().toISOString() };
					try {
						const query = typeof ctx.get === "function" ? ctx.get("sessionQuery") : undefined;
						entry.sessionQuery = query === undefined ? "unavailable" : typeof query;
						entry.services = typeof query === "object" && query !== null ? Object.keys(query).sort().slice(0, 20) : null;
						if (query !== undefined && typeof query?.observeSession === "function") {
							const observation = await query.observeSession(sessionId);
							const events = Array.isArray(observation?.events) ? observation.events : [];
							entry.eventCount = events.length;
							entry.header = observation?.header ?? null;
							entry.keys = candidates.map((candidate, index) => {
								const key = `${keyPrefix}:${index + 1}`;
								const hit = events.find(
									(event) =>
										event?.type === "user/message" &&
										(event?.data?.id === key || event?.data?.harnessmuxDispatchKey === key || event?.data?.source?.harnessmuxDispatchKey === key)
								);
								const splice = events.find(
									(event) =>
										event?.type === "agent/inbox/spliced" &&
										(event?.data?.inserted ?? []).some((message) => message?.id === key)
								);
								return { candidate, key, inUserMessage: hit !== undefined, userMessageSeq: hit?.seq ?? null, inSplice: splice !== undefined, spliceSeq: splice?.seq ?? null };
							});
							entry.found = entry.keys.filter((row) => row.inUserMessage || row.inSplice).map((row) => row.candidate);
						}
					} catch (error) {
						entry.error = String(error?.message ?? error);
					}
					write(entry);
				}
				write({ kind: "dispatch-recon-done" });
			} catch (error) {
				write({ kind: "dispatch-probe-error", error: String(error?.message ?? error), stack: String(error?.stack ?? "").slice(0, 800) });
			}
		})();
	});
}
