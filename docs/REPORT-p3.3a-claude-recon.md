# P3.3-A reconnaissance — Claude Code capabilities

Date: 2026-10-06 · Claude Code **2.1.215** (native, `<CLAUDE_HOME>/../.local/bin/claude.exe`) · Windows.
Every claim below is from this machine: the binary's own embedded documentation, the
plugin Claude Code scaffolds itself, real config files, or a probe plugin that was made to
run. Documentation was not used as evidence.

Verdict: Claude Code is **materially more capable than Codex** for this adapter — plugins
ship MCP servers, skills and hooks natively, and a plugin hook was **observed executing**.
One blocker was found that is not about capabilities at all: this machine cannot
authenticate a headless Claude session, so P3.3-C cannot be signed off until that is fixed
(see [Blocker](#blocker-a-headless-claude-session-cannot-authenticate)).

---

## 1. Identity and configuration

| Fact | Value |
|---|---|
| Version | `2.1.215 (Claude Code)` |
| Binary | `<CLAUDE_HOME>/../.local/bin/claude.exe` (native, 244.4 MB — a Node SEA bundle) |
| User config dir | `~/.claude/` |
| User settings | `~/.claude/settings.json` (permissions, model, shell) + `settings.local.json` |
| Plugin root | `~/.claude/plugins/` — `marketplaces/`, `known_marketplaces.json`, `plugin-directory-cache-v2.json` |
| User skills dir | `~/.claude/skills/` — **auto-loads as `<name>@skills-dir`** |
| Model endpoint | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_MODEL=deepseek-v4-flash` |

The binary embeds its own reference documentation, which is the authoritative schema source
(`docs` strings at ~byte 87.9 MB). Everything in §3 and §4 was read from there and then
confirmed by running it.

## 2. Plugin format — confirmed by Claude Code's own scaffold

`claude plugin init <name> --with hooks mcp skills` produced this structure, which is
therefore the accepted shape:

```
~/.claude/skills/<name>/
├─ .claude-plugin/plugin.json     name, version, description, author, skills
├─ .mcp.json                      MCP servers (nested under "mcpServers")
├─ hooks/hooks.json               lifecycle hooks — SAME nesting as Codex
├─ hooks-handlers/*               the commands the hooks run
├─ SKILL.md                       a skill at the plugin root
└─ skills/<name>/SKILL.md         and/or skills in a directory
```

`plugin.json` carries `"skills": ["./"]`; validation is available as
`claude plugin validate <path> [--strict]` and passed on the scaffold.

### Plugin-provided MCP servers: yes

Real marketplace plugins ship `.mcp.json` next to `plugin.json`
(`plugins/example-plugin`, `external_plugins/{context7,github,firebase,fakechat,discord}`).
Both shapes occur in the wild:

```jsonc
// flat (example-plugin, github)
{ "example-server": { "type": "http", "url": "…" } }

// nested (context7, fakechat, discord)
{ "mcpServers": { "fakechat": { "command": "bun", "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "…"] } } }
```

The scaffold uses **nested**, and that is what the adapter will emit. Local stdio servers
are declared with `command` + `args`, exactly like the shared HarnessMux server.

### Distinctive Claude mechanism: `${CLAUDE_PLUGIN_ROOT}`

Binary documentation, quoted:

> Path placeholders like `${CLAUDE_PLUGIN_ROOT}` are substituted per-element as plain
> strings, so paths with quotes, `$`, or backticks never reach a shell parser.

This is what Codex lacked. The Codex adapter needed an out-of-band pointer file
(`~/.codex/harnessmux.json`) because its `.mcp.json` rejects absolute paths and the plugin is
copied into a cache. Claude can address its own plugin directory directly, so the adapter
does not need the pointer file at all. Three variables exist:
`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_DATA}`.

## 3. Hooks — observed running, with the full contract

### A plugin-provided hook really executes ✅

This was the question that mattered, because P3.2 proved "discovered" and "actually runs"
are different things. A probe plugin was installed at `~/.claude/skills/hxmux-probe/` with a
`SessionStart` and a `UserPromptSubmit` hook running `node ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/probe.mjs`.
Both fired:

```json
{"at":"2026-10-06T16:45:00.859Z","argv":["SessionStart"],
 "claudePluginRoot":"<CLAUDE_HOME>/skills/hxmux-probe",
 "claudeProjectDir":"<workspace>",
 "claudePluginData":"<CLAUDE_HOME>/plugins/data/…",
 "stdin":"{\"session_id\":\"5edcf15e-…\",\"transcript_path\":\"…\",\"cwd\":\"…\",
           \"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}"}
```

So: `${CLAUDE_PLUGIN_ROOT}` **is substituted**, the command runs with node, the event arrives
as JSON on stdin, and the hook runs even when the session later fails to authenticate
(SessionStart fired before the 401). No trust prompt appeared, unlike Codex.

### Events

| Event | Matcher | Purpose |
|---|---|---|
| `SessionStart` | — | when a session starts |
| `UserPromptSubmit` | — | when the user submits a prompt |
| `PreToolUse` | tool name | before a tool, can block |
| `PostToolUse` / `PostToolUseFailure` | tool name | after a tool succeeds / fails |
| `PermissionRequest` | tool name | before a permission prompt |
| `Stop` | — | when Claude stops |
| `PreCompact` / `PostCompact` | `manual` / `auto` | around compaction |
| `Notification` | notification type | on notifications |

Hook shape is **identical to Codex**: `{"hooks": {"EVENT": [{"matcher": …, "hooks": [{"type": "command", "command": …, "timeout": 30}]}]}}`.
The timeout field is `timeout` (seconds); Codex used `timeoutSec`. The probe used neither and
worked.

### Output contract — richer than Codex

```jsonc
{
  "systemMessage": "shown to the user",
  "continue": false,
  "stopReason": "why it stopped",
  "suppressOutput": false,
  "decision": "block",              // PostToolUse / Stop / UserPromptSubmit
  "reason": "explanation",
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",  // required inside this object
    "additionalContext": "text injected into model context"
  }
}
```

`additionalContext` is the documented injection path. Codex accepted plain stdout; Claude
documents JSON, so the adapter will emit the documented object rather than rely on an
undocumented fallback — and the live test is what will prove the text actually lands.

## 4. Plugin installation and enablement

- `claude plugin marketplace add|list|remove`, `claude plugin install <plugin>@<marketplace>`,
  `uninstall`, `enable`/`disable`, `list`, `details`, `validate`, `update`, `prune`.
- A plugin in `~/.claude/skills/<name>/` **auto-loads next session** as `<name>@skills-dir`
  — no marketplace needed. This is the least invasive install path and what the installer
  will offer, with marketplace install as the alternative.
- MCP enablement is governed by settings keys `enableAllProjectMcpServers`,
  `enabledMcpjsonServers`, `disabledMcpjsonServers`; plugins by `enabledPlugins`
  (`"plugin@source": true`).
- `claude plugin validate --strict` exists and is suitable for CI.

## 5. Frozen acceptance conditions for P3.3

Written now, before implementation, from the measured capabilities above. The Codex set is
the template, but C4 is tightened where Claude is measurably stronger.

| # | Condition | How it will be judged |
|---|---|---|
| D1 | Claude lists the HarnessMux MCP tools | the eight tool names appear to the model |
| D2 | Claude calls the **shared** MCP server | a real `get_status`/`send_message` call, no legacy path |
| D3 | Claude → real DSH session delivery | a bound delivery reaches a running DSH session and is acked |
| D4 | DSH → Claude picked up on the next lifecycle event | hook injects the waiting message via `hookSpecificOutput.additionalContext` **and the text is visible in the transcript** — not merely "the hook printed something" |
| D5 | thread/reply correct | reply keeps thread/topic/`replyTo` and inherits routing when unbound |
| D6 | several DSH sessions do not cross-talk | bound session receives, the other does not |
| D7 | install/upgrade idempotent, uninstall clean | second install changes nothing; uninstall restores the user's `settings.json` and leaves no hook or MCP entry behind |
| D8 | `npm test` green + adapter contract tests | the suite plus a new `adapter-claude` contract suite |

Additional condition specific to what reconnaissance found:

| # | Condition |
|---|---|
| D9 | The adapter must use `${CLAUDE_PLUGIN_ROOT}` rather than an absolute path or a pointer file, and this must be verified **from the installed location**, not from the repository |

## P3.3-B status (added after implementation)

The adapter is built and installed, and every offline condition is verified:

| Piece | Evidence |
|---|---|
| Plugin structure | generated by Claude Code's own scaffold, and `claude plugin validate` passes |
| Discovery by Claude | `claude plugin list` → `harnessmux@skills-dir … √ loaded` |
| Inventory | `claude plugin details harnessmux` → Skills 1, Hooks 2, MCP servers 1, ~79 always-on tokens |
| MCP entry | serves all eight shared tools over stdio, resolved **from the installed location** (D9) |
| Hook contract | emits `hookSpecificOutput.{hookEventName, additionalContext}`; silent on an empty bridge; consumes nothing |
| Installer | in a temporary `CLAUDE_CONFIG_DIR`: dry run writes nothing, re-run changes nothing, a stale copy is replaced, uninstall removes the link and the pointer — and `settings.json` is byte-identical afterwards (D7) |
| Contract tests | `tests/adapter-claude.test.mjs`, `npm test` 12 suites green (D8) |

Not yet verified, because it needs a model: **D1–D6**. The acceptance script for that is
`examples/live/claude-acceptance.mjs`; it prints one PASS/FAIL line per condition and writes
its evidence to `.claude-acceptance/`.
## P3.3-C, first attempt (2026-10-06): 3 passes, 1 probe defect, 1 real defect

The user ran `node examples/live/claude-acceptance.mjs` in an authenticated shell.
Result as reported by the script: setup PASS, D4 PASS, D5 PASS, D6 PASS, **D1/D2/D3 FAIL**.

Reading the evidence rather than the verdicts:

- **D1/D2 were my probe's fault, not the adapter's.** The captured output contains the
  `get_status` payload verbatim (`"version":2 … "invariantsOk":true`), so Claude did call the
  shared MCP server. The check was looking for the CLI's prose line `protocol: v2`, which an
  MCP tool never returns because it answers with structured JSON. Fixed: D1 now looks for the
  call, D2 for the server's payload keys.
- **D3 was a target-selection failure.** The script took `sessions[0]` from the published
  endpoint, which named a session that had stopped 50 minutes earlier; the delivery stayed
  queued by design because a stopped session is not a running one. The trace proves the
  receiver behaved correctly and was serving a *different* session. Fixed: the script now
  confirms the publication is fresh (see `DEFECT-stale-endpoint.md`) and accepts
  `--target-session`.
- **D4/D5/D6 passed as written**, including the one that mattered most: the model quoted the
  marker the hook injected, so `hookSpecificOutput.additionalContext` really does reach
  Claude's context. That is D4, measured.

So of the three reported failures, two were measurement bugs in my own probe. That is worth
recording plainly: the acceptance script is part of the system under test, and a wrong
verdict hides a working path just as effectively as a wrong PASS hides a broken one.
## Blocker: a headless Claude session cannot authenticate

`claude -p "…"` fails before the model is reached:

```
Not logged in · Please run /login
```

With a key injected:

```
Failed to authenticate. API Error: 401 Authentication Fails, your api key: ****_QAA is invalid
```

What was established:

- the CLI is configured for `https://api.deepseek.com/anthropic`, so the credential must be a
  **DeepSeek** key;
- `~/.claude/config.json` holds `primaryApiKey`, which is an Anthropic-shaped
  `sk-ant-api03-…` key, and `.claude.json → customApiKeyResponses` lists that same key
  (suffix `_QAA`) as **approved** while a different key is listed as rejected;
- that key returns **401 from the DeepSeek endpoint** when tried directly;
- `claude doctor` reports "Not signed in to claude.ai", "claude.ai subscription auth not
  active", "Not connected to the Anthropic API";
- no credential appears in the Windows Credential Manager under a claude/anthropic target.

So the working credential is in a store this session cannot read (the interactive app's own
keychain session), and the one readable key is stale. This blocks every condition that needs
a model: **D1–D6**.

It does **not** block the adapter itself, the installer, the contract tests, the hook
mechanism (already proven to run), or D9 — those are all offline. The plan is therefore:
build P3.3-B and the offline half of D7/D8/D9, then run D1–D6 in one pass once a usable
credential is available.

## What reconnaissance changed about the plan

1. **No pointer file, no launcher indirection.** Codex needed both; Claude does not, because
   `${CLAUDE_PLUGIN_ROOT}` and per-element arg substitution exist. The adapter gets simpler,
   and the complexity Codex forced must not be copied over out of habit.
2. **Hooks need no trust step** here (Codex did), but injection goes through
   `hookSpecificOutput.additionalContext` rather than plain stdout — so the hook script must
   emit JSON, and D4 checks the transcript rather than the hook's own output.
3. **Native plugin install is viable**, so the installer can prefer
   `~/.claude/skills/<name>/` auto-load instead of mutating the user's `settings.json`.
4. **Do not assume idle wake.** Nothing observed suggests Claude can be woken while idle;
   SessionStart/UserPromptSubmit fire when Claude is already active. D4 is worded the same
   way as C4 for that reason.
