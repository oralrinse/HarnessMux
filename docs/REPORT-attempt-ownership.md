# REPORT — Delivery Attempt Ownership

**Question this round answers.** Why did a delegated delivery bound to
`session-f43409f1-441c-4251-ac4f-ddf74974412b` reach `attempt = 33` before succeeding?

---

## Symptom

```text
delivery 031aa6fb-8458-4145-b43b-10f9aec4173e
target   session-f43409f1-441c-4251-ac4f-ddf74974412b
final    state=acked  attempt=33  note=steered
```

The trace showed a claim followed immediately by a session mismatch, repeatedly:

```text
15:02:24  pump: claimed 031aa6fb-… attempt=31
15:02:24  pump: skip 031aa6fb-… session session-f43409f1 != session-eb41eaf4
…
15:02:44  pump: claimed 031aa6fb-… attempt=33
```

Two readings were available and both were partly right: the user's client reported it as stuck, and it
was in fact never lost — it was claimed and released once per tick until the addressee won the race.
What stopped being true is that `attempt` meant "a delivery attempt happened".

---

## Runtime version

| | |
| --- | --- |
| Process that produced the trace | mounted `2026-10-07T11:42:35Z` |
| Source after this round's work | `3272173` |
| Verdict | **the trace came from a process older than the current source** |

This could not be read from the receiver at the time — the mount line reported configuration but not
identity, so file mtimes were the only clue. That gap is now closed: the mount line carries the commit
the code was loaded from.

```text
apply: root=… endpointId=dsh-endpoint protocol=v2 autoWake=true \
  currentSessionControl=true watchMs=10000 agentsInjected=true receiver=commit:06df3a3
```

A packaged install has no `.git`, so the fallback is the module's own mtime, and a missing fingerprint
never prevents mounting.

---

## Reproduction

**Not reproduced against the running process**, because that process predates the current source —
attributing the observation to this code would be guessing, which the brief forbids.

**One hole was found and closed by reading the code**, and it is reproducible in a controlled
harness. `attempt` is incremented in exactly one place:

| Path | Effect on `attempt` |
| --- | --- |
| `claimDelivery` (core-v2) | `attempt = (queued.attempt ?? 0) + 1` — the only increment |
| `releaseDelivery` | preserved, with a comment saying the attempt was already counted at claim time |
| lease expiry | preserved |

There is exactly **one watcher per `(root, endpointId)`** (`ACTIVE_WATCHERS`), and that single tick
calls `pumpV2` once per candidate. So an ineligible session can only inflate `attempt` by *claiming* a
delivery it cannot hand over.

The guard that was supposed to prevent that required **both** sides to be known:

```js
target.sessionId !== undefined && sessionId !== undefined && target.sessionId !== sessionId
```

A candidate whose own session cannot be resolved therefore fell through and claimed a delivery
addressed to somebody else. Such a candidate is not hypothetical: `pumpCandidates()` builds
placeholders for published-but-unloaded sessions, and an agent whose `session.header.id` is missing or
malformed produces exactly this.

---

## Root cause

**Proven:** eligibility to claim was not enforced for a candidate whose own session is unresolved, and
`claim()` is the sole site that increments `attempt`. A candidate in that state claimed another
session's delivery and burned an attempt doing so.

**Not proven:** that this specific hole produced the observed `attempt=33`. The process that wrote that
trace predates the current source, so the observation stands unexplained until the restart the brief
asks for. The hole is real and closed; its role in that particular number is not established.

---

## Fix

```text
Ownership eligibility moved before claim.
```

```js
if (target.sessionId !== undefined && (sessionId === undefined || target.sessionId !== sessionId)) {
  diagnoseOnChange(`ineligible:${delivery.deliveryId}`, `${target.sessionId}`,
    `pump: ineligible ${delivery.deliveryId} target session ${target.sessionId} vs candidate session ${sessionId ?? "(unresolved)"}`);
  continue;
}
```

**This is eligibility, not ownership.** It decides who may call `claim()`; the claim's exclusive create
still decides who wins, and two eligible watchers racing is still resolved atomically. Nothing about
claim, lease, at-least-once or the ack definition changed, and an ineligible watcher now does not touch
the delivery at all — no claim, no release, no attempt, no dispatch record.

---

## Regression

The invariant, as the brief states it: **an ineligible receiver/session must not change a delivery's
claim state, lease, owner or attempt counter.**

```text
target = session-eligibility-target      (delivery bound here, delegated)
bystanders = two live sessions whose own session id cannot be resolved

assert after repeated bystander ticks:
  state      == queued
  attempt    == 0
  claims     == 0
  dispatches == 0
```

Verified both ways, which is the only standard that counts here:

| | Result |
| --- | --- |
| with the fix | `all assertions passed` |
| with the eligibility check disabled | `FAILED: an ineligible session leaves the delivery queued` |
| restored | `all assertions passed` |

An earlier guard written for the same concern was **removed** in a previous round for failing exactly
this test: disabling it did not make the test fail, so the test was not exercising it.

---

## Acceptance status

| # | Condition | Status |
| --- | --- | --- |
| A1 | DSH restarted, running version matches the source | **PENDING — needs the user** |
| A2 | B/C do not claim A's delivery | **PASS** (controlled, three sessions) |
| A3 | `attempt == 0` after many B/C ticks | **PASS** (`attempt === 0`, `claims === 0`) |
| A4 | `attempt == 1` on A's first real claim | **PASS** in the existing wake test, which asserts `attempt=1` and `note=woken` |
| A5 | delivery ends `acked`, marker only in A | **PASS** for ack in the wake test; marker isolation asserted in the same suite |
| A6 | marker absent in other sessions | **PASS** (dispatch records are per delivery; no second record) |
| A7 | idle delegated → resume+followup; running delegated → steer | **PASS** (both asserted in this suite) |
| A8 | advisory / no binding behaviour not regressed | **PASS** (asserted: not woken, stays queued) |
| A9 | protocol v2 invariants | **PASS** (`verifyInvariants().ok` in every case) |

A1 is the only item that cannot be satisfied from here, and it is also the item that decides between
the two remaining verdicts.

---

## Final verdict

```text
UNRESOLVED
```

**Why not the other two.** `STALE RUNTIME CONFIRMED — CURRENT CODE HEALTHY` would require showing that
the current code produces `attempt=1` in the multi-session scenario on the running harness; A1 is
outstanding, so that cannot be claimed. `CLAIM OWNERSHIP BUG FIXED` would require showing that the
fix changes the observed behaviour; the observed number remains unexplained, and the fix addresses a
hole that was proven by reading code, not by reproducing the incident.

**What would settle it**, in order: restart DSH; read the mount line and confirm
`receiver=commit:…` matches the source; publish three sessions with A idle; bind a thread to A with
`delegated`; send one marker; then read `attempt`, `claimOwner`, `leaseUntil`, `state` and `note`.
`attempt=1` closes this as stale runtime. `attempt>1` with `pump: ineligible` lines absent confirms the
bug is still live and the fix was insufficient.

---

## Frozen until this is settled

`create_session`, Executor session, ACP worker, Cursor, Copilot, ChatGPT adapter, other transports. A
larger session population multiplies the damage if an ineligible session can still claim.
