# REPORT — Visible Executor reconnaissance

**Scope.** Whether the DeepSeek Harness host exposes a supported way to create, wake and drive a
**real, user-visible** session from outside a human turn — the precondition for HarnessMux's
Executor Mode. No implementation is proposed before the evidence; nothing in this report changes
protocol v2, the delivery/claim/lease/ack semantics, or the existing Live Session behaviour.

**Method.** Evidence order used throughout: real run on a real host first, then source in the
shipped bundle, then declared types, then documentation. A claim is only marked VERIFIED when a
run produced it.

Probe used: a throwaway Cordis plugin mounted through `--patch` in the `headless` profile, acting
only when an environment variable names a mode, so the same file is inert when mounted elsewhere.
It runs against the user's real `DSH_HOME`, which is what makes its findings transferable.

---

## 1. Host capability findings

### Q1 — Can an idle agent/session be driven into a new turn without user interaction? **VERIFIED: YES**

One `followup()` call moved the agent from `idle` to `running`, and the turn completed on its own:

```
resume -> sessionId=session-hxmux-executor-probe-001 status=idle
followup() sent; status now=running
whenIdle() resolved; status=idle
```

The mechanism is in the driver, not inferred: `send(message, target, wakeup)` calls
`wakeDriver(...)` when `wakeup` is set, `followup()` is the method that passes it, and the source
comments state that *"a wake sent while idle always opens its turn boundary"*. `steer()` wakes the
driver as well; `inject()` deliberately does **not**, so injected context waits for the next
admitted step. That distinction matters for the design: task dispatch must use `followup()`, never
`inject()`.

### Q2 — Is that turn visible in the Harness UI, on a real session, with history? **PARTIALLY VERIFIED — see the precision below**

The session appears in the host's own corpus with the shape the UI reads, not as a hidden worker:

```
final list record={"header":{"version":4,"id":"session-hxmux-executor-probe-001","createdAt":…,
  "cwd":"<workspace>","isSeeded":false,"delegationDepth":0},
  "live":true,"persisted":true}
```

The record carries the workspace `cwd`, it is `persisted`, and a projection row exists for it under
`<DSH_HOME>/storages/session_projcache/sessions/`, whose contents include `title`, `tokenUsage`,
`sandboxMode`, `goal` and `plan` — the same rows the UI's session list and header read. A
`readTitleSnapshots()` call returned a fulfilled snapshot for the session.

**The precision that matters for E2.** A session created this way is **not** added to the
workspace registry's `sessionIds` list — that list is written when a session is opened through the
host, and it held 37 entries while the projection cache held more. The evidence:

| Session | Created by | In `sessionIds` | Projection row |
| --- | --- | --- | --- |
| `session-f43409f1…` (yours) | the running app | yes | yes |
| `session-9b38d073…` | a CLI run | **no** | yes |
| `session-hxmux-executor-probe-001` | `ctx.agents.create()` | **no** | yes |

So the honest statement is: the session is a first-class, persisted, titled session with a
projection row, and the session-list projection is what the host's list API reads
(*"List reads only stored headers and projection-cache rows"*). Whether it appears in the user's
own sidebar without being opened once is **not yet confirmed by observation** — that is the one
thing a human has to look at, and it should be checked before E2 is claimed.

### Q3 — Can an Executor session be created programmatically? **VERIFIED: YES**

`ctx.agents.create({ sessionId })` accepted an explicit id and produced a session that persisted
and listed:

```
create -> sessionId=session-hxmux-executor-probe-001 status=idle
```

The driver's own documentation states the identity rule: an explicit `sessionId` means *first use
creates, a remount resumes materialized history*; omitting it mints `${id}-session-<uuid>`. That
is exactly the durable identity an Executor needs, and it removes any need for the guesswork the
brief forbids (`sessions[0]`, "most recent", "first running").

**One destructive caveat, discovered by losing the probe session.** `handle.dispose()` **removes the
session** — the first probe session was gone from disk afterwards, which is why the resume probe had
to run against a session created by a separate CLI invocation instead. An Executor must therefore
never dispose the session it intends to reuse; ownership and lifetime have to be separated, and the
disposing capability is deliberately exclusive to whoever holds the handle.

### Q4 — How is an existing session resumed rather than recreated? **VERIFIED: YES, with one sharp edge**

`ctx.agents.resume({ resumeSessionId })` resumed the paused session and drove it to a new turn:

```
before: present=true live=false persisted=true      ← cold, as a side process sees it
resume -> sessionId=session-hxmux-executor-probe-001 status=idle
followup() sent; status now=running
whenIdle() resolved; status=idle
after: present=true live=true persisted=true
```

