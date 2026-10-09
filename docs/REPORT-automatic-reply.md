# Automatic final reply — the return leg

Status: **P1b and P1c implemented and verified on a live host.**
Date: 2026-10-09
Predecessor: [`REPORT-commander-mode.md`](REPORT-commander-mode.md) (P1a: the execution boundary and final
capture, measured and closed).
Harness: `examples/live/acp-turn-boundary.mjs` (`--mode reply-crash`, `--reply-mode auto|explicit`).
Tests: `tests/auto-reply.test.mjs` (A1–A8).

---

## 1. What was missing

Capture worked; delivery did not. An execution recorded `finalText` and then nothing happened — no
message was ever posted back, so the Commander waited forever and "sending work is not completion" was
literally true. This stage is that missing half, and the only hard requirement is **exactly once**: the
Commander must receive the executor's answer once, and never twice.

## 2. Two facts, not one flag

The return leg needs to distinguish "the work is done" from "the answer has been sent". A single
`completed` state cannot express "the executor finished and the reply never went out", which is exactly
the state a crash produces.

```
dispatching → running → completed → reply_pending → replied
                                     ↑              ↑
                        a reply is owed      the reply is recorded as sent
```

`reply_pending` is written **before** the reply is posted, so a process that dies in the window leaves a
record that says "an answer was owed here" rather than a record that looks finished. `failed` is a turn
the host reported as an error, and `dispatch_failed` remains a hand-off that never happened.

Aligning the vocabulary was part of this: `EXECUTION_STATES` used to export `turn_completed` while
`endTurn` actually wrote `completed`, so the documented states and the written ones disagreed. They now
agree, and `completed`/`reply_pending` count as outstanding work for the return leg — an execution whose
turn is over but whose answer is owed is still visible to the watcher and to the reconciler, and still
cannot be mistaken for an owned open turn (`ownsOpenTurn` requires a turn with no `turnEndSeq`).

## 3. Exactly once, by construction

The reply's idempotency key is derived, never generated:

```
autoReplyRequestId = "auto-final:" + executionId + ":" + finalAssistantMessageSeq
```

Neither input can change after the fact, so a retry computes the same key. The order is:

```
turn/end completed
→ finalAssistantMessageSeq = Q, finalText != ""
→ state = completed
→ requestId = auto-final:<E>:<Q>
→ state = reply_pending                     ← written before anything is sent
→ look up requestId; if it exists, reconcile to that message
→ postMessage(reply, clientRequestId = requestId)
→ record automaticReplyMessageId, state = replied
```

A crash after the post and before the write-back therefore leaves a message the Commander can already
read and a record that does not know about it — and the next reconciliation finds the message by key
instead of sending a second one. A random id here would make every crash a duplicate answer, which is the
failure the whole layer exists to prevent.

The reply's delivery is repaired separately (`ensureReplyDelivery`): the crash window has two edges, and a
reply posted without its delivery is fixed by *enqueueing the delivery for the existing message*, not by
posting another message.

## 4. The route comes from the execution, and nowhere else

```
from      = dsh (this harness's actor)
target    = execution.originActor
threadId  = execution.threadId
replyTo   = execution.originMessageId
kind      = report
mode      = advisory      (a result travelling back, not work being handed out)
```

The `turn`, the `assistant/message`, the provider stream and the current thread binding all answer *what
the result is*; only the execution answers *who asked for it*. Re-deriving the destination from any of the
others is how an answer ends up on the wrong thread — or, as measured in the previous round, back into the
session that had just produced it. The body is the captured text byte for byte, with nothing wrapped
around it, so a reviewer can compare what the Commander received with what the executor said.

## 5. What is answered, and what is left diagnosable

Only this is sent automatically:

| condition | required |
| --- | --- |
| `state` | `completed` or `reply_pending` |
| `reason.kind` | `completed` |
| `finalText` | non-empty after trimming |
| `finalAssistantMessageSeq` | an integer |
| `automaticReplyMessageId` | `null` |
| `explicitFinalReplyMessageId` | `null` |
| `threadId`, `originActor` | present |

Everything else keeps its own state rather than becoming an answer: a turn that completed with no visible
text (`completed`, nothing sent — an empty message must never be sent), an errored turn (`failed`), an
unknown terminal reason, or a reply with no thread or no addressee to answer on.

## 6. P1c — an explicit final reply is the answer

The executor can answer the Commander itself with `mailbox action=reply`. The tool's reply action now
takes `disposition`:

- `progress` (default) and `question` — part of working; the automatic reply still carries the result.
- `final` — this reply **is** the result; the automatic reply is suppressed, so the Commander receives one
  final answer rather than two.

The execution records `explicitReplyMessageIds[]` and `explicitFinalReplyMessageId`, so "who answered" is
never ambiguous. A `final` reply recorded while the turn is still running promotes the record to `replied`
once the turn ends (`markRepliedExplicitly`), because the return leg genuinely is complete — it simply did
not travel through this layer.

The default is `progress` on purpose. A forgotten flag costs a duplicate answer, whereas the opposite
default would silently replace the result with a progress note — a loss, not noise. The executor skill was
updated to use `disposition=final` for the reply that *is* the deliverable report, and the live run below
shows the model following that instruction.

