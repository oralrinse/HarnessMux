/**
 * Final-text accumulator — the content half of automatic final capture.
 *
 * ## Why it is shaped this way
 *
 * Verified on a real host across three turn shapes (plain text, reasoning + text, and tool call +
 * text), each producing byte-identical results by two independent routes:
 *
 *   1. `ctx.on("agent/status")` → `idle`            timely *trigger* to go and look
 *   2. `session.log` `turn/end` with `reason.kind`   **authoritative** completion, and whether it succeeded
 *   3. `agent/assistant-stream`, frame type `end`    commit anchor: `outcome.eventType="assistant/message"`, `outcome.seq`
 *   4. `block-end` chunks where `block.type === "text"`
 *
 * The load-bearing finding is (4): **a completed block carries its own fully assembled text** in
 * `chunk.block.text`. So this accumulator deliberately does **not** rebuild text from `text-delta`
 * chunks. Two reasons, both measured:
 *
 *   - it removes the entire revision question. Deltas were verified append-only with strictly
 *     increasing revisions and no duplicate frame indices, but relying on that would be relying on a
 *     property that could change; `block.text` is already final.
 *   - it makes partial or duplicated application harmless. Appending deltas twice corrupts text;
 *     storing a block's finished text twice does not.
 *
 * Deltas are therefore accepted only for diagnostics, never as the text source.
 *
 * ## One turn, several text blocks
 *
 * A turn is not assumed to contain exactly one visible block. Blocks are stored in the order the host
 * completed them, and `finalText` joins them. Storing a single value and overwriting it would silently
 * discard the earlier half of a two-block answer, which is exactly the kind of quiet loss this layer
 * exists to prevent.
 */

/**
 * Key for one attempt's accumulator.
 *
 * `attemptId` is taken from the host frames, never parsed. It happens to look like
 * `session-<uuid>:<turn>`, and that suffix is used for diagnostics and consistency checks only — it is
 * never the identity of anything, because build 2 of the same string must not be able to change which
 * delivery a turn belongs to.
 *
 * @param {string} sessionId - the session the attempt ran in.
 * @param {string} attemptId - the attempt id from the host frames.
 * @returns {string} the accumulator key.
 */
export const attemptKey = (sessionId, attemptId) => `${sessionId ?? "?"}::${attemptId ?? "?"}`;

/**
 * The turn number carried in an attempt id, for diagnostics only.
 *
 * @param {string} attemptId - e.g. `session-abc:3`.
 * @returns {number|null} the suffix as a number, or null when it is not shaped that way.
 */
export function turnFromAttemptId(attemptId) {
	const match = /:(\d+)$/u.exec(String(attemptId ?? ""));
	return match === null ? null : Number(match[1]);
}

/**
 * Create an empty accumulator for one attempt.
 *
 * @param {object} input - `sessionId` and `attemptId`.
 * @returns {object} the record.
 */
export function createAccumulator(input = {}) {
	return {
		sessionId: String(input.sessionId ?? ""),
		attemptId: String(input.attemptId ?? ""),
		turn: turnFromAttemptId(input.attemptId),
		textBlocks: [],
		assistantMessageSeq: null,
		outcome: null,
		// The sequence of this turn's end in the session log, when the host reports one.
		turnEndSeq: null,
		reason: null,
		frameCount: 0,
		deltaCount: 0,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString()
	};
}

/**
 * Apply one `agent/assistant-stream` frame to an accumulator.
 *
 * Pure where it can be: the same frame applied twice updates counters but never changes `textBlocks`
 * or `finalText`, because a block's text is stored once, keyed by its index, at completion.
 *
 * @param {object} record - the accumulator, mutated in place.
 * @param {object} frame - the frame payload (`{ type, attemptId, revision, index, chunk, outcome }`).
 * @returns {object} the same record.
 */
