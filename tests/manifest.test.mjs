/**
 * DSH profile-bundle packaging test.
 *
 * The harness refuses to mount a bundle whose package.json declares no
 * `dsh.bundle`, and it names the plugin twice: once as the bundle package
 * (`@local/harnessmux`) and once as the patch row's plugin. This test guards
 * that contract, because importing `plugin/index.js` directly skips it.
 *
 * Run: node tests/manifest.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const PLUGIN_DIR = join(REPO, "plugin");
const BUNDLE_NAME = "@local/harnessmux";

const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"));
assert.equal(manifest.name, BUNDLE_NAME, "the plugin package name matches the patch row");
assert.equal(manifest.type, "module", "the bundle is ESM");
assert.ok(manifest.exports?.["."], "the bundle exports its entry point");

// The contract the harness actually enforces.
assert.ok(manifest.dsh?.bundle?.patch, "package.json declares dsh.bundle.patch (otherwise the harness skips the bundle)");
const patchFile = join(PLUGIN_DIR, manifest.dsh.bundle.patch);
assert.equal(existsSync(patchFile), true, `the declared patch exists: ${patchFile}`);

// The patch must carry a row for this package, and must be a single YAML document.
const patch = readFileSync(patchFile, "utf8");
assert.match(patch, new RegExp(`name: '${BUNDLE_NAME}'|name: "${BUNDLE_NAME}"`, "u"), "the patch row names the package");
const documents = patch
	.split(/\r?\n/u)
	.map((line) => line.replace(/\s+#.*$/u, "").trim())
	.filter((line) => line.length > 0 && !line.startsWith("#"));
assert.equal(documents.includes("---"), false, "the patch is one YAML document, not several");
assert.equal(documents.includes("[]"), false, "the patch is not an empty sequence with rows appended after it");

// The plugin module must import cleanly from disk (no DSH package needed at load).
const plugin = await import(new URL("./plugin/index.js", `file:///${REPO.replace(/\\/gu, "/")}/`).href);
assert.equal(plugin.name, "harnessmux", "the plugin module exports its cordis name");
assert.equal(typeof plugin.apply, "function", "the plugin module exports apply");
assert.equal(typeof plugin.bridgeRoot, "function", "the plugin exports bridgeRoot for tests and tooling");

// --- root-cache safety: tests must never repoint the user's remembered root ----
// A test run overwrote the cache with a test-bridge path that it then deleted,
// which broke the first real cutover's root resolution.
{
	const { ROOT_CACHE: CACHE_V1, ensureBridge: ensureV1 } = await import("../lib/core.mjs");
	const { ROOT_CACHE: CACHE_V2, ensureBridge: ensureV2 } = await import("../lib/core-v2.mjs");
	assert.equal(CACHE_V1, CACHE_V2, "v1 and v2 share one remembered-root cache");

	// This test writes the shared cache, so it must restore the real value.
	const original = existsSync(CACHE_V1) ? readFileSync(CACHE_V1, "utf8") : null;
	const sentinel = mkdtempSync(join(tmpdir(), "ab-cache-"));
	writeFileSync(CACHE_V1, sentinel, "utf8");
	try {
		// A root inside the project checkout is ephemeral state and must be ignored.
		const ephemeral = join(REPO, "test-bridge-cache-guard");
		rmSync(ephemeral, { recursive: true, force: true });
		ensureV1(ephemeral);
		assert.equal(readFileSync(CACHE_V1, "utf8"), sentinel, "a v1 test root must not overwrite the cache");
		ensureV2(ephemeral);
		assert.equal(readFileSync(CACHE_V1, "utf8"), sentinel, "a v2 test root must not overwrite the cache");
		// An explicit opt-out still works, and a real root outside the project is remembered.
		ensureV2(ephemeral, { remember: false });
		assert.equal(readFileSync(CACHE_V1, "utf8"), sentinel, "remember:false never writes the cache");
		ensureV2(sentinel);
		assert.equal(readFileSync(CACHE_V1, "utf8"), sentinel, "a real root outside the project is remembered");

		// Implicit operations must never touch the cache: a long-running participant
		// (or a test) that merely posts/claims/acks used to repoint the user's root.
		const { postMessage, enqueueDelivery, claimDelivery, ackDelivery, registerEndpoint } = await import("../lib/core-v2.mjs");
		const implicit = mkdtempSync(join(tmpdir(), "ab-implicit-"));
		writeFileSync(CACHE_V1, sentinel, "utf8");
		const message = postMessage(implicit, { from: "codex", topic: "cache guard", body: "must not touch the cache" });
		const delivery = enqueueDelivery(implicit, { messageId: message.messageId, target: { actor: "dsh" } });
		claimDelivery(implicit, delivery.deliveryId, { owner: "guard" });
		ackDelivery(implicit, delivery.deliveryId, { owner: "guard" });
		registerEndpoint(implicit, { actor: "dsh", endpointId: "guard-endpoint" });
		assert.equal(readFileSync(CACHE_V1, "utf8"), sentinel, "post/claim/ack/registerEndpoint never rewrite the shared cache");
		rmSync(implicit, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });

		rmSync(ephemeral, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	} finally {
		if (original === null) rmSync(CACHE_V1, { force: true });
		else writeFileSync(CACHE_V1, original, "utf8");
		rmSync(sentinel, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
	}
	assert.equal(existsSync(CACHE_V1) ? readFileSync(CACHE_V1, "utf8") : null, original, "the shared cache is restored after the test");
}

console.log("manifest.test.mjs: all assertions passed");
