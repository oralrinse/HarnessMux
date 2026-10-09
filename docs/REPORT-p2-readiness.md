# P2 readiness — a real Codex as Commander

Status: **transport, identity, capture and recovery are done; the Commander layer needs one decision.**
Date: 2026-10-09

---

## 1. What P2 is

```
user (one prompt) → Codex: analyse, dispatch Round 1
                  → DSH: execute, auto-reply R1
                  → Codex: read R1, decide what to improve, dispatch Round 2
                  → DSH: execute, auto-reply R2
                  → Codex: judge from R2's evidence, answer the user
   user inputs during the workflow: 0
```

Two layers, and they fail differently:

- **Protocol loop** — two delegated executions, two automatic replies, one thread, one session, every count
  asserted. The DSH half of this is measured and reliable (P1a–P1d).
- **Commander autonomy** — Codex must *read* R1, *decide* what round two should be, and *judge* R2. A test
  script pre-writing round two would prove nothing about this layer.

## 2. What was measured on this machine

| fact | evidence |
| --- | --- |
| Codex CLI present | `codex-cli 0.154.0` |
| the harnessmux plugin is installed and enabled | `codex mcp list` → `harnessmux … status=enabled`; `config.toml` → `[plugins."harnessmux@harnessmux"] enabled = true`, marketplace `source = '\\?\H:\…\harnessmux'` |
| the MCP server itself is healthy | direct JSON-RPC handshake: `initialize` → `harnessmux 0.1.0`; `tools/list` → all nine tools (`send_message`, `wait_for_reply`, `read_messages`, `reply_message`, `list_threads`, `list_endpoints`, `list_sessions`, `bind_thread`, `get_status`); `get_status` returned the bridge state |
| the Commander skill **is** installed for Codex | `$CODEX_HOME/skills/harnessmux/SKILL.md` exists — the installer copies it from the single shared source (`scripts/install.mjs`, "the skill: copied from the single shared source"). A first reading of this looked like a missing skill because `packages/adapter-codex/.codex-plugin/plugin.json` declares `"skills": "./skills/"` while the adapter deliberately keeps no such directory; the plugin manifest's field is not the delivery path, and `plugin.test.mjs` pins that the adapter must not hold a second copy |
| …but the installed copy was **stale** | its hash was `FB7984…` against the repository's `E4CF94…`: it predated the round that added "the executor's result comes back to you automatically". Refreshed from the shared source (the installer's own step), so a Codex session now gets the current rules |
| `codex exec` exposes **no MCP tools at all** | two runs, `-s read-only` and with `--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust`; asked to enumerate its tools, the model answered *"No MCP-server tools are currently exposed"* and then *"NONE"*. `node_repl` is declared in `config.toml` and enabled, and it is missing too — so this is not harnessmux-specific |
| the flags explain it | `codex features list`: `plugin_hooks` **removed**, `tool_search` **removed**, `tool_search_always_defer_mcp_tools` effective **true**, `plugins` stable true |

## 3. The consequence, stated exactly

**The P2 chain cannot be driven headlessly through `codex exec` in this Codex build**: MCP tools are not
exposed to that session, so Codex has no `send_message` and no `wait_for_reply`. The interactive Codex
surface is where the tools live — which is also where the earlier acceptance artifacts in
`.claude-acceptance/` came from (`d1-d2-get-status.txt`, `d3-send.txt`, `d5-reply.txt` are real tool
output).

So the Commander has to be driven through a session that has the tools. Two ways, and the choice is the
user's because one of them types into their own Codex conversation:

1. **The user gives the one prompt** in their Codex session (the real product flow). Everything after it is
   unattended: Codex binds, dispatches, waits, reviews, dispatches again, judges. `userInputsDuringWorkflow
   = 0` is then a statement about everything after that prompt.
2. **The initial prompt is injected** with `codex queue --thread <session> --message <task>`, which Codex
   documents as "queue a message for an existing session". Fully unattended, but it writes into a session
   the user owns, and enumerating live sessions (`codex agents`) needs a terminal this agent does not have —
   so the session id has to be named.

## 4. The instrument is already built for it

`examples/live/acp-turn-boundary.mjs` is the DSH executor: an isolated home, a live session that is idle
and wakeable, the receiver, and a probe that dumps every session event. For P2 the same host runs with the
**shared bridge** so Codex and DSH can actually exchange messages, and the run needs to observe, per round:

```
userInputsDuringWorkflow = 0
commanderReviewCount >= 2                       (round two exists because Codex decided it should)
delegatedExecutions = 2
round1.threadId == round2.threadId
round1.targetSessionId == round2.targetSessionId
hostDispatchCount(E1) = 1, hostDispatchCount(E2) = 1      (the P1d invariant, per execution)
finalReplyCount(E1) = 1, finalReplyCount(E2) = 1
round2Instruction generated after R1 was read   (it must quote something only R1 could have supplied)
finalVerdict issued after R2 was read
protocol invariants = OK
```

and the honest negative: if continuing requires the user to press enter again, the **protocol loop** may
pass while **Commander autonomy** does not. Those are different results and must be reported separately.

## 5. Fixed in this round

- The **deployed** Codex skill was stale (hash `FB7984…`; the repository is `E4CF94…`), so a Codex session
  was reading the rules from before the automatic-reply round. Refreshed from the single shared source, which
  is the installer's own step — re-running `scripts/install.mjs` is the designed route for this.
- `commander.test.mjs` now compares the two shipped skill copies **byte for byte**, not just by the phrases
  they contain: the rules hold for both clients or they hold for one of them.
- The `absent` boundary is written into `dispatchIdentityStatus`'s contract: it may only be claimed when the
  record read was complete, reached the dispatch baseline, is at least one watch interval newer than the
  call, and came from an authoritative source — otherwise the answer is `unknown`, and `unknown` waits.

### A wrong reading, recorded so it is not repeated

The first pass of this reconnaissance concluded that Codex had **no Commander skill**, because
`packages/adapter-codex/.codex-plugin/plugin.json` declares `"skills": "./skills/"` and no such directory
exists in the adapter or in Codex's plugin cache. That was wrong: the installer delivers the skill to
`$CODEX_HOME/skills/harnessmux/SKILL.md`, which is where Codex actually loads it from, and
`plugin.test.mjs` deliberately pins that the adapter keeps *no* second copy. The mistake was to treat a
manifest field as the delivery mechanism instead of reading the installer. The manifest field itself is
worth a look in a later round — a declared directory that nothing creates is at best dead and at worst
misleading — but it is not a P2 blocker.
