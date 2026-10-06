# P3.4-A reconnaissance — Cursor capabilities

Date: 2026-10-06 · Cursor **2.5.25** (`H:\PersonalComputerSoftware\cursor`) · Windows.
Evidence is from this machine: Cursor's own bundles, its shipped extensions, its on-disk
configuration, and Claude Code's behaviour on the same manifest. Documentation was not used
as evidence.

Verdict: **the portable core is close to working as-is, and one of the two assumptions this
phase started from needs correcting.** The adapter is compatible after a one-line change;
the bigger finding is *how a plugin gets loaded at all*, which is narrower than expected.

## 1. Manifest location — the assumption was wrong

This phase began from "Cursor and Copilot both support Agent Plugins 1.0, i.e. a root
`plugin.json` + `skills/` + `mcp.json`". Measured on 2.5.25, Cursor's loader looks for the
manifest at exactly two paths, and a **root `plugin.json` is not one of them**:

```js
// extensions/cursor-agent-exec/dist/main.js
E = [".cursor-plugin/plugin.json", ".claude-plugin/plugin.json"]   // PLUGIN_MANIFEST_PATHS
v = [".cursor-plugin", ".claude-plugin"]                          // PLUGIN_ROOT_DIR_NAMES
_ = [".cursor-plugin/marketplace.json", ".claude-plugin/marketplace.json"]
```

So the current adapter layout — `packages/adapter-claude/.claude-plugin/plugin.json` with
`.mcp.json`, `hooks/hooks.json` and `skills/` beside it — is already one of the two accepted
shapes. Nothing has to move.

## 2. The manifest schema (Zod-validated)

`parsePluginManifest` runs `safeParse` against a strict object; unrecognised fields are not
the problem, but missing paths are. Fields read:

```js
{ name, displayName?, description?, version?, author?, publisher?, homepage?, repository?,
  license?, logo?, keywords?, category?, tags?, strict = true,
  commands?, agents?, skills?, rules?, hooks?, mcpServers? }
```

`skills`, `rules`, `commands`, `agents` are `string | string[]`; `hooks` is
`string | HooksConfig`; and **`mcpServers` is `string | HooksConfig | Record<string, string | HooksConfig>`**.

## 3. MCP is declared in the manifest, not discovered

The loader reads MCP configuration through `resolveMcpServersFromManifest`, and probes only
these filenames:

```js
Aa = [".mcp.json", "mcp.json"]
```

with the server map under `mcpServers` (a flat map, exactly like the Codex and Claude files we
already ship). Crucially, a `.mcp.json` sitting in the plugin directory is **not** picked up on
its own — the plugin has to point at it:

```jsonc
// .claude-plugin/plugin.json
"mcpServers": "./.mcp.json"
```

That is the one-line compatibility change, and it was made and verified:

- `claude plugin validate packages/adapter-claude` → **Validation passed**;
- `claude plugin details harnessmux` → still `Skills (1)`, `Hooks (2)`, `MCP servers (1)`;
- `tests/adapter-claude.test.mjs` → passes.

Claude ignores the added field; Cursor requires it. One manifest now satisfies both.

## 4. Variable expansion — the stated difference is confirmed, and is wider

```js
function expandPluginVariables(text, root) {
  return text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => root)
             .replace(/\$\{CURSOR_PLUGIN_ROOT\}/g, () => root);
}
```

- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are **not** expanded — confirmed, as expected.
- `${CLAUDE_PLUGIN_ROOT}` **is** expanded by Cursor, and Cursor's hook environment sets both
  names to the same value:
  `process.env.CURSOR_PLUGIN_ROOT = root; process.env.CLAUDE_PLUGIN_ROOT = root`.
- There is a second, different expansion for configuration objects:
  `A(value)` replaces `${VAR}` from `process.env`, honouring a `${VAR:-default}` form.

Consequence for us: the adapter's existing `${CLAUDE_PLUGIN_ROOT}` usage keeps working under
Cursor unchanged, and the `${CURSOR_PLUGIN_ROOT}` spelling is available if a Cursor-only path
is ever needed. The `${VAR:-default}` form is the one genuinely new capability, and it is a
reason to prefer it for the bridge root once a Cursor probe can confirm it reaches MCP config.

## 5. How a plugin actually gets loaded — narrower than expected

Three separate mechanisms, and only one of them can load a plugin:

| Mechanism | What it does |
|---|---|
| `findClaudePluginRootWithHooks` (gated by the `enable_claude_plugins_root_scan` feature flag) | scans `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` and returns the **first** plugin root containing `hooks/hooks.json`. Its only effect is to set `CURSOR_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT` in the agent-exec environment |
| `loadAllEnabledPlugins` | reads **`~/.claude/plugins/installed_plugins.json`** (`pa()` resolves to `~/.claude`, not `~/.cursor`) and loads what that metadata marks enabled |
| Cursor's own stores | `~/.cursor/plugins/marketplaces`, `~/.cursor/plugins/github-plugins.json` |

