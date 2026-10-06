# Roadmap

Two things this page keeps straight:

1. **what is proven** — everything below P3 was validated on a real machine, with a
   real model, and keeps its evidence in [REPORT-p0.5-cutover.md](REPORT-p0.5-cutover.md);
2. **what is planned** — P3 onward, deliberately shaped around *client* breadth first
   and *receiver* breadth later.

Positioning is owned by [positioning.md](positioning.md); the wire format by
[protocol.md](protocol.md); the receiver interface by [receiver-api.md](receiver-api.md).

---

## Done (verified)

| Phase | Deliverable | Status |
|---|---|---|
| P0 | Mailbox v1: durable files, atomic writes, CLI | ✅ |
| P0.5 | Protocol v2: immutable `messages/`, `queue → claim(lease) → ack`, bindings, endpoints, advisory/delegated, audit + gc, fault injection T1–T15 | ✅ 8 suites green |
| P1 | **DSH Native Receiver**: mailbox tool, session briefing, delivery pump (single watcher, backoff, release-on-failure) | ✅ validated in a live session with a real model |
| P2 | Real DSH / provider validation: tool descriptor accepted by the provider, delivery into a running Desktop session, migration of a live v1 bridge | ✅ `P0.5 CUTOVER PASS WITH DOCUMENTED LIMITATION` |

Verified base capabilities that later phases must not weaken:

```text
running session            near-real-time delivery (queued → steered → acked in one turn)
idle session               delivery waits in queue/ (no wake) — a boundary, not a bug
guarantee                  at-least-once; the crash window is duplicate-but-not-lost
routing                    actor / endpoint / session / thread are distinct
multi-session isolation    only the bound session receives
recovery                   lease-based; no early re-delivery while a lease is valid
migration                  legacy ids preserved; v1 read/ never becomes an ack; idempotent
provider contract          the compiled tool descriptor is what the model actually gets
```

## Next

### P3 — Portable Client Plugin *(the current focus)*

One shared client layer, thin per-client adapters. A copy of the whole plugin per
client is explicitly rejected.

| Phase | Deliverable | Status |
|---|---|---|
| **P3.1** | **Portable core**: shared MCP tool layer, mailbox skill, MCP registration, packaging notes | ✅ MCP server built and contract-tested (`packages/mcp/`), shared assets in `packages/portable-plugin/` |
| **P3.2** | **Codex adapter**: the shared MCP server, lifecycle hooks, packaging, install/uninstall | ✅ **verified on a real machine** — Codex 0.154.0 listed the eight tools, called them, and a `delegated` message reached a running DSH session; see [REPORT-p3.2](REPORT-p3.2-codex-adapter.md) for C1–C8 and the two hook-transport defects it uncovered |
| **P3.3** | **Claude Code adapter**: plugin manifest, `${CLAUDE_PLUGIN_ROOT}`-addressed MCP entry, lifecycle hooks, installer | ✅ **verified on a real machine** — `claude plugin details` shows the plugin loaded with 1 skill, 2 hooks and 1 MCP server, and D1–D9 pass; see [REPORT-p3.3c](REPORT-p3.3c-claude-acceptance.md) for the acceptance and [REPORT-p3.3a](REPORT-p3.3a-claude-recon.md) for the reconnaissance that shaped the adapter |
| **P3.4-A** | **Cursor adapter**: reuse the portable core where Cursor accepts it, add only what is Cursor-specific | 🔍 **reconnaissance done** — [REPORT-p3.4a](REPORT-p3.4a-cursor-recon.md): Cursor accepts `.claude-plugin/plugin.json` (not a root `plugin.json`), requires MCP to be declared as `"mcpServers": "./.mcp.json"`, expands `${CLAUDE_PLUGIN_ROOT}`/`${CURSOR_PLUGIN_ROOT}` but not `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`, and loads plugins through `~/.claude/plugins/installed_plugins.json`. The one-line manifest change is applied and verified not to affect Claude. Live verification blocked: Cursor has no non-interactive agent CLI |
| **P3.4-B** | **VS Code / GitHub Copilot adapter**: same method — portable core first, `com.github.copilot/` only for what is genuinely client-specific | ⛔ **blocked: GitHub Copilot is not installed on this machine** (`code --list-extensions` has no `github.copilot*`; VS Code 1.140 ships none). See [REPORT-p3.4b](REPORT-p3.4b-copilot-recon.md); every E-condition needs the client itself, and substituting another extension would produce evidence that does not belong to this row |
| **P3.5** | **Compatibility matrix + CI** | ⏳ |

**P3.1 decided two open questions** (see the ADR for the reasoning):

