# HarnessMux

> **Control DeepSeek Harness from the AI client you already use.**
>
> A plugin-first interoperability layer for AI clients and DeepSeek Harness.

```text
Codex • Claude Code • Cursor • VS Code / Copilot • MCP clients
                          │
                          ▼
                      HarnessMux
                          │
                          ▼
                   DeepSeek Harness
```

- ✓ **Plugin-first** — install into the harness, install into your client, done
- ✓ **Existing live sessions** — reaches a DSH session you already have open
- ✓ **Durable messaging** — a message that arrives while nothing runs is kept, not dropped
- ✓ **Session-aware routing** — one explicit binding decides the target; never a guess
- ✓ **Crash-safe** — at-least-once, with the crash window tested: duplicate, not lost
- ✓ **Offline / async** — reports, questions and notes travel too, not just work orders
- ✓ **No copy-pasting between agents**

English | [中文](README.zh.md)

---

## What it is for

You already live in one AI client. The work you want done lives in DeepSeek Harness.
This project connects the two without making you the courier:

| You want | This gives you |
|---|---|
| To direct DSH work from your editor or CLI | a mailbox tool your client calls |
| Instructions to survive a closed laptop or a crash | durable delivery with leases, retry and an audit trail |
| To reach the session you have open right now | live-session delivery, targeted by an explicit binding |
| To keep sessions apart | `actor / endpoint / session / thread` are distinct; an unbound thread stays unbound |
| A peer to ask *you* something | bidirectional threads; replies stay on their thread |
| Safety while doing it | `advisory` vs `delegated` trust, decided per binding |

### The loop, end to end

The point of the whole thing is that you never touch DSH to get DSH working. Verified on a real
machine in both directions:

```text
you, in Codex        "Use HarnessMux to have the current DSH session reply: CURRENT_SESSION_OK_7F3A"
   │
   ├─ Codex calls send_message  ──►  bridge  ──►  DSH receiver
   │                                                  │
   │                                    thread is bound to that session, mode=delegated
   │                                                  │
   │                                    session idle? ──► resume + followup ──► a turn opens
   │                                                  │        (you watch it run in the DSH UI)
   │                                                  │
   │                                    delivery acked, note=woken, attempt=1
   │                                                  │
   ◄─ reply_message, addressed to the asker ──────────┘
   │
   └─ Codex's next SessionStart / UserPromptSubmit surfaces the answer as context
```

What that means in practice:

- **You do not press Enter in DSH.** An instruction addressed to an idle, explicitly bound session
  opens the turn itself. Worst-case latency is one watch tick (10 s by default, `watchIntervalMs`).
- **You can watch it.** The work happens in a real session with a real transcript — model output and
  tool calls — not in a hidden worker.
- **Only an authorized binding wakes anything.** `delegated` delivery **and** a `delegated` binding.
  An `advisory` note to an ordinary conversation still waits for you, and an unbound thread stays
  unbound instead of being guessed at.
- **The answer comes back on its own thread**, addressed to whoever asked, and Codex picks it up on
  its next lifecycle event. Codex cannot be woken while it is idle — that is a host boundary, not a
  promise this project breaks.

### Check that it is actually live

A mounted plugin is not hot-reloaded, so **restart DeepSeek Harness after installing or updating
it**. Whether the running process has the wake capability is readable from its own trace — an older
receiver and a current one are otherwise indistinguishable:

```sh
grep 'apply: root=' <bridge>/plugin-debug.log | tail -1
# apply: root=… endpointId=dsh-endpoint protocol=v2 autoWake=true \
#   currentSessionControl=true watchMs=10000 agentsInjected=true
```

`currentSessionControl=true` is the flag that decides whether an idle bound session can be woken.
If the line is missing it, the process predates the feature: restart.

After a delegated task, the same trace says what happened, and the difference between a delivered
instruction and a woken one is one word:

```sh
grep -E 'pump: (claimed|woke|skip)' <bridge>/plugin-debug.log | tail -5
```

- `pump: claimed <id> attempt=1` then `pump: woke <session> for <id> attempt=1` — the session was
  woken and the delivery is acked with `note=woken`;