**Sharp edge, worth recording because it cost a debugging round trip.** `create` takes
`sessionId`; `resume` takes **`resumeSessionId`**. Passing `sessionId` to `resume` does not say so —
it throws an opaque `TypeError: Cannot read properties of undefined (reading 'length')` from inside
the driver (it reads `options.resumeSessionId` and hands the `undefined` on). An implementation that
conflates the two will fail with an error that names nothing.

The same session id also resumes across **separate processes**: `dsh --profile headless
--session-id <id> "…"` continued the very session an earlier process created, and its event stream
continued at `turn: 2`, i.e. the context carried over rather than restarting.

### Q5 — How are `turn started / running / completed / failed` observed? **VERIFIED: YES**

Two independent surfaces, which is what makes this robust:

1. **Structured event stream**, from the host itself (`dsh --profile headless --json`), observed:

   ```json
   {"type":"session","sessionId":"session-9b38d073-…","cwd":"…"}
   {"type":"status","phase":"turn_start","turn":2}
   {"type":"status","phase":"step_start","turn":2,"step":1}
   {"type":"text","text":"RESUMED-SAME-SESSION"}
   {"type":"status","phase":"step_end","turn":2,"step":1,"usage":{…}}
   {"type":"status","phase":"turn_end","turn":2,"reason":{"kind":"completed"}}
   {"type":"final","text":"RESUMED-SAME-SESSION"}
   ```

2. **In-process lifecycle.** `handle.agent.status` is `idle | running`, `whenIdle()` resolves at
   quiescence, and the plugin event contract offers `agent/status`, `agent/created`,
   `agent/disposed`, `agent/turn-stopping`, `agent/pre-step`, `agent/assistant-stream` and
   `agent/request-error`. `agent/turn-stopping` is the only hook that runs *before* a completed turn
   closes and may steer to keep it open — the natural place to decide "this turn really is finished".

`turn_end` carries an explicit `reason`, so completion is a host fact, never a text guess.

### Q6 — How is the final assistant response obtained? **PARTIALLY VERIFIED**

- From the event stream: `{"type":"final","text":…}` — observed with the model's exact text.
- From the session: model output is committed as `assistant/message` events, and the driver exposes
  `agent/assistant-stream` frames while the attempt is live.
- **Not verified:** `ctx.sessionQuery.readSurface(id)` returned `events=0` with
  `capturedThroughSeq=16` for a session that had just run a turn, and `listEvents` was not tried.
  So the exact in-process "give me the last assistant text" accessor is still **UNKNOWN**. Any
  implementation must confirm it before relying on it; until then the `final` event is the proven
  source.

### Q7 — Are there lifecycle events to listen on? **VERIFIED: YES**

Confirmed against `dsh-session`'s emitted names: `session/created`, `session/disposed`,
`session/event`, `session/flush`, `session/title`. The probe hooked `session/created` and ran
successfully; an earlier attempt hooked a plausible-sounding `session/ready` that **does not
exist** and was silently never called. Agent-level events are listed under Q5.

### Q8 — After the desktop app restarts, can the Executor be rediscovered and resumed? **VERIFIED: YES**

The session was observed cold from a *separate process* while the desktop app was running:

```
before: present=true live=false persisted=true
```

`live:false` is the important part — a non-running session is still durable, still listed, and
still resumable by explicit id. Nothing in the flow depends on the process that created it, so a
restart is a re-discovery, not a rebuild, and no random session can be picked up because the id is
explicit.

---

## 2. Evidence summary

| Capability | Verdict | Evidence |
| --- | --- | --- |
| Idle → new turn without the user | **VERIFIED** | `followup()` flipped `idle`→`running`; driver source: `send(…, wakeup)` → `wakeDriver` |
| Real session, real history, not a hidden worker | **VERIFIED** | session record carries the workspace `cwd`, `persisted:true`; projection rows (`title`, `tokenUsage`, …) present |
| Appears in the user's session list unaided | **UNKNOWN** | the session is absent from the workspace registry's `sessionIds`; only the projection was observed |
| Programmatic creation | **VERIFIED** | `ctx.agents.create({ sessionId })` → session persisted and listed |
| Resume the same session | **VERIFIED** | `ctx.agents.resume({ resumeSessionId })` → new turn; also across processes via `--session-id` |
| Turn lifecycle observation | **VERIFIED** | `turn_start` / `step_start` / `step_end` / `turn_end{reason}` / `final`; `agent/*` events; `whenIdle()` |
| Final assistant text, in-process accessor | **UNKNOWN** | `readSurface().events` came back empty; the `final` event is proven |
| Session survives restart | **VERIFIED** | observed `live:false persisted:true` from another process |
| Keeping a session across tasks | **VERIFIED (with care)** | `dispose()` deletes the session — a long-lived Executor must not call it |
| Existing Live Session behaviour | **UNCHANGED** | nothing in this recon touches the pump; no protocol change was made |

