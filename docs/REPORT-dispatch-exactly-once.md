# Exactly-once host dispatch — the side-effect window

Status: **reconnaissance positive, mechanism implemented, verified live across two receiver processes.**
Date: 2026-10-09
Predecessors: [`REPORT-commander-mode.md`](REPORT-commander-mode.md) (the turn boundary),
[`REPORT-automatic-reply.md`](REPORT-automatic-reply.md) (the return leg).
Harness: `examples/live/acp-turn-boundary.mjs --mode dispatch-recon` and `--mode dispatch-crash`.
Tests: `tests/dispatch-recovery.test.mjs` (D1–D6).

---

## 1. The problem, stated exactly

```
claim delivery → host call → host accepts → receiver dies → lease expires → another receiver retries
```

`ACK` is not the problem: the ack is written *after* the host accepted, and a crash before it leaves the
delivery claimed, which the lease resolves. The problem is that **the retry cannot tell "the host took it"
from "the host never saw it"**, and getting that wrong either loses the work or runs it twice.

Local state cannot answer it. A `dispatched = true` flag written after the call is useless when the crash
lands between the host accepting and the flag being written — which is precisely the window in question.

So the identity has to live **on the side that knows**: whatever HarnessMux hands the host must carry a key
that the host keeps, so a later process can ask the host whether that input exists.

## 2. Reconnaissance: can DSH carry a HarnessMux identity?

Measured on a live ACP host, four candidate shapes, one per turn (`--mode dispatch-recon`). Each dispatch
is a real `followup()`; the instrument records what the host did with the identity, and how long it took.

| candidate | shape | identity retrievable? |
| --- | --- | --- |
| `frozen-id` | message with a caller-supplied `id`, through `freezeMessage` | **yes** — `id` preserved |
| `plain-id` | the same object without the freeze step | **yes** — `id` preserved |
| `custom-field` | extra top-level field on the message | **yes** — field preserved |
| `source-nested` | key nested inside `source` | **yes** — preserved |

All four appear in the session's own record. The caller-supplied `id` is the strongest of them because it
lands in **two** places, and one of them is synchronous:

```
agent/inbox/spliced  seq 21   inserted[0].id = "hxmux-dispatch:recon:1"   ← appended inside followup()
user/message         seq 25   id            = "hxmux-dispatch:recon:1"   ← 25–29 ms later
```

Timing, measured (`followup()` resolves in 2–4 ms and returns `undefined`; the host appends synchronously):

| fact | measured |
| --- | --- |
| `followup()` call → resolve | 2–4 ms |
| events already appended at the instant it resolves | `agent/inbox/spliced` (the keyed message), `turn/start` |
| keyed `user/message` visible in the session list | **25–29 ms after** the call |
| keyed entry readable through `sessionQuery.observeSession` | present, from `ctx.get("sessionQuery")`, which exists in this profile |

Two consequences shaped the implementation:

- The **splice is the anchor**, not the `user/message`: it is there before the call returns, so "did the
  host take it" has an answer with no waiting.
- `dsh-llm`'s `createUserMessage` **cannot** be used: from its own source, `createMessage` overwrites `id`
  with `fresh randomUUID()`. The message is built directly — the same shape this plugin already falls back
  to, which is what the live runs were actually using all along (`llmAvailable: false` in this host).

The priority list is therefore satisfied by its best option, and no host API beyond `followup` is needed.

## 3. The mechanism

```
claimable → dispatching → dispatch_inflight → running → completed → reply_pending → replied
```

Two-phase, symmetrical with the return leg:

```
claim delivery
→ persist  state = dispatch_inflight, dispatchKey = "hxmux-dispatch:<executionId>"   ← before the call
→ call followup(message with id = dispatchKey)
→ host accepts (keyed splice is in the session record, synchronously)
→ persist  state = running                                                            ← after the call
→ ACK
```

The key is derived, never generated: `autoReplyRequestId`'s sibling. One delivery has one execution, and a
retry **rebases** that execution rather than creating a second one, so the identity the host would see does
not change between attempts.

## 4. Recovery, and why it does not guess

Three answers, and only three:

| answer | condition | action |
| --- | --- | --- |
| `found` | the key is in the target session's own record | adopt it: record `hostUserMessageId`, state `running`, ack as `recovered`. **Never call the host.** |
| `absent` | the record was read and the key is not in it | the earlier attempt left nothing behind; the dispatch is still owed, issued under the same key |
| `unknown` | no record could be read | **wait** — never treat as absent |

