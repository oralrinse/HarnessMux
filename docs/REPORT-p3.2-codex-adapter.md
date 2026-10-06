# P3.2 acceptance — Codex adapter, on a real machine

Paths are written as `<bridge>` and `<CODEX_HOME>`: this report is published, and the absolute paths of the machine it was measured on are not evidence. Everything else — counts, ids, states, timestamps, verbatim tool output — is as observed.

Date: 2026-10-06 · Codex CLI **0.154.0** · DeepSeek Harness running (Desktop), real model
in both agents. The gate for P3.2 was a working end-to-end path, not a manifest that parses.

Verdict: **all eight acceptance conditions met.** Two of them (C4, and the hook transport
underneath it) failed on the first attempt and the failures are recorded here, because the
cause is the kind of thing a manifest-only check would have declared "done".

```
Codex ── HarnessMux adapter ── shared MCP (8 tools) ── protocol v2 ── DSH Native Receiver ── live DSH session
```

---

## C1 — Codex sees the HarnessMux MCP tools ✅

`codex exec` run in the workspace, asked to call `get_status`:

```
mcp: harnessmux/get_status started
mcp: harnessmux/get_status (completed)
root: <bridge>
protocol: v2   messages=4 queued=2 claimed=0 acked=0 bindings=0 endpoints=1
awaitingBinding=["migrated-20261006090257478-84bd2f9e","5a204c86-c05b-433a-a122-9b30c20c12a8"]
invariants=ok
```

The eight tools reached Codex through `.mcp.json` → `scripts/launch-mcp.mjs` → the shared
server. The launcher was verified **from Codex's own plugin cache**
(`<CODEX_HOME>/plugins/cache/harnessmux/harnessmux/0.2.0`), not from the repository, which is the
case that actually matters: Codex copies a plugin, so "inside the plugin root" cannot mean
"next to the repo". The pointer file `<CODEX_HOME>/harnessmux.json` is what bridges that gap.

Codex also loaded the skill — the prompt about the mailbox was answered with the skill's own
text about advisory/delegated and at-least-once delivery.

## C2 — Codex calls the shared MCP server, not a legacy path ✅

Every call above is an MCP tool call. The adapter contains **no** mailbox implementation: it
has a manifest, a `.mcp.json`, a launcher, a hook script and a copy of the shared skill. The
CLI was never invoked by Codex.

## C3 — Codex → HarnessMux → DSH session, delivered on a real machine ✅

Codex was asked to `send_message` with an explicit endpoint and session. The delivery arrived
**inside this session's running turn**:

```
codex delivered a message through the harnessmux (delivery da86cbda-2734-4e0f-b69f-7d60624a3a30, attempt 1, mode delegated).
This delivery is delegated: carry the work out.
[...] client (instruction) thread=codex-delegation-accepta-d8e0e204127cb7ae topic=codex delegation acceptance
CODEX-TO-DSH-MARKER-8802: report this marker verbatim in your reply.
```

Recorded lifecycle:

```json
{ "deliveryId": "da86cbda-2734-4e0f-b69f-7d60624a3a30",
  "target": { "actor": "dsh", "endpointId": "dsh-endpoint",
              "sessionId": "session-f43409f1-441c-4251-ac4f-ddf74974412b" },
  "mode": "delegated", "attempt": 1,
  "ackedAt": "2026-10-06T16:23:56.751Z", "note": "steered", "state": "acked" }
```

## C4 — a message is picked up on Codex's next lifecycle event ✅

The message was queued while Codex was idle, then Codex was started on an unrelated prompt
("say READY4"). The hook ran at `SessionStart` **and** `UserPromptSubmit`, and the rollout
proves the text reached the model — twice, as a `developer` message:

```
{"role":"developer","content":[{"type":"input_text",
  "text":"HarnessMux: 4 message(s) from a peer agent are waiting for you (codex).…"}]}
```

Idle Codex is not woken, and nothing is lost — which is the property C4 was written to test.

## C5 — thread and reply relationships ✅