export function accumulateFrame(record, frame) {
	if (record === null || typeof record !== "object" || frame === null || typeof frame !== "object") return record;
	record.frameCount += 1;
	record.updatedAt = new Date().toISOString();

	// The `end` frame is the commit anchor: it names the persisted assistant message and its sequence.
	if (frame.type === "end") {
		const outcome = frame.outcome ?? null;
		record.outcome = outcome;
		if (outcome !== null && typeof outcome.seq === "number") record.assistantMessageSeq = outcome.seq;
		return record;
	}

	const chunk = frame.chunk ?? null;
	if (chunk === null || typeof chunk !== "object") return record;

	if (chunk.type === "reasoning-delta" || chunk.type === "text-delta") {
		// Counted, never concatenated. See the module comment: the block's own text is authoritative.
		record.deltaCount += 1;
		return record;
	}

	if (chunk.type === "finish" && chunk.reason !== undefined) {
		record.reason = chunk.reason;
		return record;
	}

	if (chunk.type === "block-end") {
		const block = chunk.block ?? null;
		if (block !== null && block.type === "text" && typeof block.text === "string") {
			// Keyed by the host's block index, so re-delivery of the same block replaces rather than
			// duplicates, and a later block is appended rather than overwriting an earlier one.
			const index = typeof chunk.index === "number" ? chunk.index : record.textBlocks.length;
			const existing = record.textBlocks.findIndex((entry) => entry.index === index);
			const entry = { index, text: block.text };
			if (existing === -1) record.textBlocks.push(entry);
			else record.textBlocks[existing] = entry;
			record.textBlocks.sort((a, b) => a.index - b.index);
		}
		return record;
	}

	return record;
}

/**
 * The final user-visible text of an accumulated attempt.
 *
 * Reasoning blocks are excluded by construction — they never reach `textBlocks`. Multiple text blocks
 * are joined in host completion order, with a blank line between them so two blocks do not read as one
 * run-on sentence.
 *
 * @param {object} record - the accumulator.
 * @returns {string} the final text, or an empty string when the turn produced none.
 */
export function finalTextOf(record) {
	if (record === null || !Array.isArray(record.textBlocks)) return "";
	return record.textBlocks.map((entry) => entry.text).join("\n\n").trim();
}

/**
 * Whether an accumulator holds enough to be considered a finished, successful turn.
 *
 * `reason.kind` is read from the `finish` chunk and is the host's own statement about how the turn
 * ended. An errored turn must never be dressed up as a successful one, so `completed` is required
 * explicitly rather than inferred from the mere presence of text.
 *
 * @param {object} record - the accumulator.
 * @returns {{complete: boolean, reason: string, hasText: boolean}} the assessment.
 */
export function completionOf(record) {
	const kind = record?.reason?.kind ?? (record?.outcome === null || record?.outcome === undefined ? "unknown" : "completed");
	const hasText = finalTextOf(record) !== "";
	return { complete: kind === "completed", reason: String(kind), hasText };
}

/**
 * Collect the visible text of one event, wherever it is nested.
 *
 * Measured shape: `event.data.message.content[]` holds blocks, and the visible ones are
 * `{ type: "text", text }` — often beside a `{ type: "reasoning" }` block whose text is empty. A
 * reasoning block is never user-visible, so only `type === "text"` is collected, in content order.
 *
 * @param {object} event - a session event.
 * @returns {string} the joined visible text, or an empty string.
 */
export function visibleTextOf(event) {
	const parts = [];
	const walk = (value) => {
		if (value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
		for (const nested of Object.values(value)) walk(nested);
	};
	walk(event);
	return parts.join("");
}

/**
 * The session event that carries a turn's final answer.
 *
 * The rule, chosen to avoid the failure mode that a per-step `assistant/message` invites: a turn contains
 * **several** `assistant/message` events — one per step, including tool-calling steps whose text is empty
 * or is an intermediate remark. Concatenating them would produce duplicated interim output, so the answer
 * is the **last** `assistant/message` inside the turn that actually carries visible text.
 *
 * @param {object[]} events - the session's own event list (e.g. `snapshotEvents()`).
 * @param {number} turn - the turn whose answer is wanted.
 * @returns {object|null} the chosen event, or null.
 */
export function finalAssistantEvent(events, turn) {
	if (!Array.isArray(events) || !Number.isInteger(turn)) return null;
	const candidates = events.filter(
		(entry) => entry?.type === "assistant/message" && entry?.data?.turn === turn && visibleTextOf(entry) !== ""
	);
	return candidates.length === 0 ? null : candidates[candidates.length - 1];
}

/**
 * The terminal answer of a completed turn: `{ seq, text }` from the session's own event list.
 *
 * Returns null when there is no text-bearing assistant message, so "completed but empty" stays visible as
 * a distinct outcome rather than being reported as an answer of length zero.
 *
 * @param {object[]} events - the session's own event list.
 * @param {number} turn - the completed turn.
 * @returns {{seq: number|null, text: string}|null} the answer, or null.
 */
export function finalAnswerOf(events, turn) {
	const event = finalAssistantEvent(events, turn);
	if (event === null) return null;
	return { seq: Number.isInteger(event.seq) ? event.seq : null, text: visibleTextOf(event) };
}
