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
| Session routing: bound session receives, a second live session does not | ✅ verified |
| Unbound delivery is never consumed (`awaitingBinding`) | ✅ verified |
| Crash between a successful hand-off and the ack | ✅ verified: **duplicate, not lost** |
| Lease-based recovery, retry backoff, watcher singleton | ✅ verified |
| v1 → v2 migration: legacy ids kept, `read/` never becomes an ack, idempotent | ✅ verified |
| Provider-facing tool contract (the model really calls the tool) | ✅ verified |

Honest boundaries — read these before deploying:

| Boundary | Detail |
|---|---|
| **No idle wake** | Delivery happens while the session is running. An idle session is not woken; the delivery waits. *Running session → near-real-time; idle session → next time it runs.* |
| **Not exactly-once** | The transport is at-least-once by design. Consumers tolerate duplicate delivery ids. |
| **Clients other than Codex** | **Planned**, not supported yet (P3.3/P3.4). Each will be listed here only after it is verified the way Codex was. |
| **One receiver** | DeepSeek Harness is the only receiver implemented. The receiver interface is specified, not built ([receiver-api.md](docs/receiver-api.md)). |

## Quick start

```sh
git clone <this repo> agent-interlink
cd agent-interlink
node lib/mailbox-v2.mjs --root ./bridge init
npm test                       # 8 suites, offline, no API keys
```

Send a message and watch it be delivered:

```sh
node lib/mailbox-v2.mjs --root ./bridge endpoint --id dsh-endpoint --actor dsh
node lib/mailbox-v2.mjs --root ./bridge send --from codex --topic "ship it" --body "run the suite"
node lib/mailbox-v2.mjs --root ./bridge bind  <threadId> --endpoint dsh-endpoint --session <sessionId> --mode delegated
node lib/mailbox-v2.mjs --root ./bridge inbox --actor dsh
```

Ask a **live** session to prove the loop (`<sessionId>` is what your client/harness
reports; with DSH it is `$DSH_SESSION_ID`):

```sh
node tests/ask-session.mjs <sessionId> --marker HELLO-1
# status goes queued → acked while that session is running a turn
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

**Codex** — `packages/adapter-codex/` ships the Codex manifest, a skill and an opt-in
hook template, plus a local marketplace:

```sh
codex plugin marketplace add <path to this repo>
codex plugin add harnessmux@harnessmux
```

**Claude Code, Cursor, VS Code / Copilot** — planned adapters (P3.3/P3.4). They reuse
the same MCP tools, so the work is a manifest plus a thin adapter, not another client
implementation.

**Anything else** — the CLI is a first-class surface, not a fallback: it is the
debugging path, the CI path, and the integration path for languages and clients this
project will never have a plugin for.

## Layout

```
packages/core/           protocol v1 + v2 + migration (platform-independent, no deps)
packages/cli/            the harnessmux CLIs (send/reply/deliver/inbox/claim/ack/verify/…)
packages/mcp/            the shared MCP tool layer every client uses
packages/portable-plugin/ shared client assets: skill, MCP registration, path resolution
packages/adapter-codex/  the Codex client plugin (manifest, skill, hook template)
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
npm test          # 9 suites: protocol, CLI, migration, receiver, MCP contract, faults
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
