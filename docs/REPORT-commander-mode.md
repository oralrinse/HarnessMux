# Commander Mode — the turn boundary, measured

Status: **P0/P1a closed by measurement; two defects found and fixed.**
Date: 2026-10-09 (measurement round)
Harness: `examples/live/acp-turn-boundary.mjs` + `examples/live/turn-boundary-probe`
Receiver under test: `packages/receiver-dsh/index.js` at `0f99ce1` + this round's fixes.

---

## 1. Why the earlier rounds could not answer the question

The open question was E4–E10 of the Commander audit: *a delegated delivery is acknowledged, but no new
`turn/start` is ever observed, and no final answer is ever captured.* Every attempt to observe one used
`dsh --profile headless`, and that host cannot show it. From the shipped source
(`@deepseek-ai/dsh-headless/lib/index.js`):

```
await agent.whenIdle()            // wait for the boot turn
agent.followup(createUserMessage({ content: [{ type: "text", text: task }], source: { kind: "user" } }))
await agent.whenIdle()            // wait for that turn
await sessions.flush(agent.session)
io.exit(outcome.reason?.kind === "completed" ? 0 : 1)
```

One task, one turn, then the process exits. The window in which the session is both **idle and alive** —
the only window in which "wake an idle session" can be tested — is the few milliseconds between
`turn/end` and `os.exit`, which is shorter than one pump tick. A delivery therefore always arrived
during the boot turn, and "the work was folded into turn 1" is a fact about the *test host*, not about
the receiver.

This round used `dsh --profile acp`: a long-lived host driven over stdio JSON-RPC, where `session/new`
creates a session, `session/prompt` runs one turn and resolves when it ends, and the process stays alive
and idle afterwards. An isolated `DSH_HOME` (`$TEMP/hxlab-<id>/dshhome`) means nothing the user owns is
touched; the credentials are copied in from `~/.dsh` and deleted before exit.

---

## 2. Where turn and content facts actually live

The instrument dumps **three** candidate sources of a session's events on every 150 ms tick, because
three of them exist and the receiver reads two of them for different purposes:

| source | accessor | read by |
| --- | --- | --- |
| `log` | `session.log` | the ownership gate (`sessionTurnState`) |
| `snapshot` | `session.snapshotEvents()` | the log watcher (`watchSessionLogs`) and the dispatch baseline |
| `durable` | `session.seq` + `session.eventAt(seq)` | the shipped one-shot runner's own summary |

**Measured: they are identical, event for event, in every run and at every sequence.** `logLen ==
snapshotLen == durableLen` and the `(seq, type)` pairs match exactly, including `turn/start` and
`turn/end`. So the receiver's split between them is a choice of authority, not a workaround for a lagging
projection — and no fix should be built on a "the snapshot is stale" theory. (The earlier `logLen=21
snapshotLen=21` observation was right; this confirms it with all three sources and while turns are open.)

One timing fact does matter and is now recorded: **the ACP wire protocol leads the session log.**
`session/prompt` resolved with `stopReason: "end_turn"` after 3.1 s, and the turn's own
`assistant/message` / `step/end` / `turn/end` did not appear in the session list until ~0.5–1.0 s later.
A probe that stops reading when the wire says "done" sees a session with no answer in it — which is what
happened in this round's first two smoke runs, and was a probe defect, not a product one.

---

## 3. The event chain of one delegated round

Three deliveries were sent to one session, each only after the previous turn had closed — so each met a
session that was **provably idle** (no open `turn/start` in the log at dispatch time). All three produced
the same chain. Round 1 verbatim:

```
20  turn/end      turn=1 reason=completed          <- the last ordinary prompt finished
21  agent/inbox/spliced  target=next-turn  inserted=1  removed=0   <- the delivery arrives
22  turn/start    turn=2
23  agent/inbox/spliced  target=next-turn  inserted=0  removed=1   <- the splice is consumed
24  step/start    {turn:2, step:1}
25  user/message  id=dcdf6358-71d4-4c0c-95d2-068e59808e08
26  session-log-deepseek/delivery-accepted
27  assistant/message turn=2 step=1 text="ROUND_1_DONE"
28  step/end      {turn:2, step:1}
29  turn/end      turn=2 reason=completed
```

The same shape repeated for rounds 2 and 3, with turns 3 and 4 and fresh ids. Sequence numbers depend on
how long the model's answers are, so the table below is from the committed probe's own run
(`--mode round --rounds 3`, lab `hxlab-kuz5sk`); the chain above is from an earlier run with shorter
answers, and its round-1 numbers coincide.

| round | idle before? | splice in | `turn/start` | splice out | `user/message` id | `turn/end` | execution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | yes (`sinceSeq` 20) | #21 | #22 turn 2 | #23 | `817dcea6…` | #35 `completed` | baseline 20, turn 2 (22→35), final #33 |
| 2 | yes (`sinceSeq` 35) | #36 | #37 turn 3 | #38 | `18ffe7f7…` | #50 `completed` | baseline 35, turn 3 (37→50), final #48 |
| 3 | yes (`sinceSeq` 50) | #51 | #52 turn 4 | #53 | `c0be5141…` | #65 `completed` | baseline 50, turn 4 (52→65), final #63 |

For that run the probe also confirmed `sources equal: true` — `session.log`, `snapshotEvents()` and the
durable `eventAt` range held exactly the same sequence list.

### The five questions, answered

1. **Does each input produce its own new `turn/start`?** Yes — 3/3, turns 2, 3, 4, each at a sequence
   above its dispatch baseline.
2. **Does each follow-up produce a new `agent/inbox/spliced` with `target=next-turn`?** Yes, and there
   are **two** per input: one inserting the delivery text (`inserted=1`), one draining it
   (`inserted=0, removedCount=1`). `target=next-turn` is a routing hint that is honoured exactly once and
   then consumed — it is not itself the turn.
3. **Does each follow-up produce an independent `user/message`?** Yes — exactly one per delegated turn,
   with a distinct id each time. (The boot turn had four, because the briefing, the runtime-context note
   and the skills reminder are spliced in once per session; follow-up turns carry only the delivery.)
4. **How does `assistant/message` correspond to the most recent input?** By `data.turn`. A turn has one
   `assistant/message` per step and only the last carries visible text: in the boot turn, `#18` was
   `step=1 text=""` (the model called a tool) and `#24` was `step=2 text="PROMPT_ONE_OK"`. So the answer
   is the last text-bearing message **within the turn**, never a join across steps.
5. **Is the previous work's terminal signal `turn/end` or `status → idle`?** Both, together, and
   `turn/end` is the authority: `turn/end reason={"kind":"completed"}` entered the log in the same tick
   in which `agent.status` went `running → idle`. The receiver reads the log, which is the durable one.

### Automatic final capture, on a real host

For the same three rounds, the execution records written by the receiver:

| round | baseline | turn (start→end) | final message | final text |
| --- | --- | --- | --- | --- |
| 1 | 20 | 2 (22→29) | #27 | `ROUND_1_DONE` |
| 2 | 29 | 3 (31→38) | #36 | `ROUND_2_DONE` |
| 3 | 38 | 4 (40→47) | #45 | `ROUND_3_DONE` |

E4, E5, E7, E8, E9 and E10 are therefore all satisfied on a live host: a new turn opened above the
baseline, the turn was recorded from the session's own `turn/start`, only `completed` ended it, and the
final text and its sequence were captured per execution.

---

## 4. Defect 1 — the captured answer was doubled

**Symptom.** Every execution's `finalText` read `"ROUND_1_DONEROUND_1_DONE"` where the model had said
`"ROUND_1_DONE"` once. Reproduced by calling the shipped function on the real captured event:

```
content text blocks      : ["ROUND_1_DONE"]
embedded stream blocks   : ["ROUND_1_DONE"]
capture.visibleTextOf()  : "ROUND_1_DONEROUND_1_DONE"
```

**Cause.** A real `assistant/message` event carries both the finished message and the raw provider stream
that produced it, and the stream repeats the text in a `block-end` chunk:

```
data.message.content[1]    = { type: "text", text: "ROUND_1_DONE" }
data.stream[5].chunk.block = { type: "text", text: "ROUND_1_DONE" }
```

`visibleTextOf(event)` walked the **whole event**, so it collected both copies. It was added this round
with the intent "only collect `type === "text"`, in content order" — the filter was right and the
*subtree* was wrong.

**Fix** (`packages/core/final-capture.mjs`): the walk is bounded to `event.data.message`. The message is
the content authority; the stream is transport, and a copy is not a second source. The same bound fixes
the other half: a message with no visible text can no longer be made to look answered by text that only
its transport carried.

**Regression test.** `tests/mapping.test.mjs` M24 uses the real event shape (message + embedded stream)
and asserts the text is counted once and that a text-free message stays answerless. M21 no longer
re-implements the walk inline — a test that owns a copy of the algorithm cannot fail when the algorithm
changes, which is exactly how this survived.

**Falsification.** Restoring `walk(event)` fails M24 with `'ROUND_1_DONEROUND_1_DONE'` vs
`'ROUND_1_DONE'`. Restored, it passes.

---

## 5. Defect 2 — the ownership gate did not cover the steer path

This is the defect the audit recorded as *"the ownership gate did not take effect on the delivery that
landed in an already-open turn"*.

**The rule, as frozen:** idle → `followup`, a new turn; a running turn **this execution owns** → its own
continuation; a running turn **it does not own** → WAIT_FOR_IDLE, no steer, no ACK. The reason is
attribution: steering into somebody else's turn makes the final assistant message a mixture of that work
and this delivery, so a reply could not honestly claim to be this execution's answer.

**What the code did.** `authorizeWake()` decided `running → "steer"` *first*, before authorization was
consulted, and the ownership gate lived inside `wakeForDelivery()` — the wake path. A delegated delivery
claimed while the agent was running therefore took the steer path, which had no gate at all.

**Measured on a live host** (a long unrelated turn open in the session; the delegated delivery sent
during it):

```
02:55:55.068  pump: claimed 44346402-… attempt=1
02:55:55.075  delivery 44346402-… state=acked note=steered        (7 ms later, no deferral line)
              whileBusy: open turn 5, state=acked
              new turn/start after the delivery: none
              execution exec-49a063cd-…: turns=[] baseline=89 finalTurn=5 finalSeq=105
                                          state=completed finalText=1945 chars  <- the other turn's answer
```

Two coupled defects are visible in that record: the delivery was handed into a foreign turn, and the
execution was then **completed on a turn it had never opened** (`turns: []`), storing somebody else's
1945-character answer as this delivery's result. The reply would have claimed work it did not do.

**Fix** (`packages/receiver-dsh/index.js`):

1. The ownership decision is taken **once**, in `pumpV2`, before the delivery is claimed and before
   either hand-off is chosen — so the steer path and the wake path obey the same rule. It applies to
   Commander rounds only (a delegated delivery on an explicitly delegated binding); advisory traffic and
   unbound work keep steering, as before.
2. Doing it **before the claim** is deliberate: `attempt` is incremented by `claimDelivery` and nowhere
   else, so claiming in order to hand the delivery straight back would turn "a delivery attempt happened"
   into "a poll happened" for every tick of somebody else's long turn.
3. `watchSessionLogs` now refuses to complete an execution on a `turn/end` for a turn it never recorded
   opening. The watcher bounds its reading at the dispatch baseline, so a turn that was already open at
   dispatch still showed a *fresh* `turn/end`; failing closed here means no other path can produce a mixed
   answer either.

