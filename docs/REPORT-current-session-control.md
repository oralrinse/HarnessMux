# REPORT — Current Session Control

**Objective.** Let Codex wake and drive *the DSH session the user is looking at* through HarnessMux,
with no manual action in the DeepSeek Harness UI, and have the result come back.

**What changed, in one sentence.** The receiver used to consider only sessions that were already
*running*; a delegated instruction addressed to an idle — but explicitly bound — session now opens
a turn in that session by itself.

Nothing in protocol v2 was touched: message/delivery separation, claim, lease, ack, binding, thread,
at-least-once and duplicate-but-not-lost are exactly as they were, and ACK still means "the host
accepted this delivery".

---

## 1. Host Path

```text
idle session
  → ctx.agents.resume({ resumeSessionId })
  → agent.followup(message)
  → idle → running
  → new turn
```

Observed on a real host, from the receiver's own trace and from the host's own status events, in one
run:

```text
# receiver trace
pump: skip agent status=idle steer=function
pump: claimed 168f8941-ce79-4069-add8-7e9a8407413f attempt=1
pump: woke session-csc-15ee171c for 168f8941-ce79-4069-add8-7e9a8407413f attempt=1

# the host's own view, reported by the probe mounted beside the receiver
agent/status -> running      (the session woke itself; nobody touched DSH)
agent/status -> idle         (the turn completed)
```

The wake is `followup()`, not `inject()`: `inject()` deliberately does not wake a driver. This was
established in the reconnaissance and is relied on here rather than re-guessed.

**A real host, not a simulation.** The run used the shipped `receiver-dsh` plugin mounted by profile
patch, driving a genuine session; the marker was found in that session's own committed event log.

---

## 2. Routing

One thread bound to one endpoint and one session:

```json
{
  "threadId": "current-session-control-a01a04a2118988f4",
  "endpointId": "dsh-endpoint",
  "sessionId": "session-csc-15ee171c",
  "mode": "delegated",
  "boundAt": "2026-10-07T09:38:50Z"
}
```

The delivery carried the same target, and the claim's own `mode` is what authorizes the wake. No
ordering heuristic is used anywhere: not `sessions[0]`, not "most recent", not "first running".
An unrouted delivery (no binding) remains `queued` — `awaitingBinding` is still a legal state, and
the trace names it (`pump: skip … unrouted (awaiting binding)`).

---

## 3. Delivery State

```text
  deliveryId : 168f8941-ce79-4069-add8-7e9a8407413f
  state      : acked
  attempt    : 1
  note       : woken
  claimed now: 0        (no dangling claim)
  invariants : ok
```

The order is unchanged and load-bearing: **claim → resolve/resume → followup → host accepts → ack**.
The ack is written only after the follow-up succeeded, so the at-least-once window is preserved; a
failed wake releases the delivery with a growing backoff rather than acking it.

`note: "woken"` distinguishes this hand-off from the pre-existing `"steered"`, so an operator can
tell from the bridge alone which path carried a delivery.

---

## 4. E2E — C1 to C8

### 4a. The measured run, on the real machine

This is the acceptance the stage asked for, and it passed with the stage's own marker. Codex's real
client sent the instruction; the target session was idle beforehand; nobody touched the harness.

```text
# the receiver's own trace, on the real bridge
11:54:26  pump: skip agent status=idle steer=function          ← the session was idle
11:56:13  (Codex posts delivery aa511412-e24e-47de-b9fb-c2df5815219a)
11:56:16  pump: claimed aa511412-… attempt=1
11:56:16  pump: woke session-f43409f1-… for aa511412-… attempt=1   ← woken with no human action

# the delivery
state=acked  attempt=1  note=woken
target={"actor":"dsh","endpointId":"dsh-endpoint","sessionId":"session-f43409f1-…"}
binding: codex-current-session-ok-… → dsh-endpoint / session-f43409f1-… mode=delegated

# the answer, read back by the real Codex client
mcp: harnessmux/read_messages started / (completed)
SEEN=CURRENT_SESSION_OK_bb0acce40f2045539432adec4db44038
reply delivery state afterwards: queued   (reading did not consume it)
invariants: ok
```

