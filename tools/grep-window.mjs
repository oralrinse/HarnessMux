/**
 * Print windows of a bundle around a pattern.
 *
 * PowerShell mangled the inline regex, so this keeps the extraction in JavaScript where the
 * escaping is predictable. Prints ASCII-only windows so binary neighbours do not flood the
 * terminal.
 *
 * Usage: node tools/grep-window.mjs <file> <pattern> [window] [max]
 *
 * @module harnessmux/tools/grep-window
 */

import { readFileSync } from "node:fs";

const [file, pattern, windowArg, maxArg] = process.argv.slice(2);
if (!file || !pattern) {
	console.error("usage: node tools/grep-window.mjs <file> <pattern> [window] [max]");
	process.exit(2);
}

const window = Number(windowArg ?? 120);
const max = Number(maxArg ?? 10);
const text = readFileSync(file).toString("latin1");
const re = new RegExp(pattern, "gu");
const clean = (value) => value.replace(/[^\x20-\x7e]/gu, " ").replace(/\s{2,}/gu, " ").trim();

let count = 0;
for (const match of text.matchAll(re)) {
	count += 1;
	const start = Math.max(0, match.index - window);
	const end = Math.min(text.length, match.index + match[0].length + window);
	console.log(`--- ${count} @ ${match.index}`);
	console.log(clean(text.slice(start, end)));
	if (count >= max) break;
}
console.log(`\n${count} shown for /${pattern}/`);