- `no wake for <id> (mode=advisory, delegatedBinding=false)` — it was declined on purpose, and the
  trace names which condition was missing;
- `skip <id> session A != B` — the delivery belongs to a different session than the one being
  considered, which is the isolation working.

### How this differs from worker orchestrators

External orchestrators dispatch a task and launch or manage a **worker** to run it.

> Unlike worker orchestrators, this project can deliver messages to **existing**
> DeepSeek Harness sessions instead of requiring every task to run in a newly spawned
> worker.

So the target can be a session a human is watching; work arriving mid-turn joins that
turn; work arriving while nothing runs **waits** and is delivered when the session next
runs; and the same substrate carries offline notes and questions, not only tasks. A
managed-worker mode is planned as a separate later mode (P5), not as a replacement.

## Status: what is verified, and what is not

Verified end to end on a real machine with a real model
([full report](docs/REPORT-p0.5-cutover.md)):

| Capability | State |
|---|---|
| Delivery into a **running** DSH session (claim → steer → ack, exactly once) | ✅ verified |
| **Waking an idle session** that is explicitly bound and `delegated` (resume → followup → new turn) | ✅ verified |
| A delegated instruction reaching the model's own session transcript | ✅ verified (marker read back from the session log) |
| The answer returning to the asking client, addressed by actor | ✅ verified (surfaced by Codex's own pickup hook) |
| Session routing: bound session receives, a second live session does not | ✅ verified |
| An `advisory`/unbound delivery is never woken and never consumed (`awaitingBinding`) | ✅ verified |
| Crash between a successful hand-off and the ack | ✅ verified: **duplicate, not lost** |
| Lease-based recovery, retry backoff, watcher singleton | ✅ verified |
| v1 → v2 migration: legacy ids kept, `read/` never becomes an ack, idempotent | ✅ verified |
| Provider-facing tool contract (the model really calls the tool) | ✅ verified |

Honest boundaries — read these before deploying:

| Boundary | Detail |
|---|---|
| **Idle wake needs authorization** | Only a `delegated` delivery on an explicitly `delegated` binding opens a turn in an idle session. An `advisory` note to an ordinary conversation still waits for you, and a delivery with no binding stays queued. That is deliberate: a peer's note must not seize a session a human is using. |
| **Worst-case wake latency** | One watch tick — 10 s by default, `watchIntervalMs` per plugin row, floor 250 ms. |
| **Results are returned by the model's tool call** | The DSH model calls `reply_message`; automatic capture of the final assistant text at `turn_end` is **not implemented yet** ([why it is reachable](docs/REPORT-current-session-control.md)). |
| **Not exactly-once** | The transport is at-least-once by design. Consumers tolerate duplicate delivery ids. |
| **Codex cannot be woken while idle** | A host boundary. DSH's reply is held durably and surfaced on Codex's next `SessionStart`/`UserPromptSubmit`; it is never lost, and never interrupts. |
| **Clients beyond Codex and Claude Code** | **Planned** (P3.4). Codex and Claude Code are each verified end to end on a real machine (see *Connect a client*); every other client is listed only after it is verified the same way. Codex's **desktop app** does not load third-party MCP servers, so drive Codex from its CLI. |
| **One receiver** | DeepSeek Harness is the only receiver implemented. The receiver interface is specified, not built ([receiver-api.md](docs/receiver-api.md)). |

## Quick start

```sh
git clone <this repo> agent-interlink
cd agent-interlink
node packages/cli/mailbox-v2.mjs --root ./bridge init
npm test                       # 14 suites, offline, no API keys
```

Send a message and watch it be delivered:

```sh
node packages/cli/mailbox-v2.mjs --root ./bridge endpoint --id dsh-endpoint --actor dsh
node packages/cli/mailbox-v2.mjs --root ./bridge send --from codex --topic "ship it" --body "run the suite"
node packages/cli/mailbox-v2.mjs --root ./bridge bind  <threadId> --endpoint dsh-endpoint --session <sessionId> --mode delegated
node packages/cli/mailbox-v2.mjs --root ./bridge inbox --actor dsh
```

Ask a session to prove the loop (`<sessionId>` is what your client/harness reports):

```sh
node examples/live/ask-session.mjs <sessionId> --marker HELLO-1
# a delegated, bound session is woken even when idle: status goes queued → acked with note=woken
# an advisory or unbound one waits: status stays queued until that session is running a turn
```

The delivery lands in the first turn of that session still running when the pump ticks
(every 10 s). If the session is idle it correctly waits in `queue/` — see the
boundaries above.

## Install into DeepSeek Harness

The receiver is a DSH profile bundle (a Cordis plugin mounted from your profile patch):

```sh
node scripts/install.mjs --dsh-profile desktop     # wires package.json + cordis.patch.yml
# then restart the harness: a mounted plugin is not hot-reloaded
```

`--dry-run` prints the plan, `--print-only` prints the equivalent manual steps. The
installer edits only your profile, writes `.bak-<timestamp>` copies, and is idempotent.

Confirm inside a session: ask the agent to run `mailbox action=status`. It should
answer `protocol: v2 … invariants=ok`.

## Connect a client

Any MCP-capable client gets the mailbox tools from one shared server:

```sh
node packages/mcp/server.mjs            # stdio; run it from the client's MCP config
```

```jsonc
// what a client config needs — absolute paths, because MCP clients do not resolve
// package names here (packages/portable-plugin/index.mjs prints this for you)
{
  "mcpServers": {
    "harnessmux": {
      "command": "node",
      "args": ["<repo>/packages/mcp/server.mjs"],
      "env": { "HARNESSMUX_DIR": "<bridge root>", "HARNESSMUX_ACTOR": "client" }
    }
  }
}
```

The eight tools every client sees — `send_message`, `read_messages`, `reply_message`,
`list_threads`, `list_endpoints`, `list_sessions`, `bind_thread`, `get_status` — all
call the same protocol-v2 core, so no client can observe a different meaning of `ack`,
delivery, lease or binding. Their contract (names, schemas, error semantics, and
behaviour against the same v2 state) is pinned by `tests/mcp-contract.test.mjs`.

**Codex** — the adapter is a manifest, a `.mcp.json`, one skill and two hooks. The
installer writes everything Codex needs outside its own plugin cache:

```sh
node scripts/install.mjs --codex          # pointer file, skill, lifecycle hooks
codex plugin marketplace add <this repo>
codex plugin add harnessmux@harnessmux
```

Verified against Codex CLI 0.154.0 on a real machine: Codex listed the eight MCP tools,
called `get_status` and `send_message` through them, a `delegated` message was delivered
into a running DeepSeek Harness session, and the lifecycle hook put the harness's reply
into Codex's context on the next turn.

Two things worth knowing, both found by running it rather than by reading about it:

- **Hooks need trust.** Codex will not run a newly written hook until it is trusted; in a
  non-interactive run that appears as `hook: SessionStart Failed`. Approve it once in an
  interactive session, or pass `--dangerously-bypass-hook-trust` when you have vetted the
  command yourself.
- **`plugin_hooks` is removed in 0.154.0.** Hooks shipped inside a plugin are ignored, so
  the installer writes them into `~/.codex/hooks.json` instead, with **absolute** paths:
  Codex resolves a hook command against `~/.codex`, not against the plugin root, and a
  relative command there fails with `Cannot find module`.
- **The MCP command is addressed by absolute path, because the desktop host has no node on its
  PATH.** `.mcp.json` says `"command": "node"`, which the CLI resolves and the Codex desktop app
  does not — its log recorded `mcp_extension_tool_discovery_failed … "MCP startup failed: No such
  file or directory (os error 2)" pluginId=harnessmux@harnessmux`. The plugin was installed,
  enabled and *discovered*, and its server was never started.

  `scripts/install.mjs --codex` therefore rewrites the copies Codex loads so that **both** the
  interpreter and the launcher are absolute. The launcher matters as much as node: as
  `./scripts/launch-mcp.mjs` with `"cwd": "."`, the host resolved both against *its own* working
  directory, which reproduces as `Cannot find module '…\scripts\launch-mcp.mjs'` — the same
  `os error 2`. The `cwd` field is dropped for that reason.

  **On Windows the entry goes through `cmd.exe` and a shim instead of naming node at all.** An
  absolute node path is only correct until that node disappears, and the obvious candidate —
  Codex's own runtime — lives in a *versioned* directory (`runtimes\cua_node\<hash>\bin\node.exe`)
  that an update replaces; that broke this plugin twice, taking the MCP server and the hooks down
  together. So the config names `…\System32\cmd.exe` (permanent, findable by name) and
  `scripts/node-shim.cmd`, which resolves node at spawn time: `HARNESSMUX_NODE` → a `node.exe`
  beside the shim → `node` on PATH (nvm/fnm/volta) → every Codex runtime, newest first. The hooks
  use `scripts/pending-shim.cmd` the same way. On other platforms the launcher is used directly
  with the resolved node.

  Two rules follow from that, both enforced by tests:

  - **The `.cmd` files must stay pure ASCII.** cmd.exe parses a `.cmd` in the console's OEM code
    page, not as UTF-8, so one non-ASCII byte splits into several characters that cmd then tries to
    run as commands. A single em dash produced 31 lines of `'m' is not recognized …` on a
    Chinese-locale Windows while the hook itself still worked.
  - **An upgrade replaces our hooks rather than adding to them.** The ownership test recognises
    both the old `pending.mjs` form and the shim form, so re-running the installer leaves exactly
    one hook per event and never touches anyone else's entries.

  Node is chosen in this order: `HARNESSMUX_NODE` (or `CODEX_MCP_NODE_PATH`) → a system
  installation → whatever `node` resolves to on your PATH → the runtime Codex itself ships → the
  interpreter that ran the installer. **If none of those is right for your machine, set
  `HARNESSMUX_NODE` and re-run.** The repository keeps the portable template, because absolute
  paths there would publish one machine's layout.

  Two consequences worth knowing:

  - **Order matters.** Run `codex plugin add harnessmux@harnessmux` *first*, then re-run the
    installer: the plugin is copied into `<CODEX_HOME>/plugins/cache/`, and that copy is what
    needs the absolute path. The installer says so when it finds no cache yet, and it walks the
    cache (rather than a pinned version directory) so an update cannot leave a stale path behind.
  - **A path can go stale.** If you uninstall the runtime that was chosen, or reinstall the plugin
    without re-running the installer, the server will not start; re-running the installer fixes
    it, and the desktop log names the reason.

The pick-up hook is a *pull*: it lists what is waiting and never consumes it, so an idle
Codex is not woken — it simply loses nothing. `node scripts/install.mjs --codex --uninstall`
removes exactly what the installer added and leaves your own hooks untouched.

**Claude Code** — the adapter is a plugin that ships its own `.mcp.json`, skill and hooks,
addressed through `${CLAUDE_PLUGIN_ROOT}` so nothing is machine-specific:

```sh
node scripts/install.mjs --claude --link   # links into ~/.claude/skills/harnessmux
# then restart the session (or /reload-plugins); it loads as harnessmux@skills-dir
```

Verified against Claude Code 2.1.215 on a real machine, on the same conditions as Codex:
`claude plugin details` reports the plugin loaded with 1 skill, 2 hooks and 1 MCP server;
Claude called the shared tools, a `delegated` message reached a running DeepSeek Harness
session, and a message waiting for Claude was quoted back by the model on its next turn
(through `hookSpecificOutput.additionalContext`). See
[docs/REPORT-p3.3c-claude-acceptance.md](docs/REPORT-p3.3c-claude-acceptance.md).

Worth knowing: Claude needs **no trust step** for plugin hooks (Codex does), and it resolves
its own plugin directory, so the adapter carries no pointer file for that purpose.

**Cursor** — its plugin loader was read on Cursor 2.5.25, and it accepts
`.claude-plugin/plugin.json` (a root `plugin.json` is **not** one of its manifest paths), reads
MCP from `.mcp.json`/`mcp.json` keyed by `mcpServers`, and expands `${CLAUDE_PLUGIN_ROOT}` as
well as `${CURSOR_PLUGIN_ROOT}`. Two consequences: the Claude-shaped adapter is already one of
the layouts Cursor accepts, and Cursor requires MCP to be **declared** —
`"mcpServers": "./.mcp.json"`, which the adapter manifest now does (Claude ignores the field).
Loading a plugin runs through `~/.claude/plugins/installed_plugins.json`, which does not exist
when the adapter is installed by linking into `~/.claude/skills/`. Details, including what is
*not* yet verified, are in [docs/REPORT-p3.4a-cursor-recon.md](docs/REPORT-p3.4a-cursor-recon.md).

**VS Code / GitHub Copilot** — planned, and **the client is not installed on the machine this
was developed against** (`code --list-extensions` has no `github.copilot*`), so nothing about
Copilot is claimed. See [docs/REPORT-p3.4b-copilot-recon.md](docs/REPORT-p3.4b-copilot-recon.md).

**Anything else** — the CLI is a first-class surface, not a fallback: it is the
debugging path, the CI path, and the integration path for languages and clients this
project will never have a plugin for.

## Layout

```
packages/core/           protocol v1 + v2 + migration (platform-independent, no deps)
packages/cli/            the harnessmux CLIs (send/reply/deliver/inbox/claim/ack/verify/…)
packages/mcp/            the shared MCP tool layer every client uses
packages/portable-plugin/ shared client assets: skill, MCP registration, path resolution
packages/adapter-codex/  the Codex adapter (manifest, .mcp.json, launcher, hooks)
packages/receiver-dsh/   the DeepSeek Harness **receiver** (tool + briefing + pump)
docs/positioning.md      what the project is, and what it deliberately does not claim
docs/roadmap.md          phases, the planned repo layout, and the open decisions
docs/receiver-api.md     the receiver interface + capability model (specification)
docs/adr/                decisions with their reasoning (e.g. why MCP is hand-rolled)
docs/protocol.md         the wire format and its invariants
docs/cutover.md          how to switch a live bridge from v1 to v2
docs/REPORT-*.md         a real cutover, with evidence and the defects it uncovered
DESIGN.md                the engineering record and its review verdicts
examples/live/           live probes and field diagnostics (need a real harness)
tests/                   the suites (below)
tools/relink.mjs         repairs relative imports after a layout move
```

## Tests

```sh
npm test          # 14 suites: protocol, CLI, migration, receiver, MCP contract, adapters, faults
npm run test:live # against a real DSH harness + real model (needs DSH installed)
npm run mcp       # start the MCP server by hand to inspect the roster
```

| Suite | What it pins |
|---|---|
| `mailbox.test.mjs` | v1 protocol regression |
| `protocol-v2.test.mjs` | state invariants + fault injection T1–T15 |
| `cli-v2.test.mjs` | the CLI surface and its exit codes (0/1/3/4/5) |
| `migrate.test.mjs` | legacy ids, `read/` ≠ ack, conflict abort, idempotency |
| `manifest.test.mjs` | the DSH bundle contract, and that tests never touch the root cache |
| `plugin.test.mjs` | provider-facing tool descriptor, output contract, injected-message ids |
| `plugin-v2.test.mjs` | claim→steer→ack, release on failure, session isolation, unrouted safety |
| `mcp-contract.test.mjs` | the client-visible tool roster, schemas, envelopes and error semantics |
| `cutover-faults.test.mjs` | steer failure, the crash window, long-lease restart |

The live probes and the installer resolve the host from the environment, so nothing
hard-codes a machine: set `DSH_CLI` (launcher path) or `DSH_INSTALL_ROOT` (install
directory), and `HARNESSMUX_CWD` (the workspace probe sessions should use).

A pre-commit hook blocks absolute developer paths and credentials from entering this
repository's history:

```sh
sh scripts/install-hooks.sh    # once per clone (hooks are not versioned)
```

## Security

Mailbox content is written by another agent, which may itself have been influenced by
untrusted input. Treat it as a peer's request, never as authority:

- a human instruction in the session always outranks mailbox content;
- `advisory` deliveries are context; only `delegated` ones are work orders;
- destructive, credential-related or outward-facing actions still need human approval;
- never write secrets into the bridge — the audit stream keeps every message.

## License

MIT — see [LICENSE](LICENSE).