---

## 3. Candidate APIs

| Path | Visibility | Idle wake | Persistence | Turn events | Stability | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| **`ctx.agents.create` / `resume` + `followup` (in-process)** | Full — real session, real projection, live turn while it runs | Yes (`followup`) | Exact id, explicit | `agent/*` + `whenIdle()` | Documented public plugin API | Writer lock: the host refuses a second writer on one session, so the Executor id must not be opened by the UI at the same time |
| **`dsh --profile headless --json` subprocess** | Session is created and persisted in the user's workspace; the *run* is not streamed into the UI live | Yes — the process starts the turn | Exact id, `--session-id` to resume | Rich, machine-readable, stable | A shipped CLI contract | An extra process per task; no live in-UI streaming; output arrives on stdout rather than through the host |
| **Host session API (`session.create` / `session.resume`)** | Same sessions the UI itself creates | Intended to | Yes | Wire events | Host-internal; needs auth | Needs the host's authenticated channel; `session/writer-held` on contention |
| ~~`dsh --profile acp` worker~~ | Hidden by construction | Yes | — | — | — | **Excluded by the brief**, and it fails the visibility requirement |

**Why the in-process path is the recommendation.** It is the only candidate where the work happens
*inside* the session the user is watching, so the requirement "the DeepSeek execution process must
be visible in the DeepSeek Harness the user is using" is satisfied by construction rather than by
a follow-up refresh. The subprocess path is a genuine fallback — it produces a real visible session
too — but its turn is not observable live, so it answers E2 only after the fact.

---

## 4. Recommended design (minimal)

1. **One persistent, explicitly identified Executor session.** `executorSessionId` recorded in the
   endpoint/binding layer; never derived from ordering. One session, not a pool.
2. **Dispatch:** resolve id → `ctx.agents.resume({ resumeSessionId })` when cold, `create({ sessionId })`
   when absent → `followup({ content, source: { kind: 'plugin:<name>' } })` → ACK the delivery.
   ACK keeps its v2 meaning: the host accepted the delivery.
3. **Correlation:** record `deliveryId ↔ threadId ↔ executorSessionId ↔ turn` so "which DSH turn did
   this delivery cause" is answerable.
4. **Automatic return:** on `turn_end` / `whenIdle()`, post the final assistant text back as a reply
   on the originating thread, without relying on the model to call the mailbox tool. The model's
   mailbox tool stays for mid-turn questions and reports.
5. **Mode separation:** a binding type that distinguishes a HarnessMux-managed Executor from a
   user's own live session, so lifecycle logic can never act on a session the user owns.
6. **Security:** the Executor is `delegated`; ordinary live sessions stay default `advisory`. No
   change to DSH's own tool/permission policy.

### Blockers and unknowns to settle before implementation

1. **Q6's in-process final-text accessor is UNKNOWN.** Confirm it (or use the `final` event / an
   `agent/assistant-stream` accumulator) before writing the auto-reply.
2. **E2's "appears in the sidebar" is UNKNOWN.** Everything is in place for it — a persisted,
   titled session with a projection row — but no session created programmatically was observed in
   the workspace registry's `sessionIds`. One human look settles it.
3. **Writer-lock policy.** Confirm what happens when the user opens the Executor session in the UI
   while a delegated turn is running. This is the one interaction that could surprise a user.
4. **`dispose()` is destructive.** It deleted the probe session. The Executor's lifetime must not be
   tied to a handle that anyone may dispose.
5. **Stale absolute paths were a live defect, and this recon hit it** — fixed in the adapter while
   working here, because it blocked verification. The Codex MCP entry named node by an absolute path
   into Codex's runtime directory, and that directory is *versioned and replaced on update*
   (`cua_node/71e3f41277f96d73` → `cua_node/2c9e75c4e9c71beb`), so the entry went stale and the
   desktop app failed again with `MCP startup failed: No such file or directory`. The same
   staleness affected the installed hooks. Both now go through `cmd.exe` plus a shim that resolves
   node at spawn time, which an update cannot invalidate.

---

## 5. What this recon did not do

- No protocol, delivery, claim, lease, ack or binding semantics were changed.
- No Cursor, Copilot, generic-MCP or second-receiver work was started.
- No implementation of Executor Mode: the brief asks for findings first, and Q6 plus the writer-lock
  question are still open.