**Verified on a live host after the fix** (the promoted probe, `--mode contended --rounds 0`):

```
03:29:29.982  pump: defer 3f5ac015-… — <session> is running turn 2 (start#22)
                      which this execution does not own; not steering, not claiming
   whileBusy: 18 samples over ~9 s -> state=queued, attempt=0, ackedAt=null, foreign turn open
03:29:41.127  pump: claimed 3f5ac015-… attempt=1          <- only after turn/end#35
03:29:41.141  pump: woke <session> for 3f5ac015-… attempt=1
              own turn: turn/start seq 37 -> turn 3
              execution: state=completed turns=[3] baseline=29 finalTurn=3 finalSeq=82
                         finalText="## Delegated task … — handled" (the delegated answer, 2 kB)
              delivery: state=acked note=woken
              ackedBeforeForeignTurnEnded=false   (ack time vs the foreign turn's own turn/end time)
```

`attempt` stayed at 0 for the entire foreign turn and reached exactly 1 when the delivery was actually
handed over. The last two numbers are read from two timestamps — the ack's own `ackedAt` and the foreign
turn's own `turn/end` — rather than from a sampling race; an earlier run of this probe was misread as
"acked while busy" by looking at the delivery a moment after that turn had closed.

**Regression tests.** `tests/current-session.test.mjs` test 4b (a running agent whose open turn nobody
owns is not steered, not woken, not claimed, not acked) and test 4c (a `turn/end` for an unrecorded turn
does not complete the execution and does not store its text). `tests/mapping.test.mjs` M23 asserts the
single placement: the gate precedes the claim, and neither claims nor acks.

**Falsification.** Disabling the steer-path gate fails 4b (`a turn this delivery does not own is never
steered into`); disabling the unrecorded-turn guard fails 4c (`an execution is not completed by a turn it
never opened`). Both restored, both pass.

---

## 6. Reproduction

The launcher is not in a standard install location on every machine, so `env.mjs` resolves it from
`DSH_CLI` / `DSH_INSTALL_ROOT`:

```
$env:DSH_INSTALL_ROOT = '<install root>'          # or: $env:DSH_CLI = '<...>\dsh.cmd'

node examples/live/acp-turn-boundary.mjs --mode smoke                     # harness self-check
node examples/live/acp-turn-boundary.mjs --mode round --rounds 3          # idle-session rounds
node examples/live/acp-turn-boundary.mjs --mode contended --rounds 0      # busy-session gate
npm run test:turn-boundary                                                # the round mode
```

Each run creates an isolated `DSH_HOME` and bridge under `$TEMP/hxlab-<id>/`, copies the two credential
files in from the user's own harness home, and deletes them before exiting; the probe JSONL, the
receiver trace, the host output and `summary.json` stay behind so a run can be re-read. The session's
working directory is that scratch directory — not the repository — so a live sandbox never tries to grant
itself write access to the checkout. The probe runs a real model, so it is deliberately not part of
`npm test`.

---

## 7. Still open

- **No automatic reply.** Final capture records `finalText` on the execution, but nothing ever writes
  `automaticReplyMessageId` or posts the answer back on the thread — `packages/receiver-dsh/index.js`
  only calls `setFinalAnswer`. Capture without a reply is still "sending work is not completion"; this
  is the next P1 task, and it is now testable end-to-end because the capture is measured to work.
- **`wait_for_reply` latency (T0–T5)** has still never been measured.
- **`create_session` / configured sessions (P3)** remains frozen as designed: `ctx.agents.create()`
  produces a primitive session with no `agentPreset`, no `cwd` in the header and a prompt assembly that
  fails on `{{model}}`, so `create_session` fail-closes to the report.
- The `attempt=33` history is still not fully explained. This round removed one way to burn attempts
  (claiming in order to defer), so a fresh occurrence would now be a different cause.