Two consequences worth stating plainly:

- The root scan **selects one plugin**, not many — it returns on the first directory with
  `hooks/hooks.json`. A machine with two such plugins gets whichever the directory order
  yields.
- The load path depends on **Claude Code's plugin metadata**. On this machine
  `~/.claude/plugins/installed_plugins.json` **does not exist**, because the Claude adapter was
  installed by linking into `~/.claude/skills/` (which is how Claude auto-loads) rather than
  through Claude's marketplace. Cursor, as a result, currently has nothing of ours to load.
  Cursor does ship the official Claude Code extension
  (`~/.cursor/extensions/anthropic.claude-code-2.1.58-win32-x64`), so the integration is real —
  it just runs through that metadata file.

This also corrects an earlier note of ours: the Claude adapter does *not* end up in
`~/.claude/plugins/cache/` by itself. That path exists only for marketplace installs.

## 6. Where a Cursor MCP config also comes from

`~/.cursor/mcp.json` (user) and `<workspace>/.cursor/mcp.json` (project, prefixed
`project-<n>-<name>-`) are read by the MCP manager as well. Those are user-level
configuration, not part of a portable plugin, and they are the fallback if plugin loading
turns out to be impractical.

## 7. Receiving direction — do not expect automatic injection

Cursor is an editor. A delivery is handed over only to a **running** turn of the receiver's
session, and Cursor has no always-on agent process to be that turn. Unless a probe shows
otherwise, the honest tier for Cursor is:

- **Client → DSH**: expected to work, and testable;
- **DSH → Client**: *pull* — the message waits in the bridge and reaches the model when the
  user's next Cursor turn asks for it (via the skill and the MCP tools), not by injection.

A `SessionStart`-style hook may exist (Cursor validates a Claude-shaped
`hooks/hooks.json`, with `type: command`, `timeout`, and `${CLAUDE_PLUGIN_ROOT}` /
`${CURSOR_PLUGIN_ROOT}` substitution inside hook commands), but **whether it runs, and whether
its output reaches the model, is unverified**. Nothing is claimed here.

## 8. What was measured, and what was not

| Claim | Status |
|---|---|
| Cursor accepts `.claude-plugin/plugin.json` | ✅ code-verified (this build) |
| A root `plugin.json` is accepted | ❌ code-verified as *not* a manifest path |
| `.mcp.json` shape matches ours | ✅ code-verified (`mcpServers`, flat) |
| MCP must be declared by path in the manifest | ✅ code-verified |
| `${CLAUDE_PLUGIN_ROOT}` works under Cursor; `${PLUGIN_ROOT}` does not | ✅ code-verified |
| Plugin loading runs through `~/.claude/plugins/installed_plugins.json` | ✅ code-verified |
| Cursor really loads our plugin and calls the tools | ⏳ **not verified — needs a live agent** |
| Cursor hooks run and inject context | ⏳ **not verified** |

## 9. Freeze conditions for P3.4-A

E1–E10 as agreed, with E5 explicitly allowed to resolve to a *pull* tier rather than a failure:

```text
E1  HarnessMux plugin loads in Cursor
E2  Cursor sees the shared MCP tools
E3  Cursor calls get_status / list_sessions on the shared server
E4  Cursor → DSH delivery, acknowledged            (expected to work)
E5  DSH → Cursor at the next lifecycle event       (pull tier acceptable; injection unverified)
E6  thread/reply correct
E7  session binding does not cross-talk
E8  install / upgrade / uninstall leave the user's configuration intact
E9  no mailbox or protocol logic copied into a Cursor adapter
E10 full regression suite green
```

## 10. Blocker for E1–E7

Unlike Claude Code, Cursor here offers **no non-interactive agent CLI** (`cursor agent` is an
IDE launcher; `cursor --help` exposes only `--add-mcp` and window/CLI plumbing), and the
plugin-load path needs an authenticated Cursor session. Two ways forward:

- **A.** install the adapter through Claude's marketplace so
  `~/.claude/plugins/installed_plugins.json` exists and Cursor's loader has something to read,
  then verify from a Cursor session;
- **B.** skip plugin loading for the first probe and point `~/.cursor/mcp.json` at the shared
  server, which proves E2/E3/E4 through a user-level config and separates "does Cursor speak to
  our MCP server" from "does Cursor load our plugin".

B answers the narrower question first and is the cheaper experiment; A is what the phase is
actually about.