`reply_message` keeps the parent's thread and topic and records `replyTo`. The reply's
`threadId` equals the parent's, and `kind` defaults to `answer`.

**This condition exposed a real defect.** The first reply came back `target=UNROUTED`: the
message had been addressed explicitly, so the thread had no binding, and the reply had no way
to find a route — the second turn of the conversation silently died. Routing is recorded on
the **delivery**, never on the message (messages are immutable content), so the fix reads the
parent's delivery when no binding exists:

| Source | Precedence |
|---|---|
| thread binding | **wins** — an explicit human decision |
| the parent delivery's target and mode | inherited when there is no binding |
| neither | stays `UNROUTED`, never a guess |

Covered now by `tests/mcp-contract.test.mjs` §6b: inherited route, binding overrides it, and
an orphan reply stays unrouted.

The same run showed messages attributed to `client` instead of `codex`. Fixed at the source:
each adapter records its own identity in the pointer file and the MCP server reads it, so
`HARNESSMUX_ACTOR` is no longer required for correct attribution.

## C6 — strict binding with several sessions ✅

`examples/live/cutover-probe.mjs` against two real harness sessions:

```
[PASS] V4-5 unbound delivery is never consumed
[PASS] V4-6 bound delivery routes to session A only
[PASS] V4-6b no cross-session contamination
  evidence: sessionA saw the marker=true; sessionB saw the marker=false
```

## C7 — uninstall leaves nothing broken ✅

`tests/adapter-codex.test.mjs` runs the whole cycle against a temporary `CODEX_HOME`:
dry run writes nothing, install is idempotent (`--codex` twice changes no byte), an
out-of-date skill copy is refreshed from the shared source, and uninstall removes the pointer,
the skill and exactly the two hooks — restoring the user's own `hooks.json` byte-for-byte,
including a foreign hook that shared the `UserPromptSubmit` event.

## C8 — `npm test` green, with the new adapter contracts ✅

```
mailbox ✅  protocol-v2 ✅  cli-v2 ✅  migrate ✅  manifest ✅  plugin ✅
plugin-v2 ✅  mcp-contract ✅  adapter-codex ✅  trace-policy ✅  cutover-faults ✅
11 suites, exit 0
```

`tests/adapter-codex.test.mjs` pins the manifest fields Codex reads, the relative-path rule
its MCP overlay enforces, the launcher's server resolution, the hook's silent/informative/
non-consuming behaviour, and the install → upgrade → uninstall cycle.

---

## What the first attempt got wrong

Both failures were in the hook transport, and both were invisible to a static check.

**1. A plugin cannot ship hooks in 0.154.0.** The adapter originally put them in
`hooks/hooks.json` inside the plugin. Codex discovered and ran them (`hook: SessionStart`),
but every run ended `hook: SessionStart Failed`. The cause: Codex resolves a hook command
against the directory holding the hooks file — `<CODEX_HOME>` — so `node ./scripts/pending.mjs`
resolved to `<CODEX_HOME>\scripts\pending.mjs` and node reported `Cannot find
module`. Reproduced by hand from that directory; absolute paths fix it.

**2. Hooks require persisted trust.** Even with a correct command, a non-interactive run
reports `Failed` until the hook is trusted; `--dangerously-bypass-hook-trust` is Codex's own
escape hatch for automation that has vetted the command. Both facts are now in the README
instead of being rediscovered by the next person.

A third finding: `plugin_hooks` shows as **removed** in this build, so the plugin-provided
hook path is not merely broken but abandoned — the user-level `hooks.json` is the one that
works. That is why the installer writes there rather than into the plugin.

## Not claimed

- **Idle Codex is not woken.** The message waits; the hook surfaces it at the next lifecycle
  event. This is the documented boundary, not a P3.2 failure.
- **Interactive approval was not exercised.** The trust step was bypassed for automation; a
  human approving a hook in the TUI is inferred from Codex's own flags, not measured here.
- **Windows only.** Every measurement above is from one Windows machine.