- **D2 — packaging format.** MCP-first for tools: `packages/mcp/server.mjs` exposes
  the mailbox as eight MCP tools over stdio, and the CLI stays for debugging, CI, and
  clients without MCP. Client adapters consume `@harnessmux/portable-plugin` for paths
  and registration instead of copying anything.
- **The MCP SDK question** — hand-rolled rather than the official SDK, because the SDK
  brings an HTTP stack this layer does not offer:
  [ADR 0001](adr/0001-mcp-server-transport.md). Revisit when Streamable HTTP is
  actually needed.

The mailbox tools every client sees (contract-tested in `tests/mcp-contract.test.mjs`):

```text
send_message   read_messages   reply_message   list_threads
list_endpoints list_sessions   bind_thread     get_status
```

### P4 — Install / Update / UX

Target: **Install → Restart → Connect**, with the internals invisible.

```text
DSH side      install plugin      → restart → receiver online
Client side   install plugin      → MCP + skills + hooks registered → ready
Discovery     list endpoints and eligible sessions → human confirms a binding
```

Installers must stay idempotent, back up what they touch, and work on a machine that
has never seen this project. Internals (`bridge root`, `endpointId`, `lease`, `claim`)
belong in the reference docs, not in the first-run path.

### P5 — Managed MCP → ACP mode

A second mode, not a replacement:

```text
Mode A — Live / Async   (current): durable messages into existing DSH sessions
Mode B — Managed / ACP  (planned): client → MCP → bridge → ACP → a DSH worker
```

Mode B is what worker orchestrators do well; it is worth having for disposable,
parallel workers. It is **not** the project's differentiator, and P3 does not wait
for it.

### P6 — Generic Receiver API

```text
P6.1  implement a second receiver (Codex receiver, or a generic pull receiver)
P6.2  validate the abstraction against both receivers; fix the interface where it lied
```

[receiver-api.md](receiver-api.md) is the specification. The interface is **not**
retro-fitted onto the DSH receiver yet: an abstraction with one implementation encodes
guesses, and the second implementation is what turns it into knowledge.

### P7 — Public release / docs / ecosystem

Versioning, changelog, packaging (DSH bundle on npm, client plugins where each host
supports it), the compatibility matrix as a published document, and the naming
decision finally applied.

---

## Planned repository layout (not yet applied)

Recorded now so the P3 work has a target; **not** executed this round, because moving
verified code to make a diagram prettier is a bad trade.

```text
repo/
├─ packages/
│  ├─ core/                 # protocol v2 (platform-independent)
│  ├─ cli/
│  ├─ mcp/
│  ├─ portable-plugin/      # shared client metadata, skills, tools
│  ├─ adapter-codex/
│  ├─ adapter-claude/
│  ├─ receiver-api/
│  ├─ receiver-dsh/         # today's plugin/, unchanged in behaviour
│  └─ acp/                  # P5
├─ docs/
├─ tests/
├─ examples/
└─ package.json
```

The move happens once, together with the rename, when P3.1 starts. Until then the
current flat layout is the source of truth, and the existing paths in `README.md`
match it.

---

## Decisions open

| # | Decision | Needed by | Current state |
|---|---|---|---|
| D1 | ~~Final project name~~ | — | ✅ **decided: HarnessMux** (directory/package/CLI use `harnessmux`; rationale in [positioning.md §9](positioning.md)) |
| D2 | **Portable client packaging format.** Whether the shared layer ships as an MCP server + per-client manifest, or as a CLI the adapters call, or both. Affects P3.1/P3.2 directly. | P3.1 | leaning MCP-first for tools, CLI retained for debug/CI/other languages |
| D3 | ~~Claude Code adapter capability set~~ | — | ✅ **measured on a real install** (P3.3-A): plugins ship MCP servers, skills and hooks natively, `${CLAUDE_PLUGIN_ROOT}` is substituted into MCP args and hook commands, plugin hooks run with no trust step, and `~/.claude/skills/<name>/` auto-loads — see [REPORT-p3.3a](REPORT-p3.3a-claude-recon.md) |
| D4 | **Second receiver, and when.** Codex receiver (needs an app-server-owned thread) or a generic pull receiver (any process that polls). Drives P6 and the interface's real validation. | P6.1 | undecided; generic pull is cheaper, Codex is more valuable |
| D5 | **Whether Mode B (ACP) needs its own client surface**, or can reuse the mailbox's threads for multiplexing. | P5 | undecided |

## Rules that keep this honest

1. A capability appears in the compatibility matrix only after it is verified the way
   P0.5 was verified — real host, real model, recorded evidence.
2. Nothing in P3+ may redefine `ack`, delivery, lease, binding, or the at-least-once
   guarantee; those are protocol-owned.
3. Unverified hosts are described as "planned", never as "supported".
4. If a phase would require weakening a verified guarantee to look simpler, the phase
   changes, not the guarantee.
