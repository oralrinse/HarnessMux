# v1 → v2 cutover runbook

Read this whole page before touching anything. The cutover is a **short
maintenance window**, not a zero-downtime migration. That is a deliberate
choice: a local agent bridge gains little from a distributed protocol, and every
extra moving part here is a chance to corrupt state that is otherwise correct.

---

## 1. What is actually being changed

| Layer | Before | After |
|---|---|---|
| Transport | v1: `inbox/` → destructive `read/` move + cursor | v2: immutable `messages/` + `queue/` → `claims/` → `acks/` |
| Guarantee | "probably delivered, maybe skipped" | **at-least-once**, duplicates tolerated |
| Routing | none (`to: dsh`) | `bindings/<threadId>` → (endpoint, session, mode) |
| Trust | none | `mode: advisory | delegated` per delivery |
| Audit | unbounded `log/` | `audit/` with configurable retention + `gc` |

Plugin config keeps `protocolVersion: "v1" | "v2"`; **v1 stays the default** until
this runbook completes. v1 code is not deleted in the first v2 release.

---

## 2. Rules the migration must not break

These are frozen; changing one silently invalidates the protocol's guarantees.

1. **Legacy ids survive verbatim.** Random/UUID ids are a *generation* strategy
   for new messages. Rewriting a legacy id would strand `replyTo`, thread
   history, `refs`, and audit records that point at it.
2. **v1 `read/` never becomes a v2 ack.** v1 `read/` only proved "the mailbox
   moved the file"; it never proved "the host accepted the delivery". Importing
   it as an ack would falsify the first ack in the new protocol.
3. **Union scan, hard conflict.** `inbox/`, `read/`, and `log/` were never
   transactional, so all three are read and grouped by id. Any disagreement
   aborts with `MIGRATION_CONFLICT` — never "log wins", never "newest wins".
4. **Idempotent and resumable.** A second run creates nothing. Delivery ids are
   journaled (`migration/v1-to-v2.json`) on first creation instead of being
   re-derived, so the protocol needs no hash/UUIDv5 id rule.
5. **No dual-write.** Writing v1 and v2 on every message recreates a
   cross-protocol transaction problem. Cut over; do not run both writers.
6. **Rollback means rolling back the code**, not un-migrating state. A delivery
   that v2 already acked cannot be made "un-delivered" in v1.

## 3. Disposition map

| v1 location | v2 result | Delivery? | Ack? |
|---|---|---|---|
| `inbox/<id>.json` | immutable `messages/<id>.json` | yes, **unrouted**, mode `advisory` | no |
| `read/<id>.json` | immutable message | no | **no** — recorded as `legacy-consumed` |
| `log/<id>.json` only | immutable message | no | no — audit import |

Migrated deliveries are deliberately unrouted: v1 carried no endpoint or session,
so v2 must not invent one. They sit in `queue/` as `awaitingBinding` until a
`bind` names a target.

---

## 4. Cutover procedure

```sh
# 0. Baseline: nothing may be mid-flight.
agent-bridge-v2 --root <root> status

# 1. Stop the writers — this is the quiescence window.
#    - quit the DSH Desktop app (or stop `dsh web`)
#    - stop/pause the Codex bridge writer (any agent currently posting)

# 2. Optional but recommended: copy the v1 bridge aside.
cp -r <v1-root> <v1-root>.pre-v2

# 3. Plan: writes nothing, shows exactly what would happen.
node lib/mailbox-v2.mjs --root <v2-root> migrate --source <v1-root> --dry-run

# 4. Migrate.
node lib/mailbox-v2.mjs --root <v2-root> migrate --source <v1-root>

# 5. Prove the invariants before anything consumes the data.
node lib/mailbox-v2.mjs --root <v2-root> verify
#    expect: OK, plus awaitingBinding listing the migrated deliveries

# 6. Bind the threads that should be consumed, then switch the plugin.
#    In ~/.dsh/profiles/<profile>/cordis.patch.yml:
#      config:
#        protocolVersion: v2
#        endpointId: dsh-endpoint
```

Exit codes: `0` ok · `1` usage/error · `3` delivery state conflict ·
`4` invariant violation · `5` migration conflict or unreadable source.

## 5. Post-cutover acceptance (the V4 / V1 matrix)

Run these against a **real Desktop process and a real model**. The protocol being
correct is not the same as the production path being correct.

| # | Scenario | Pass condition |
|---|---|---|
| V4-1 | Restart DSH Desktop | `mailbox` tool exists in a fresh session |
| V4-2 | Active agent, one bound delivery | the delivery is steered into that session |
| V1 | Idle root agent, one bound delivery | `steer()` starts a turn (confirm or refute; do not assume) |
| V4-3 | After a successful steer | the delivery appears in `acks/`, not `queue/` |
| V4-4 | Kill the process between steer and ack | after restart the same `deliveryId` is re-delivered with `attempt + 1` and **no loss** |
| V4-5 | Two DSH sessions, unbound message | neither session consumes it; `awaitingBinding` = 1 |
| V4-6 | Bind the thread to one session | only that session consumes it |

V4-4 is the one that matters most: a duplicate is the correct outcome. If a test
ever "passes" by delivering only once there, the ack was moved before the
hand-off and the guarantee is broken.

## 6. If something goes wrong

| Symptom | Cause | Action |
|---|---|---|
| `MIGRATION_CONFLICT` | v1 copies disagree | diff the named copies by hand; decide the truth **as a human**, then re-run. The migrator will not guess |
| `MIGRATION_UNREADABLE` | a legacy file is not JSON | inspect the named file; repair or remove it, then re-run |
| `verify` exits 4 | an invariant is violated | do **not** consume deliveries; inspect `queue/`, `claims/`, `acks/` for that id |
| deliveries stuck `claimed` | a crashed consumer holds a lease | `reconcile` (or wait for `leaseMs`); the delivery returns to `queue/` with its `attempt` intact |
| nothing is consumed | the thread is unbound | `bind <threadId> --endpoint <id> [--session <id>]` |

Rollback: restore the pre-v2 copy of the bridge root and set
`protocolVersion: v1` again. Do not attempt to convert v2 acks back into v1
state.