The marker is the one the stage specified, and it travelled the whole way: Codex's instruction opened
a turn in an idle session by itself, the model saw the body, and the model's answer came back to the
client that asked. **The fact that the instruction arrived at all is itself the proof** — a delivery
only reaches a session through a turn, and no turn was running when it was posted.

### 4b. Condition by condition

| # | Condition | Verdict | Evidence |
| --- | --- | --- | --- |
| C1 | the session was `idle` before sending | **PASS** | `pump: skip agent status=idle` repeating up to `11:54:26`, two minutes before the delivery |
| C2 | HarnessMux resumes and follows up on its own | **PASS** | `pump: claimed …` then `pump: woke …`, with no user action between them |
| C3 | the session goes `idle → running` with a new turn | **PASS** | the instruction arrived inside a turn, so a turn opened; the dispatch record carries `turn: 1`, and the isolated host run read the transition directly as `agent/status -> running` |
| C4 | the model received the body verbatim | **PASS** | the delegated body is the marker instruction, and the model echoed exactly that marker |
| C5 | `attempt=1`, `state=acked`, no dangling claim | **PASS** | `state=acked attempt=1 note=woken`, `claimed=0` |
| C6 | no other session received it | **PASS** | the thread is bound to exactly one session; the isolated run additionally showed `pump: skip … session A != B` for every other target and produced no second dispatch record |
| C7 | the result returns to Codex | **PASS** | reply delivery `target={"actor":"codex"}` carrying the marker |
| C8 | Codex sees it | **PASS** | the real Codex client read it and reported `SEEN=CURRENT_SESSION_OK_…` |

C4's evidence is the one that matters. `acked: true` is not treated as success anywhere in this
report: the claim is only that the **model's own turn carried the body**, which is what "the model
really received it" means.

---

## 5. Follow-up

The second turn uses the same thread, the same binding and the same session: nothing in the wake
path creates a session. The receiver resolves the target by
`ctx.agents.resume({ resumeSessionId })`, which is *resume* by identity, and the reconnaissance
measured that resuming a cold session continues its history (`turn: 2` on the same session id)
rather than starting a new one.

Two consecutive wakes were observed in this work on the same session id — one in the acceptance run
above, and one earlier in the reconnaissance — each time leaving the session on disk and re-listing
it afterwards. `dispose()` is never called on it (see §7, defect D3).

---

## 6. Reply Path

**Current state: the model's own `mailbox`/`reply_message` tool**, and the return leg is now
addressed explicitly rather than left to the thread binding.

Measured, end to end, on one thread:

```text
1. codex -> dsh   target=session-rt-dsh  mode=delegated  delivery=06f9669f
2. thread stays bound to the DSH session, exactly as a delegated dispatch leaves it
3. dsh -> codex   target={"actor":"codex"}  mode=advisory  delivery=c2a8b239
4. codex hook     mentionsMarker=true  threadShown=true
     HarnessMux: 1 message(s) from a peer agent are waiting for you (codex).
     --- [0f5ee6db-…] dsh (report) topic=round trip
     thread=round-trip-e077748737beacf1 mode=advisory state=queued
     ROUNDTRIP_MUXX9NF0 — done.
   non-consuming: reply deliveries still queued = 1
   deliveries per message: instruction=1 reply=1
invariants=ok
```

**Why the target is an actor and not the binding.** While a delegated thread is bound to the DSH
session, the binding wins — so a reply that trusted it was routed *back into the session that had
just produced it*, and the asking peer never saw it. The receiver's `reply` now enqueues with
`target: { actor: peer }`, which addresses the answer to whoever asked, whatever the thread is bound
to. Both halves are asserted: the answer reaches the peer, and the delegated binding is left
untouched so everything else on that thread still resolves through it.

This is the "model tool reply" path. It is stated plainly because the two must not be confused:

- **In use now:** the DSH model calls `reply_message`; the reply travels over protocol v2 to the
  originating thread, and the peer collects it on its next lifecycle event.
