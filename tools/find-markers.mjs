/**
 * Search several bundle files for markers and report where each one lives.
 *
 * Cursor spreads its logic across process bundles (workbench, main, extension host,
 * node_modules); guessing which file holds the plugin loader wasted a round trip, so this
 * reports the location instead. Prints the count per file and a short window for the first
 * hit, which is enough to tell a schema definition from an incidental mention.
 *
 * Usage: node tools/find-markers.mjs <root> <marker> [marker...]
 *
 * @module harnessmux/tools/find-markers
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [root, ...markers] = process.argv.slice(2);
if (!root || markers.length === 0) {
	console.error("usage: node tools/find-markers.mjs <root> <marker> [marker...]");
	process.exit(2);
}

/** Every file under a root, largest first, skipping the obvious noise. */
function files(dir, found = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "locales" || entry.name === "node_modules.asar.unpacked") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files(path, found);
		else if (/\.(js|mjs|cjs|json|asar)$/u.test(entry.name) && statSync(path).size > 4096) found.push(path);
	}
	return found;
}

const printable = (value) => value.replace(/[^\x20-\x7e]/gu, " ").replace(/\s{2,}/gu, " ").trim();
const candidates = files(root).sort((a, b) => statSync(b).size - statSync(a).size).slice(0, 40);

for (const marker of markers) {
	console.log(`\n=== ${marker} ===`);
	let reported = 0;
	for (const file of candidates) {
		let text;
		try {
			text = readFileSync(file).toString("latin1");
		} catch {
			continue;
		}
		const count = text.split(marker).length - 1;
		if (count === 0) continue;
		console.log(`  ${count.toString().padStart(4)}  ${file.replace(root, "")}`);
		if (reported < 2) {
			const at = text.indexOf(marker);
			console.log(`        …${printable(text.slice(Math.max(0, at - 120), at + marker.length + 160))}…`);
			reported += 1;
		}
	}
	if (reported === 0) console.log("  (no hit in the scanned files)");
}
