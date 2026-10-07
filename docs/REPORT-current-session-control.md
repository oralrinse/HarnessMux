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

| # | Condition | Verdict | Evidence |
| --- | --- | --- | --- |
| C1 | the session was `idle` before sending | **PASS** | `CSC session=session-csc-15ee171c status=idle` |
| C2 | HarnessMux resumes and follows up on its own | **PASS** | `pump: claimed …` then `pump: woke session-csc-15ee171c for …` — no user action |
| C3 | the session goes `idle → running` with a new turn | **PASS** | host `agent/status -> running`, then `-> idle`; dispatch record `turn: 1` |
| C4 | the model received the body verbatim | **PASS** | the marker was found **in the target session's own event log**, as `user text codex delivered a message through the harnessmux (delivery 168f8941-…)` |
| C5 | `attempt=1`, `state=acked`, no dangling claim | **PASS** | section 3 |
| C6 | no other session received it | **PASS** | exactly one dispatch record exists; three other sessions' deliveries are still `queued`; the trace shows `pump: skip … session X != Y` for each |
| C7 | the result returns to Codex | **PASS (model tool path)** | section 6 |
| C8 | Codex sees it on its next lifecycle | **PASS (by construction, unchanged)** | the Codex adapter's pull hook is untouched; it was verified end to end in P3.2 and its behaviour is not modified here |

C4's evidence is the one that matters. `acked: true` is not treated as success anywhere in this
report: the claim is only that the **model's own session log contains the marker**, which is what
"the model really received the body" means.

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

**Current state: the model's own `mailbox`/`reply_message` tool.** This is stated plainly because
the two must not be confused:

- **In use now:** the DSH model calls `reply_message` and the reply travels back over protocol v2 to
  the originating thread. The recipient resolution for that reply — including the loop-back case
  where a binding points back at the receiving session — is reported by the tool itself.
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

---

## 8. Final Verdict

```text
CURRENT SESSION CONTROL PASS WITH DOCUMENTED LIMITATION
```

**Why it passes.** On a real host, with the user doing nothing in DSH, a delegated instruction
addressed to an explicitly bound idle session was claimed, woke that session, opened a turn, and the
model's own session log contains the marker verbatim. The delivery is `acked` at `attempt=1` with no
dangling claim, no other session was touched, the bridge invariants hold, and the pre-existing
runnable suite stayed green throughout.

**The documented limitations, stated plainly:**

1. **The reply path is still the model's tool call**, not automatic capture from `turn_end` (§6).
2. **Turn identity is partial.** The correlation record carries the host's turn *number*
   (`turn: 1`), but the host exposed no independent turn id at hand-off, so `turnId` is recorded as
   `null` rather than invented. This is enough to say which turn a delivery caused, and not enough
   to address that turn later.
3. **Worst-case wake latency is the watch interval** — 10 s by default, configurable (§7 D4).
4. **The wake depends on the session still existing.** If the user deletes the bound session, the
   delegated delivery stays queued and reports the reason; nothing is guessed.
5. **C8 was not re-measured in this stage.** The Codex lifecycle hook path is unchanged and was
   verified in P3.2; re-running it requires a Codex client to be driven, which is a separate
   acceptance.
