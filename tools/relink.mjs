#!/usr/bin/env node
/**
 * One-shot maintenance tool: report and rewrite relative imports after a layout move.
 *
 * Run with `--check` to list broken relative references, or `--fix` to apply the
 * mapping derived from the new package layout. Kept in the repo because the same
 * problem returns whenever files move.
 *
 * @module harnessmux/tools/relink
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set([".git", "test-bridge", "node_modules", "examples"]);

/** Every source file worth checking. */
function sourceFiles(dir = ROOT) {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...sourceFiles(path));
		else if (/\.(mjs|js)$/u.test(entry.name)) found.push(path);
	}
	return found;
}

/** Every relative specifier in a file, with its kind. */
function specifiers(text) {
	const found = [];
	for (const match of text.matchAll(/from\s+"(\.[^"]+)"|import\(\s*"(\.[^"]+)"\s*\)|new URL\(\s*"(\.[^"]+)"/gu)) {
		found.push(match[1] ?? match[2] ?? match[3]);
	}
	return [...new Set(found)];
}

/**
 * Where a specifier should point after the move.
 *
 * The mapping is expressed as "old absolute target -> new absolute target", so a
 * file can be rewritten without knowing which directory it moved to.
 *
 * @param {string} from - the importing file.
 * @param {string} specifier - the relative specifier as written.
 * @returns {string|null} the corrected specifier, or null when it already resolves.
 */
function corrected(from, specifier) {
	const absolute = resolve(dirname(from), specifier);
	if (existsSync(absolute)) return null;
	// Old layout: <root>/lib/*.mjs and <root>/plugin/index.js
	const rel = relative(ROOT, absolute).split(sep).join("/");
	const moves = [
		// Files that moved *out* of lib/ keep pointing at the core package.
		[/^lib\//u, "packages/core/"],
		// A CLI file that used to sit next to the core now lives in its own package.
		[/^packages\/cli\/(core|core-v2|migrate)\.mjs$/u, "packages/core/$1.mjs"],
		// The receiver used to resolve the core one directory up; it still does, one
		// package up instead.
		[/^packages\/receiver-dsh\/core(-v2)?\.mjs$/u, "packages/core/core$1.mjs"],
		[/^plugin\/index\.js$/u, "packages/receiver-dsh/index.js"],
		[/^plugin\/(.*)$/u, "packages/receiver-dsh/$1"],
		[/^tests\/env\.mjs$/u, "examples/live/env.mjs"],
		[/^tests\/(acp-live-probe|acp-wake-probe|ask-session|cutover-probe|cutover-faults\.test|diag-crash-window|diag-session-identity|session-audit|v1-inventory)\.mjs$/u, "examples/live/$1.mjs"],
		[/^plugin-codex\/(.*)$/u, "packages/adapter-codex/$1"],
		// Live examples import the core by package path.
		[/^examples\/live\/(core|core-v2|migrate)\.mjs$/u, "packages/core/$1.mjs"]
	];
	for (const [pattern, replacement] of moves) {
		if (pattern.test(rel)) {
			const target = join(ROOT, rel.replace(pattern, replacement));
			if (!existsSync(target)) return null;
			const next = relative(dirname(from), target).split(sep).join("/");
			return next.startsWith(".") ? next : `./${next}`;
		}
	}
	return null;
}

const fix = process.argv.includes("--fix");
let broken = 0;
let rewritten = 0;
for (const file of sourceFiles()) {
	const original = readFileSync(file, "utf8");
	let text = original;
	for (const specifier of specifiers(original)) {
		const next = corrected(file, specifier);
		if (next === null) {
			if (!existsSync(resolve(dirname(file), specifier))) {
				broken += 1;
				console.log(`  BROKEN  ${relative(ROOT, file)}  ->  ${specifier}`);
			}
			continue;
		}
		if (fix) {
			text = text.split(`"${specifier}"`).join(`"${next}"`);
			console.log(`  REWRITE ${relative(ROOT, file)}  ${specifier}  ->  ${next}`);
		} else {
			console.log(`  STALE   ${relative(ROOT, file)}  ->  ${specifier}  (should be ${next})`);
		}
	}
	if (fix && text !== original) {
		writeFileSync(file, text, "utf8");
		rewritten += 1;
	}
}
console.log(`\nfiles scanned: ${sourceFiles().length} | broken: ${broken} | rewritten: ${rewritten}${fix ? "" : " (dry run: pass --fix)"}`);
process.exit(broken > 0 && !fix ? 1 : 0);