The record is the session's own event list: live when this process holds the session, and
`sessionQuery.observeSession(sessionId)` when it does not. `unknown` covers a session that is not loaded, a
store that cannot be read, a record that does not reach the dispatch baseline, and — because the durable
write is asynchronous — a record read within one watch interval of the call. That last margin is taken from
the receiver's own cadence rather than from a hand-picked sleep, and it is two orders of magnitude above the
25–29 ms measured.

The gate sits **before the host is touched**, in the claim path, and it distinguishes two re-claim cases: an
`dispatch_inflight` record is resolved by looking for the key; any other state that already carries a key
means the host accepted it (the state only advances after `followup` resolves), so the delivery is
acknowledged as recovered without a second call.

This is the one principle the whole stage is built to keep: **where the side effect cannot be recognised
from its own record, exactly-once is not implemented and must not be claimed.** A timeout is not evidence.

## 5. Live acceptance across two receiver processes

`--mode dispatch-crash`: receiver A is configured with a crash sentinel that fires *inside* `wakeAgent`,
immediately after the host call, and kills the process once the host has flushed what it took. A second
receiver then starts against the same home and bridge.

```
Receiver A   claim → dispatch (key hxmux-dispatch:exec-2370ec44-…)
             host accepts → agent/inbox/spliced seq 21 carries the key
             process exits (code 1) with the execution at dispatch_inflight and the delivery claimed
             nothing recorded, nothing acked

Receiver B   same DSH_HOME, same bridge, session resumed
             pump: delivery 0f442003-… was already dispatched as execution exec-2370ec44-…
                   (key hxmux-dispatch:exec-2370ec44-… in live-session);
                   recovered and acked without a second host call

failed = []
```

Every assertion, on the bridge rather than on a log line:

| assertion | result |
| --- | --- |
| receiver A died in the dispatch window | ✅ |
| A left the execution at `dispatch_inflight` | ✅ |
| A left the delivery unacked (claimed) | ✅ |
| the dispatch key was recorded before the call | ✅ |
| receiver B acknowledges it as recovered (`acked` / `recovered`) | ✅ |
| receiver B never calls the host for this delivery | ✅ |
| the host was asked **exactly once** in total | ✅ |
| the delivery was claimed twice — `attempt: 2` | ✅ |
| the session record holds the dispatch exactly once (one keyed splice, one keyed `user/message`) | ✅ |
| the execution is adopted (`hostUserMessageId == dispatchKey`) | ✅ |
| protocol invariants hold across the restart | ✅ |

`attempt: 2` is expected and correct: two receivers owned the delivery. What is exactly once is
`hostDispatchCount = 1`.

## 6. Counter-proofs

| fix removed | failing assertion |
| --- | --- |
| the claim-time dispatch gate | D4 — "receiver B does NOT dispatch the work a second time" |
| the fail-closed rule (treat `unknown` as `absent`) | D5 — "the execution stays visibly unresolved rather than being reset" |

## 7. Anti-degeneracy

D1 pins that the key is derived from the execution: two different executions with byte-identical bodies
produce different keys (`dispatchKeyFor("exec-7") != dispatchKeyFor("exec-8")`), so the mechanism cannot
silently degrade into content hashing. Nothing in the path hashes or compares message text.

## 8. Reproduction

```
$env:DSH_INSTALL_ROOT = '<install root>'      # or DSH_CLI

node examples/live/acp-turn-boundary.mjs --mode dispatch-recon                  # the identity question
node examples/live/acp-turn-boundary.mjs --mode dispatch-crash                  # the two-receiver test
node tests/dispatch-recovery.test.mjs
```

The crash mode shortens the lease (4 s) so the test does not wait out the production 120 s; that is a bridge
policy, not a semantic, and everything else is the same receiver.

## 9. Open, and deliberately out of scope here

- **Steer is not covered.** Only the idle → `followup` → new-turn path is made restart-safe. A delegated
  round already cannot be steered into a foreign turn (the ownership gate), so the main product path is
  covered; the *same-execution* steer identity is a separate host write semantics and is left for its own
  round.
- **A stopped host.** If the host dies with the dispatch still unflushed, the key is absent and the work is
  legitimately re-issued — the effect did not survive, so this is not a duplicate. Making that judgement
  automatic rather than incidental is future work; today it follows from the store being the authority.
- `wait_for_reply` latency (T0–T5) is still unmeasured.