- **Not yet implemented:** automatic final capture. There is no code that reads the assistant's last
  message at `turn_end` and posts a reply by itself.

What the reconnaissance established for the automatic path, recorded so it is not re-investigated:

- the host's turn-end is authoritative and carries a reason: `{"type":"status","phase":"turn_end",
  "turn":2,"reason":{"kind":"completed"}}`, and `--json` runs also emit `{"type":"final","text":…}`;
- in-process, the session object exposes `snapshotEvents()` (marked deprecated by the host in favour
  of an asynchronous reader), which is enough to find the assistant text without an extra service —
  `ctx.sessionQuery` was *not* available in the contexts tried;
- `agent/assistant-stream` and `agent/turn-stopping` exist for interception before a turn closes.

So automatic capture is provably reachable; it is simply not in this stage's first version, by the
brief's own instruction.

---

## 7. New Defects

### D1 — an idle session could never be woken at all

- **Symptom.** A delegated instruction bound to a live, user-visible session sat `queued` forever
  while the session stayed idle. The user had to type something in DSH to get it delivered.
- **Evidence.** `pump: skip agent status=idle steer=function` was the only thing the trace ever said;
  the pump returned before it looked at the queue.
- **Root cause.** `pumpV2` was gated on `agent.status === "running"` and the watcher iterated only
  `ctx.agents.roots()`. An idle session is either not running, or not loaded at all, so neither the
  gate nor the iteration could reach it.
- **Fix.** The watcher now also considers sessions this endpoint **published** but which are not
  loaded, and a delivery is handed over by one of two paths: steer when a session is running, wake
  when it is idle. The wake path resumes by explicit id and calls `followup`.
- **Regression test.** `tests/current-session.test.mjs` §1 — a delegated, bound, idle session is
  woken exactly once, the body reaches the model, the delivery is acked with `note: "woken"`, and no
  claim is left behind.

### D2 — the wake could have been granted too broadly

- **Symptom.** None observed; this is a boundary that had to be pinned before it could be crossed.
- **Evidence.** The rule is stated by the brief and is a security property, not a preference: an
  advisory note must not seize a conversation the human is having, and a delegated delivery with no
  binding must not cause anything to happen at all.
- **Root cause.** A wake path keyed on "there is a queued delivery" rather than on authorization
  would have woken the wrong sessions.
- **Fix.** Authorization is read from the claim itself: `mode === "delegated"` **and** an explicit
  binding whose own mode is `delegated`. Anything else keeps the old behaviour exactly.
- **Regression test.** §2 (advisory + bound + idle → not woken, stays `queued`), §3 (delegated but
  unbound → not woken), §4 (running → steered, never woken), §5 (`currentSessionControl: false`
  restores the previous behaviour).

### D3 — `dispose()` deletes the session, so the handle must never be dropped carelessly

- **Symptom.** A probe session vanished from disk after a probe finished with it.
- **Evidence.** The session store directory disappeared; the following attempt to resume it failed
  with `session "…" not found`.
- **Root cause.** An `AgentHandle` owns the only disposal capability for its agent, and disposing
  removes the session. The session being woken belongs to the user and is on screen.
- **Fix.** The handle returned by `resume` is retained in `WOKEN_HANDLES` and never disposed. The
  receiver has no code path that disposes a session it woke.
- **Regression test.** §7 asserts the receiver never calls `handle.dispose()`.

### D4 — the watch interval was fixed, so a short-lived host could never tick

- **Symptom.** During acceptance, the receiver was disposed before its first tick: `dispose: …
  watcher stopped` eight seconds after mount, with a ten-second interval. Nothing was ever woken,
  and it looked like a logic failure.
- **Evidence.** The trace showed mount at `T0`, dispose at `T0+8s`, and no pump line at all. With
  `watchIntervalMs: 1000` the same setup woke the session within one second.
- **Root cause.** `WATCH_INTERVAL_MS` was a constant. That is a reasonable default for a long-running
  harness and a trap for any host whose lifetime is shorter than the interval — and it also sets the
  worst-case latency of every delegated instruction.
- **Fix.** `watchIntervalMs` is configurable per plugin row, floored at 250 ms to keep the bridge
  from polling harder than helps. The default is unchanged at 10 s.
- **Regression test.** Covered by the acceptance run rather than a unit test, because the symptom
  only exists in a host with a lifetime; recorded here so the next person does not re-diagnose it as
  a wake-logic bug.

### D5 — the answer travelled back into the harness that produced it

- **Symptom.** With a delegated thread bound to the DSH session, the DSH side's reply was routed to
  that same session instead of to the peer that had asked. The peer waited and saw nothing.
- **Evidence.** `dsh -> codex  target={"actor":"dsh","endpointId":"dsh-endpoint","sessionId":"session-rt-dsh"}`
  — the reply's own delivery pointed back at the session it came from, and `pump: claimed …` then
  delivered it there.
- **Root cause.** The reply was enqueued without a target, so routing fell through to the thread
  binding. A delegated thread is bound to the DSH session by design, so binding-first routing is the
  wrong resolution for an *answer*: the binding says where work goes, not where a result returns.
- **Fix.** `reply` enqueues with `target: { actor: peer }`. Explicit actor addressing outranks the
  binding without rewriting it, so the answer reaches the asker and everything else on the thread
  keeps resolving through the binding.
- **Regression test.** `tests/current-session.test.mjs` §7 asserts both halves: the answer is
  addressed to the peer by actor, and the delegated binding is left intact for other posts.

---

## 8. Final Verdict

```text
CURRENT SESSION CONTROL PASS WITH DOCUMENTED LIMITATION
```

**Why it passes.** Both directions were measured on the real machine, with the stage's own marker, and
with nobody touching the harness (§4a):

- **Codex → DSH.** A delegated instruction addressed to an explicitly bound **idle** session was
  claimed, the receiver woke it (`pump: woke … attempt=1`), a turn opened, and the model saw the body
  — the instruction arriving at all proves the turn, because a delivery only reaches a session through
  one. The delivery is `acked` at `attempt=1` with `note: "woken"`, no dangling claim, and no other
  session touched.
- **DSH → Codex.** The answer on the same thread was addressed to the peer by actor, and the **real
  Codex client read it** and reported the marker verbatim (`SEEN=CURRENT_SESSION_OK_…`). Reading did
  not consume it, and the bridge invariants held.

The pre-existing runnable suite stayed green throughout (14 suites).

**The documented limitations, stated plainly:**

1. **The reply path is still the model's tool call**, not automatic capture from `turn_end` (§6).
2. **Turn identity is partial.** The correlation record carries the host's turn *number*
   (`turn: 1`), but the host exposed no independent turn id at hand-off, so `turnId` is recorded as
   `null` rather than invented.
3. **Worst-case wake latency is the watch interval** — 10 s by default, configurable (§7 D4).
4. **The wake depends on the session still existing.** If the user deletes the bound session, the
   delegated delivery stays queued and reports the reason; nothing is guessed.
5. **A reply addressed to an actor with no registered endpoint is not deliverable by the pump.** The
   answer is still fully readable — the client's pickup hook surfaces it and `read_messages` returns
   it (§4a) — but nothing claims and acks it, so it stays `queued`. Codex's adapter registers no
   endpoint today; giving it one would close that, and until then a reply to Codex is a pull, not a
   push. Worth stating because "the delivery is still queued" reads like a failure and is not one.
6. **Every condition above was measured with the same client and the same receiver.** The Claude
   adapter's half of the loop was verified separately in P3.3 and was not re-run here.

**A deployment note that cost a real diagnosis.** A mounted plugin is not hot-reloaded, so a receiver
that is running is not necessarily the receiver that was just built — an old and a current one are
identical in the trace apart from the capability flag added for exactly this reason. The same class of
problem appeared twice in one session: a process started before the code it was meant to run, and a
root cache repointed at a scratch bridge by an installation test, which made a healthy receiver
report as "no receiver has registered yet". Both are now guarded in code and by tests, and both are
worth suspecting before suspecting the protocol.