## 7. Live verification (ACP host, isolated home)

### 7.1 The automatic route

`--mode reply-crash --rounds 1 --reply-mode auto`:

```
round 1 ownTurns=[{"seq":22,"turn":2}]
        exec=exec-7b2dfffa-… state=replied baseline=20 turns=[2] finalTurn=2 finalSeq=27 finalText="ROUND_1_DONE"
round 1 returnLeg failed=[] counts={"automaticReplies":1,"logicalRepliesForExecution":1,"allMessages":2}
reply-crash failed=[]
```

All eleven assertions passed, on the bridge rather than in a log line:

- the reply exists, and there is **exactly one logical reply** for that execution;
- `reply.threadId == origin.threadId`, `reply.replyTo == origin.messageId`, `reply.from == dsh`;
- its delivery's `target.actor == codex` and it carries no `sessionId`;
- `reply.body === execution.finalText` byte for byte;
- `execution.automaticReplyMessageId == reply.messageId` and `state == replied`;
- `verify` reports the protocol invariants hold.

### 7.2 The crash window

The reply exists on the bridge; the execution does not know it. That is the exact on-disk state a process
that dies between `postMessage` and the write-back leaves, and it is what the reconciler reads. The probe
rewrites the record to `reply_pending` with `automaticReplyMessageId: null` and then **does nothing** — the
receiver's own tick reconciles:

```
replyPostedBeforeCrash : 2d025056-41f9-4f2a-9c1b-8771d6c1f704
recordStateDuringCrash : reply_pending   (automaticReplyMessageId = null)
reconciledMessageId    : 2d025056-41f9-4f2a-9c1b-8771d6c1f704   ← the same message
recordStateAfter       : replied
automaticRepliesBefore : 1
automaticRepliesAfter  : 1                 ← no second answer
trace                  : reply: execution exec-7b2dfffa-… reconciled to the reply already posted as
                         2d025056-… duplicateSuppressed=true (auto-final:exec-7b2dfffa-…:27)
failed                 : []
```

What is simulated there is the death; what is real is the durable state and the reconciliation. The
in-process half — a *fresh receiver instance* over the same store, with no shared memory — is covered
separately by `tests/auto-reply.test.mjs` A6, which mounts the plugin, crashes it with the sentinel, and
mounts a second instance that must find the same message.

### 7.3 The explicit route

`--mode round --rounds 1 --reply-mode explicit`: the delegated task asks the executor to answer the
Commander itself with `disposition=final`. The run is accepted only if the automatic path posted **nothing**
while exactly one answer exists on the origin thread, addressed to the actor that asked, with the
execution's return leg recorded complete.

```
round 1 ownTurns=[{"seq":22,"turn":2}]
        exec=exec-5d960eef-… state=replied baseline=20 turns=[2] finalTurn=2 finalSeq=41
round 1 returnLeg failed=[] counts={"automaticReplies":0,"explicitAnswers":1}
```

The executor's own account of what it did, taken from the captured answer:

```
replied [edd3968b-…] on thread=turn-boundary-1-f5a828872952cb22 delivery=98c3368c-… target=codex@(no endpoint)
disposition=final recordedOnExecution=true — the automatic final reply for this execution was suppressed,
so codex receives exactly one final answer, no duplicate.
```

So the P1c contract holds end to end on a live host: the executor marked its reply as the result, the
receiver recorded `explicitFinalReplyMessageId`, the execution went to `replied`, and the automatic path
produced zero messages. Note that the model followed the instruction from the executor skill — the same
run without `--reply-mode explicit` (and before the skill was updated) chose `final` on its own, which is
why the probe states the route it expects instead of accepting whichever one happened.

## 8. Counter-proofs

| fix removed | failing assertion |
| --- | --- |
| the pre-post `findMessageByRequestId` lookup | A6 — "the restarted receiver does not answer the Commander a second time" |
| the `explicitFinalReplyMessageId` suppression in `owesAutomaticReply` | A4/A8 — "neither does one the executor already answered itself" |
| `autoReplyRequestId` determinism | A1 — the id is stable, distinct per execution, and empty when it cannot be derived |

## 9. Reproduction

```
$env:DSH_INSTALL_ROOT = '<install root>'      # or DSH_CLI

node examples/live/acp-turn-boundary.mjs --mode reply-crash --rounds 1 --reply-mode auto
node examples/live/acp-turn-boundary.mjs --mode round --rounds 1 --reply-mode explicit
node tests/auto-reply.test.mjs
```

The probe's assertions are a gate, not a printout: any failed one exits non-zero and is listed in
`summary.json` as `failures`.

## 10. What is still open

- **P1d — restart reconciliation for deliveries.** The reply's crash window is closed. The *dispatch*
  window — a delivery claimed and handed over by a process that then dies — is still handled the way it
  was: the lease expires and the delivery is retried, so the work can run twice while the reply is
  exactly-once. Reconciling a delivery whose turn already ran is the remaining half.
- **A reply is never retracted.** If the executor sends a `final` explicit reply and then the automatic
  path had already run for that execution, both exist. The ordering is not currently detected, because the
  automatic path is the fast one: it fires on the first tick after the turn ends.
- `wait_for_reply` latency (T0–T5) is still unmeasured.
