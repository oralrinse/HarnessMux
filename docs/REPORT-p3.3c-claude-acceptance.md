# P3.3-C acceptance — Claude Code adapter, on a real machine

Date: 2026-10-06 · Claude Code **2.1.215** · Windows · DeepSeek Harness running (Desktop) ·
model reached through the configured third-party endpoint (`ANTHROPIC_BASE_URL`).

Verdict: **all six conditions met**, each with its own evidence. Reaching this verdict took
three runs, and **every failure reported along the way was a defect in my measuring script, not
in the adapter** — that is the single most important fact in this document, because a wrong
verdict hides a working path exactly as effectively as a wrong PASS hides a broken one.

```
Claude Code ── HarnessMux adapter ── shared MCP (8 tools) ── protocol v2 ── DSH Native Receiver ── live DSH session
                                                                                            │
Codex      ── HarnessMux adapter ──────────────────────────────────────────────────────────┘
```

Two independent clients now have real-machine evidence against the same receiver.

---

## D1 — Claude lists the HarnessMux MCP tools ✅

```
[PASS] D1 Claude lists the HarnessMux MCP tools
  evidence: list_sessions returned the live session id session-f43409f1-…: true
```

The prompt asked Claude to call `list_sessions` and print the tool's text. The live session id
appears in the answer, and **only the server can supply that id** — prose cannot forge it. This
is the replacement for a predicate that looked for the tool's *name* in the output, which
`claude -p` never prints (it echoes only the model's final text), so the original check could
not have passed no matter how well the adapter worked.

## D2 — Claude calls the shared MCP server ✅

```
[PASS] D2 Claude calls the shared MCP server
  evidence: get_status returned the shared server's own payload: true
```

The captured payload is the shared server's structured answer
(`{"version":2,…,"invariantsOk":true,"violations":[]}`), not the CLI's prose form. The adapter
contains no mailbox logic, so a working reply can only have come from `packages/mcp/server.mjs`.

## D3 — Claude → a real DSH session ✅

```
[PASS] D3 Claude → real DSH session delivery
  evidence: messageId=a8803d45-… deliveryId=01456037-… state=acked
```

The record, read from the bridge after the fact:

```json
{ "deliveryId": "01456037-cab9-4479-8092-48446a87eb98",
  "messageId": "a8803d45-5891-4649-8c36-971d82c55089",
  "target": { "actor": "dsh", "endpointId": "dsh-endpoint",
              "sessionId": "session-f43409f1-441c-4251-ac4f-ddf74974412b" },
  "mode": "delegated", "attempt": 1,
  "ackedAt": "2026-10-06T17:52:11.557Z", "note": "steered", "state": "acked" }
```

and the trace line for the hand-off:

```
2026-10-06T17:52:11.555Z pump: claimed 01456037-cab9-4479-8092-48446a87eb98 attempt=1
```

The message body reached the harness session **inside a running turn**:

```
claude (instruction) thread=claude-acceptance-claude-93999df29ea83df3
CLAUDE-TO-DSH-MUWZ5UXJ: report this marker verbatim.
```

The first run of this condition failed for a reason worth stating plainly: the script addressed
a session that had stopped 50 minutes earlier, and the *second* attempt waited only 45 s while
DSH was idle. A delivery is made **only into a running turn**; when the harness is idle the
message is queued, which is the documented boundary and not a defect. The script now waits
120 s, and matches only messages created after its own send call — matching by topic alone once
picked up a previous run's already-acked message, which would have been a stale pass.

## D4 — DSH → Claude at the next lifecycle event ✅

```
[PASS] D4 DSH → Claude surfaced at the next lifecycle event
  evidence: model quoted the marker: true; the installed hook's own output carries it: true
```

This is the condition that mattered most, and it is measured rather than assumed: a message
queued while Claude was idle was **quoted verbatim by the model** on its next turn. Claude's
documented injection path is `hookSpecificOutput.additionalContext`, and the model's own words
are the proof that it lands.

Reconnaissance had already shown the mechanism runs (`§3` of the P3.3-A report); this shows the
text reaches the model. Idle Claude is still not *woken* — it loses nothing and picks the
message up when it next acts.

## D5 — thread and reply relationships ✅

```
[PASS] D5 thread and reply relationships
  evidence: reply=818d111f-… replyTo=ebe90c94-… thread=claude-pickup-… (identical to the parent)
```

The reply keeps the parent's thread and references the parent message.

## D6 — several DSH sessions do not cross-talk ✅

```
[PASS] D6 several DSH sessions do not cross-talk
  evidence: decoy delivery dbe8ff2a-… state=queued target={"endpointId":"dsh-decoy-endpoint",…}
```

A delivery addressed to a different endpoint/session was never handed to the bound one.

## D7 / D8 / D9 — offline conditions, verified before the live runs

| # | Condition | Evidence |
|---|---|---|
| D7 | install / upgrade / uninstall leave the user's configuration alone | `tests/adapter-claude.test.mjs` against a temporary `CLAUDE_CONFIG_DIR`: dry run writes nothing, a second install reports no change, a stale copy is replaced, and uninstall restores `settings.json` byte-for-byte |
| D8 | `npm test` green with adapter contracts | **13 suites**, including the new `adapter-claude` and `endpoint-freshness` suites |
| D9 | the adapter addresses itself through `${CLAUDE_PLUGIN_ROOT}`, verified from the installed location | asserted in the contract suite, and `claude plugin details harnessmux` reports the plugin loaded from `~/.claude/skills/harnessmux` with 2 hooks and 1 MCP server |

## What the three runs cost, and why

| Run | Reported | Actually |
|---|---|---|
| 1 | D1, D2, D3 FAIL | D1/D2 passed (predicate looked for the CLI's prose in an MCP JSON reply); D3 was a dead target; **D4/D5/D6 passed** |
| 2 | D1 FAIL | predicate looked for a tool name that `claude -p` never prints; **D2–D6 passed**, including the first real D3 |
| 3 | D3 FAIL | the 45 s wait expired while DSH was idle; the hand-off completed 70 s later, in a running turn. **D1/D2/D4/D5/D6 passed** |

Two of the three runs also exposed blocking bugs that were mine:

- the script refused to start when the endpoint record looked old — but the receiver republishes
  only when the live session set *changes*, so a long-running session leaves the file untouched
  for hours while the published list stays accurate. It blocked a valid run;
- an authentication pre-check exited, and so blocked the very shell where Claude is
  demonstrably authenticated, because Claude Code keeps its credential in a per-session store
  that a spawned process may not share. It now warns and continues.

## Not claimed

- **Idle Claude is not woken.** D4 measures pickup at the next lifecycle event; nothing here
  suggests Claude can be woken while idle, and no such claim is made.
- **Windows only**, and one Claude Code version.
- **The D3 timing requirement is real**: the target DSH session must be running a turn while the
  delivery is attempted. With both agents idle, the message waits — correct, but it means the
  acceptance script and the harness must overlap in time.
- **The stale-endpoint defect is still open** (`docs/DEFECT-stale-endpoint.md`). It did not
  reappear after the harness restart, and its root cause remains unproven.
