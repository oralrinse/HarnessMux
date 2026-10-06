/**
 * Maintenance tool: read schema strings out of the Codex binary.
 *
 * The Codex plugin format is only documented in part, and guessing it produced a
 * manifest with a wrong display name and an invented homepage. The binary is the
 * authority, so this extracts printable strings and prints a window around each
 * marker, which is how the accepted manifest keys and hook names were established.
 *
 * Usage: node tools/binary-strings.mjs <binary> <marker> [window]
 *
 * @module harnessmux/tools/binary-strings
 */

import { readFileSync } from "node:fs";

const [binary, marker, windowArg] = process.argv.slice(2);
if (!binary || !marker) {
	console.error("usage: node tools/binary-strings.mjs <binary> <marker> [window]");
	process.exit(2);
}

const window = Number(windowArg ?? 220);
// latin1 maps every byte to one character, so offsets stay meaningful and no
// decoding error can throw away a match.
const text = readFileSync(binary).toString("latin1");
const printable = (value) => value.replace(/[^\x20-\x7e]/gu, " ").replace(/\s{2,}/gu, " ").trim();

let index = 0;
let found = 0;
while ((index = text.indexOf(marker, index)) !== -1) {
	found += 1;
	const start = Math.max(0, index - window);
	const end = Math.min(text.length, index + marker.length + window);
	console.log(`--- match ${found} at byte ${index}`);
	console.log(printable(text.slice(start, end)));
	console.log("");
	index += marker.length;
	if (found >= 12) {
		console.log("(stopped after 12 matches)");
		break;
	}
}
console.log(`marker ${JSON.stringify(marker)}: ${found} shown`);
