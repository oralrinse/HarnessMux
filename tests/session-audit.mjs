#!/usr/bin/env node
/**
 * Multi-frame zstd reader + session-store audit.
 *
 * Why this exists: a DSH session log is a run of **independent zstd frames**, one
 * per flush. `zlib.zstdDecompressSync` decodes only the first one, and the
 * streaming API's `end` event also stops after the first frame, so both make a
 * 2 MB session look like a single 244-byte header line. That misconception cost
 * several turns during the cutover ("the logs are empty / not readable"), so this
 * tool decodes every frame by walking the frame headers (magic + FCS/BSS
 * descriptor) and decompressing each frame on its own.
 *
 * Usage:
 *   node tests/session-audit.mjs                 # audit every stored session
 *   node tests/session-audit.mjs --session <id>  # one session, dump bridge events
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSIONS = process.env.DSH_SESSIONS_DIR?.trim() ?? join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "sessions");

/**
 * Decode every zstd frame in a buffer.
 *
 * Frame header layout (RFC 8878): magic(4) descriptor(1) [window descriptor(1)]
 * [dict id] [frame content size]. The descriptor's bits 6-7 select the FCS field
 * width; 0 means "single segment" and the FCS width is 1, otherwise 0 means absent.
 *
 * @param {Buffer} buffer - the whole file.
 * @returns {{text: string, frames: number, bytes: number}} decoded text and stats.
 */
function decodeAllFrames(buffer) {
	let offset = 0;
	let frames = 0;
	const parts = [];
	while (offset < buffer.length) {
		const magicAt = buffer.indexOf(MAGIC, offset);
		if (magicAt < 0) break;
		const descriptor = buffer[magicAt + 4];
		const fcsFlag = (descriptor >> 6) & 0x3;
		const singleSegment = (descriptor & 0x20) !== 0;
		const dictFlag = descriptor & 0x3;
		let headerEnd = magicAt + 5;
		if (!singleSegment) headerEnd += 1; // window descriptor
		headerEnd += dictFlag === 3 ? 4 : dictFlag; // dictionary id
		let contentSize = null;
		if (fcsFlag === 0) {
			if (singleSegment) {
				contentSize = buffer.readUInt8(headerEnd);
				headerEnd += 1;
			}
		} else {
			const width = fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
			const reader = width === 2 ? "readUInt16LE" : width === 4 ? "readUInt32LE" : "readBigUInt64LE";
			contentSize = Number(buffer[reader](headerEnd));
			headerEnd += width;
		}
		const frameEnd = contentSize === null ? buffer.length : Math.min(buffer.length, headerEnd + contentSize);
		try {
			parts.push(zstdDecompressSync(buffer.subarray(magicAt, frameEnd)).toString("utf8"));
			frames += 1;
		} catch {
			// A truncated tail frame is normal after a hard kill: keep what decoded.
			break;
		}
		offset = frameEnd <= magicAt ? magicAt + 4 : frameEnd;
	}
	return { text: parts.join(""), frames, bytes: buffer.length };
}

/** Every stored session directory. */
function sessionFiles() {
	const found = [];
	for (const workspace of readdirSync(SESSIONS)) {
		const full = join(SESSIONS, workspace);
		for (const session of readdirSync(full)) {
			const file = join(full, session, "session.v4.jsonl.zstd");
			if (existsSync(file)) found.push({ session, workspace, file });
		}
	}
	return found;
}

const args = process.argv.slice(2);
const only = args.includes("--session") ? args[args.indexOf("--session") + 1] : null;

if (only) {
	const target = sessionFiles().find((entry) => entry.session === only);
	if (!target) {
		console.error(`no stored session ${only}`);
		process.exit(1);
	}
	const { text, frames } = decodeAllFrames(readFileSync(target.file));
	const lines = text.split("\n").filter((line) => line.trim());
	console.log(`${only}: ${lines.length} events in ${frames} zstd frames`);
	let bridge = 0;
	for (const line of lines) {
		if (!line.includes("agent-bridge")) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type !== "user/message") continue;
		bridge += 1;
		const id = event.data?.id;
		console.log(`  seq ${event.seq} source=${event.data?.source?.kind} id=${JSON.stringify(id)} ${typeof id === "string" && id.length > 0 ? "OK" : "*** MISSING ID ***"}`);
	}
	console.log(`agent-bridge user/message events: ${bridge}`);
	process.exit(0);
}

const results = [];
let totalEvents = 0;
let totalBridge = 0;
let totalMissing = 0;
const bridgeSessions = [];
const broken = [];
for (const entry of sessionFiles()) {
	try {
		const { text, frames } = decodeAllFrames(readFileSync(entry.file));
		const lines = text.split("\n").filter((line) => line.trim());
		totalEvents += lines.length;
		let bridge = 0;
		let missing = 0;
		let firstBridgeSeq = null;
		for (const line of lines) {
			if (!line.includes("agent-bridge")) continue;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event.type !== "user/message") continue;
			bridge += 1;
			if (firstBridgeSeq === null) firstBridgeSeq = event.seq;
			const id = event.data?.id;
			if (typeof id !== "string" || id.length === 0) missing += 1;
		}
		totalBridge += bridge;
		totalMissing += missing;
		if (bridge > 0) bridgeSessions.push({ session: entry.session, bridge, missing, firstBridgeSeq, frames });
		if (missing > 0) broken.push({ session: entry.session, missing });
	} catch (error) {
		results.push({ session: entry.session, error: String(error?.message ?? error).slice(0, 70) });
	}
}

console.log(`sessions scanned      : ${sessionFiles().length}`);
console.log(`events decoded        : ${totalEvents}`);
console.log(`agent-bridge messages : ${totalBridge} across ${bridgeSessions.length} sessions`);
console.log(`  of those, missing id: ${totalMissing}`);
console.log(`unreadable files      : ${results.length}`);
for (const row of results) console.log(`  ! ${row.session}: ${row.error}`);
console.log("\nsessions containing agent-bridge deliveries:");
for (const row of bridgeSessions.sort((a, b) => b.bridge - a.bridge).slice(0, 20)) {
	console.log(`  ${row.session}  events=${row.bridge}  missingId=${row.missing}  firstSeq=${row.firstBridgeSeq}  frames=${row.frames}`);
}
if (broken.length > 0) {
	console.log("\n*** sessions with an id-less agent-bridge event (these are the corrupt ones) ***");
	for (const row of broken) console.log(`  ${row.session}  missing=${row.missing}`);
}
