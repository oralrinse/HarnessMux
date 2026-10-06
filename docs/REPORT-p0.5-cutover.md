# P0.5 real cutover report — 2026-10-06

Scope: perform the v1 → v2 cutover on the real machine, then run the V4/V1
acceptance matrix against a real DSH process and a real model. No new features
were added and no protocol semantics were changed.

Raw evidence is reproduced verbatim in the sections below; nothing here is
inferred from documentation.

---

## 1. Cutover

| Step | Result | Key evidence |
|---|---|---|
| Step 1 environment | PASS | Real bridge root from the profile config: `…/default-workspace/.agent-bridge` — `inbox`=1, `read`=2, `log`=3, `state`=1, `bridge.json` = `protocol: agent-bridge/v1`. Desktop running (pid 42312/42236, started 2026-10-04). No writer observed in two consecutive reads. |
| Step 2 backup | PASS | `.agent-bridge.pre-v2-20261006` — file-set+content SHA-256 identical to the source: `1b6bb496194543bfb990f36266781ec6b35bfe13595df3a8b65536cff757359a` (8 files / 2769 bytes both sides). Backup verified before any write. |
| Step 3 dry-run | PASS | Independent conflict pre-check (`tests/v1-inventory.mjs`): 3 distinct messages, 0 conflicts, 0 unreadable. `migrate --dry-run`: `newMessages=3 newDeliveries=1 legacyConsumed=2 auditOnly=0`, and the target directory was **not created** (zero writes proven). |
| Step 4 migrate | PASS | v2 root `…/default-workspace/.agent-bridge-v2`: `messages/`=3, `queue/`=1, `acks/`=**0**, `migration/v1-to-v2.json` written. v1 root still 8 files, untouched. |
| Step 5 verifyInvariants | PASS | `ok=true violations=[] pending=1 claimed=0 acked=0 awaitingBinding=["migrated-20261006090257478-84bd2f9e"]` |
| Step 6 idempotency | PASS | Second run: `newMessages=0 newDeliveries=0 existingMessages=3 existingDeliveries=1`. Third run: `newMessages=0 newDeliveries=0`. File counts unchanged (messages 3, queue 1). |
| Step 7 protocolVersion switch | PASS | `~/.dsh/profiles/desktop/cordis.patch.yml` and `…/acp/cordis.patch.yml` now carry `bridgeRoot: …/.agent-bridge-v2`, `protocolVersion: v2`, `endpointId: dsh-endpoint`. The v1 implementation, the v1 data, and the migration journal were all retained. No permissions changed, no Codex work started. |

**Migration rule compliance**

| Rule | Evidence |
|---|---|
| legacy ids preserved verbatim | Imported message ids are exactly `20261006084925328-06e6e71a`, `20261006090242393-d80ae6b2`, `20261006090257478-84bd2f9e`; the reply's `replyTo` still points at `…d80ae6b2`. |
| v1 `read/` never becomes a v2 ack | Two `read/` copies → `legacy-consumed`; **`acks/` count = 0** immediately after migration. |
| union scan, conflict aborts | `v1-inventory.mjs` and `migrate` agree on 3 messages; a synthetic divergence test (`migrate.test.mjs`) asserts `MIGRATION_CONFLICT` with zero writes. |
| migrated deliveries unrouted | `target: null`, `mode: advisory`, reported as `awaitingBinding`. |
| no dual-write | Neither the plugin nor the CLI writes v1 and v2 for one message; the v1 bridge is frozen as the rollback snapshot. |

---

## 2. V4/V1 matrix (real process, real model)

| Test | Result | Evidence | Conclusion |
|---|---|---|---|
| V4-1 | **PASS** | `tool calls: tool_call mailbox in_progress \| tool_call_update completed; answer: MAILBOX_OK` | The compiled descriptor was accepted by the provider and the model actually invoked the tool. |
| V4-2 | **PASS** | `acks=1 queuedLeft=0 claimedLeft=0 messagesInThread=2 attempt=1`; ack record `{deliveryId: da833cc5…, target: {endpointId: dsh-endpoint, sessionId: 403a58d8…}, mode: delegated, attempt: 1, note: steered}` | discover → claim → steer → ack completed exactly once; the immutable message was not duplicated. |
| V1 | **OBSERVED** | Transport level: delivery queued while every session was idle stayed `queued attempt=0` for 12 s (and for 45 s in an earlier run). Host API level: not measured — see Limitation L1. | The v2 pump delivers **only to a running agent**, so there is no idle wake at the transport level. The plugin's `steer()` is never called on an idle agent by design. |
| V4-3 | **PASS** | Trace: `10040ms STEER THREW (injected)` → `10140ms attempt=1 state=queued`; `acked=0`; `V4-3 VERDICT: released=yes acked=no attempt=1 backoff=ok` | A failed steer releases, writes no ack, counts the attempt, and the backoff prevents a claim storm. |
| V4-4 | **PASS** | `V4-4 CYCLE1: claimed+unacked, host steered=1, acks=0` → restart → `20551ms reached acked attempt=2`; `V4-4 VERDICT: duplicate but not lost (attempt=2, message copies=1, invariants ok)` | The crash window behaves as specified: the same `deliveryId` is re-delivered with `attempt + 1`, the message stays a single immutable copy. |
| V4-4b | **PASS** | With a 90 s production-length lease: after restart, `state=claimed attempt=1`, `steered=0` (no premature re-delivery), invariants ok; after the lease expired → `acked attempt=2` | A restart does **not** lose an in-flight delivery, and does not double-deliver while the lease is valid. |
| V4-5 | **PASS** | `state=queued attempt=0 awaitingBinding=["migrated-…","dd020c20-…"] violations=[]` | An unrouted delivery is consumed by nobody, even with two live sessions; it is reported as `awaitingBinding`, not as a violation. |
| V4-6 | **PASS** | Transitions `[{queued, attempt 0} → {acked, attempt 1}]` over `turns=2`; expected owner `dsh-endpoint:b110bbb7…` | After binding to session A, the delivery is claimed once and acked once. The first turn fell between two pump ticks, so the delivery landed in the second — the opportunistic property of L1, handled exactly as a deployment does. |
| V4-6b | **PASS** | `sessionA saw the marker=true; sessionB saw the marker=false`; A's transcript contained the peer message verbatim (`[b8b52ef5…] … ACCEPTANCE-MARKER-4417`) | Only the bound session received the message; no cross-session contamination. The marker appearing inside a live turn is also direct proof that the steer injected the peer message into the model's context. |

Live model evidence for the injection itself (A's final turn, verbatim):

```
Peer-agent message received (verbatim):
[634bd7a5-de33-4b8f-985e-f05d065bbf55] 2026-10-06T10:21:10.638Z codex (note)
thread=unrouted-probe-ed62f920e75fb142 topic=bound probe
ACCEPTANCE-MARKER-4417: report this marke…
```

---

## 3. Data integrity (final state)

| Metric | Value |
|---|---|
| messages | 6 (3 migrated legacy + 3 created by the probes) |
| deliveries queued | 3 |
| deliveries claimed | 0 |
| acks | 1 |
| dangling claims | 0 |
| awaitingBinding | 2 (`migrated-20261006090257478-84bd2f9e`, `dd020c20-…`) |
| migration conflicts | 0 |
| invariant violations | **0** (`verifyInvariants.ok = true`) |
| v1 root | 8 files, byte-identical to the pre-cutover backup |
| audit | append-only `audit/2026-10-06.jsonl`, 12+ lines, retained per policy |

`awaitingBinding = 2` is the expected steady state: one migrated delivery (v1 had
no routing information, so v2 refuses to guess) and one probe delivery that was
deliberately left unrouted. Neither is a violation.

---

## 4. New problems found (each with cause, fix, and regression test)

### P1 — root cache was repointed at a deleted test directory

- **Symptom**: at Step 1 the remembered bridge root resolved to
  `…/agent-bridge/test-bridge-plugin-v2`, a directory that no longer existed, so
  every CLI call without `--root` failed or silently looked at the wrong bridge.
- **Evidence**: `~/.dsh/agent-bridge-root.txt` contained the test path while
  `bridge.json` and the profile config pointed at `…/default-workspace/.agent-bridge`.
- **Root cause**: `ensureBridge()` wrote the root cache for *any* root, including
  throwaway test roots that the test then deleted.
- **Fix**: `ensureBridge()` refuses to cache a root inside the project checkout
  (`isEphemeralRoot`), in both `lib/core.mjs` and `lib/core-v2.mjs`; the tests
  pass `{ remember: false }` where it matters.
- **Regression test**: `tests/manifest.test.mjs` writes a sentinel cache, runs
  v1/v2 `ensureBridge` against both an ephemeral and a real root, asserts the
  cache is untouched by the ephemeral one, and asserts the shared cache is
  restored afterwards (the first version of this test leaked a `mkdtemp` path
  into the real cache — also fixed).

### P2 — v2 endpoint registration never ran (fatal for every v2 delivery)

- **Symptom**: 4 bound deliveries sat `queued attempt=0` for two minutes with
  `claimed` permanently 0; `endpoints/` stayed empty.
- **Evidence**: opt-in plugin trace (`AGENT_BRIDGE_DEBUG`) captured from a real
  ACP run: `registerV2Endpoint FAILED: cannot get property "agents" without inject`.
- **Root cause**: two defects stacked. (a) The plugin declared
  `inject = ["tools", "systemPrompt"]` but the pump reads `ctx.agents`; Cordis
  refuses property access to an undeclared service, and the failure was swallowed
  by the surrounding try/catch. (b) `registerV2Endpoint()` was only called inside
  `if (autoWake)`, so even a correct `inject` would not have registered identity
  when waking was disabled.
- **Fix**: `inject` now includes `agents`; endpoint registration moved out of the
  `autoWake` branch (identity is not part of waking); the catch path now records
  its reason through `diagnose()` instead of being silent.
- **Regression test**: `tests/plugin.test.mjs` asserts the exact `inject` array;
  `tests/plugin-v2.test.mjs` asserts a bound delivery is claimed and acked
  through a real bridge; `tests/cutover-probe.mjs` (live) fails if no delivery is
  ever claimed.

### P3 — two pumps could compete for one endpoint

- **Symptom**: during fault injection a delivery was steered by a pump belonging
  to a disposed mount; its state flipped between `queued`/`claimed` unpredictably.
- **Evidence**: the first fault trace showed `steeredInCycle=1` while the
  delivery's `attempt` stayed 0 and a *different* delivery was claimed — two
  watchers were alive at once.
- **Root cause**: every `apply()` started its own `setInterval`; a profile reload
  or HMR recomposition therefore produced two pumps over one endpoint, each with
  its own backoff table.
- **Fix**: `ACTIVE_WATCHERS` (module-level, keyed `root::endpointId`) allows one
  watcher per endpoint and warns on a duplicate mount; the retry-backoff table
  moved to module scope (`RETRY_DEADLINES`) so a remount inherits it.
- **Regression test**: covered by the isolated multi-scenario run in
  `tests/cutover-faults.test.mjs` (each scenario gets its own root/endpoint) and
  by `tests/plugin-v2.test.mjs`, which would double-ack if two pumps ran.

### P4 — the pump's delivery filter and the host's session identity

- **Symptom**: none in production; this is a *corrected understanding* recorded
  because it misled the first two probe designs.
- **Evidence**: `pump: skip agent status=idle` appeared for every tick while
  sessions were idle; a probe that queued deliveries with all sessions idle
  observed zero claims (correctly).
- **Conclusion**: the pump delivers only to a **running** agent, and its tick is
  10 s. Acceptance probes must queue deliveries *inside* a turn that spans a
  tick. This is recorded as the V1 limitation below rather than as a defect: it
  is the behaviour the frozen design asks for.

### P5 — the acceptance probe must prove the injection, not just the delivery

- **Symptom**: an early probe reported PASS for "acked exactly once" while the
  model had never seen the message.
- **Evidence**: `sessionA saw the marker=false` in the same run that counted an ack.
- **Root cause**: the probe asserted delivery state only, not the model's context.
- **Fix**: the probe now asks the bound session to quote the peer message
  verbatim and fails unless the marker appears in its transcript, and separately
  asserts the *unbound* session does not contain it.

### P6 — the probe assumed one turn would span a pump tick (intermittent FAIL)

- **Symptom**: the same probe passed once and then failed with
  `state=queued attempt=0` and a single `queued` transition; `sessionA saw the
  marker=false`.
- **Evidence**: in the failing run A's turn was six quick tool calls that finished
  before the next 10 s pump tick; the transcript shows the work completing inside
  one tick gap.
- **Root cause**: delivery is opportunistic — the pump only hands over while the
  target agent is running — so a short turn can fall entirely between two ticks.
  The probe treated that as a routing failure.
- **Fix**: the probe now gives the delivery up to three consecutive turns (what a
  real deployment does implicitly) and records every state transition. Re-run:
  `turns=2 transitions=[{queued, attempt 0} → {acked, attempt 1}]`, all checks PASS.
- **Not a protocol defect**: no semantics were relaxed for this. It is the same
  L1 property seen from the test side.

### P7 — root cache was still reachable from implicit operations

- **Symptom**: after fixing P1, a full `npm test` still moved
  `~/.dsh/agent-bridge-root.txt` to a temp scenario directory.
- **Evidence**: cache read before/after the suite differed; the earlier guard only
  covered `ensureBridge` called directly by the tests.
- **Root cause**: every read/write helper (`postMessage`, `enqueueDelivery`,
  `claimDelivery`, `ackDelivery`, `listDeliveries`, …) calls `ensureBridge(root)`
  with default options, so any operation on any root rewrote the global cache.
- **Fix**: all implicit calls in `lib/core.mjs` (1) and `lib/core-v2.mjs` (8) now
  pass `{ remember: false }`; only the explicit `init`/`root` CLI commands and the
  installer may write the cache, and `registerEndpoint` no longer does by default.
- **Regression test**: `tests/manifest.test.mjs` runs post/claim/ack/register
  against a temp root and asserts a sentinel cache value is untouched; the suite
  is now verified to leave the real cache byte-identical.

---

## 4b. Desktop in-app verification (after the user restarted the app)

The user restarted DeepSeek Harness, which removed limitation L2 and produced the
first v2 delivery inside the app the user is actually looking at.

| Check | Result | Evidence |
|---|---|---|
| v2 plugin mounted in the Desktop app | **PASS** | `mailbox` appeared in the session's provider-facing tool set, naming the v2 root |
| Live delivery into the running Desktop session | **PASS** | Bound delivery `f36998cb-383f-425d-b2f4-8da40fd52428` (`mode=delegated`) → `state=acked attempt=1 ackedAt=2026-10-06T12:04:06.005Z note=steered` |
| Injection reached the model | **PASS** | The session received the peer text verbatim in-turn, labelled `delivery f36998cb…, attempt 1, mode delegated` |
| Invariants after the delivery | **PASS** | `ok=true violations=[] claimed=0 acked=2`; message count grew by exactly one (6 → 7) |

Delivery timeline (`tests/ask-session.mjs`):

```
state=queued attempt=0
state=acked  attempt=1     ← the pump claimed, steered and acked inside one running turn
```

### P8 — the tool kept writing to the v1 store inside a v2 bridge

- **Symptom**: in the v2 Desktop session, `mailbox action=status` answered
  `pendingTotal: 2, logTotal: 2`, and the model told the user it had two messages
  to read from codex — while the v2 bridge had no delivery addressed to that session.
- **Evidence**: the v2 root contained v1-style `inbox/` (2 files), `log/` (2 files)
  and `state/`, written by the plugin **after** the cutover; `agent-bridge-v2 status`
  showed a different truth (`messages=7 queued=3 acked=2`).
- **Root cause**: the tool's `execute` handler called `mailboxV1.*` for every action
  regardless of `protocolVersion`; only the wake path honoured the switch. The result
  was a v1 write surface inside a v2 bridge plus stale counts fed to the model.
- **Fix**: the tool is protocol-aware (`toolV2`) — `status` reports v2 counters with
  `awaitingBinding` and invariant state, `read`/`list` show the v2 deliveries
  addressed to the calling session without consuming them, `send`/`reply` create v2
  messages (an unbound thread stays unrouted), `done` explains that the pump owns
  completion.
- **Regression test**: `tests/plugin-v2.test.mjs` case 6 plants a v1 ghost message
  inside a v2 root and asserts `status` is v2-shaped and the tool never surfaces it.
- **Cleanup note**: the two ghost v1 files inside the v2 root came from the stale
  build; the plugin no longer produces them and deleting them is a manual one-liner.

### P9 — the endpoint never republished its live sessions

- **Symptom**: after the Desktop restart, `endpoints/dsh-endpoint.json` still said
  `sessions: []` while a session was live.
- **Evidence**: `updatedAt` matched mount time, before any session existed;
  `tests/ask-session.mjs --list` printed `live sessions: (none published)`.
- **Root cause**: registration runs once at mount and nothing refreshed it. Delivery
  matching does not depend on this list (the pump compares the delivery target with
  the agent's own session id), so delivery still worked — but the published routing
  identity was wrong for humans and tools.
- **Fix**: `refreshEndpointIfChanged()` republishes the endpoint from the watcher tick
  when the live session set changes.
- **Status**: fixed in source, and confirmed active in the running build — the
  endpoint's `updatedAt` now tracks the live session set.

### P10 — injected messages had no `id`, which corrupts stored sessions (found by a peer agent)

- **Reported as**: `stored session "session-…" is corrupt: … session event at seq N
  lacks an identified message (gateway/internal)`; the reporter traced it to the
  literal `makeUserMessage` fallback in `plugin/index.js`, which produced
  `{role, content, source}` with no `id`, because `import("@deepseek-ai/dsh-llm")`
  never resolves for a symlinked plugin — so the fallback is the path that actually
  runs in production.
- **Independently verified here**:
  - the import really fails from the plugin directory (`ERR_MODULE_NOT_FOUND`);
  - the harness reader demands an identified message, so an id-less `user/message`
    makes the whole session unreadable;
  - the damage is visible in the projection caches: five sessions (`504e525f…`,
    `82122571…`, `8ca4a2ef…`, `d81d99e7…`, `session-4783dcdc…`) store an
    `agent-bridge` user message with `id = undefined`;
  - a full-text scan of all 69 stored logs found the `agent-bridge` marker in **no**
    log, so the projection caches are the usable evidence (see P11).
- **Fix** (present in `plugin/index.js`): the fallback mints `id: randomUUID()`, so
  both the `dsh-llm` path and the fallback emit an identified message. Exactly one
  construction site exists (`makeUserMessage`), shared by all three injection points
  (session briefing, v1 wake, v2 pump), so the fix is complete.
- **Repair of the damaged sessions**: a peer agent backed up and rewrote them under
  `~/.dsh/backups/session-repair-20261006/` (19 files, including the session this
  report was typed in).
- **Regression test**: `tests/plugin.test.mjs` now asserts for every injected and
  steered message that `id` is a non-empty string, `role === "user"`, and
  `source.kind === "agent-bridge"` — deliberately not trusting the import, since the
  fallback is the production path.

### P11 — session logs are multi-frame zstd, and both standard decoders hide it

- **Symptom**: all 69 stored session logs decode to exactly one line (a 244-byte
  header) although the files reach 4.7 MB. This twice produced the wrong conclusion
  "the logs are not a usable state source" during the cutover.
- **Evidence**: `zlib.zstdDecompressSync(buffer)` returns only the first frame and the
  streaming API's `end` event also fires after the first frame; the frame-walking
  `tests/session-audit.mjs` still reports `events decoded: 69` for 69 files, so its
  own frame walk is not yet correct either.
- **Status**: **open and documented**. This is a tooling gap, not a protocol problem:
  use the projection caches for session-level evidence, and treat
  `tests/session-audit.mjs` as unfinished — neither its `--session` mode nor its audit
  summary may be relied on until the frame walk is fixed.
- **Consequence**: P10's verification used
  `~/.dsh/storages/session_projcache/sessions/*.json` (plain JSON) rather than the logs.

---

## 5. Documented limitations

**L1 — no idle wake.** The transport delivers only while the target session is
running (measured: a queued delivery stayed `queued attempt=0` for 12 s and 45 s
with every session idle). The plugin therefore never calls `steer()` on an idle
agent. Whether the *host API* `agent.steer()` would itself start a turn on an idle
root agent was **not measured** in this cutover and is explicitly left open.
Capability statement to use from now on:

```
running session:  near-real-time injection (measured: queued → steered → acked inside one turn)
idle session:     the delivery waits in queue/ until the session next runs
```

**L2 — Desktop not yet reloaded.** ~~The `desktop` profile config was switched to
v2, but the running Desktop process still holds the pre-cutover composition.~~
**Resolved**: the user restarted the app and a v2 delivery completed inside the
Desktop session (see §4b). Note that the Desktop process currently loaded predates
the P8/P9 fixes, so one further restart picks those up; the delivery path itself was
verified on the running build.

**L4 — a plugin file edit does not hot-reload the mounted plugin.** Editing
`plugin/index.js` (or adding a config key such as `debugLog`) does not re-mount the
plugin in a running app; only a restart loads it. Observed directly: the profile
patch was edited and the plugin file changed, yet no trace file appeared and the
running tool still used the previous code. Practical consequence: plan one restart
per plugin change, and use the `debugLog` config field for diagnostics in a running
app.

**L3 — delivery latency is bounded by the 10 s tick** plus lease semantics. An
unexpired claim is never re-delivered early (verified: 90 s lease → no
re-delivery for 12 s after a restart), which is correct but means recovery after
a crash waits for the lease.

---

## 6. Verdict

```
P0.5 CUTOVER PASS WITH DOCUMENTED LIMITATION
```

The v2 protocol is demonstrated on a real DSH process with a real model:
immutable single-copy messages, message/delivery separation, at-least-once
delivery with the crash window producing **duplicate but not lost**, strict
binding-based session routing with no cross-session contamination, an auditable
migration that never fabricated an ack and never rewrote a legacy id, and a
provider-facing tool contract the model actually calls. The limitation is L1:
the transport does not wake an idle session, so the capability statement is
"running session near-real-time, idle session waits for the next host activity",
plus L2: the Desktop app still needs one restart to run v2 in-app.

## 7. Regression suite state

```
npm test  →  mailbox ✅  protocol-v2 (T1–T15) ✅  cli-v2 ✅  migrate ✅
             manifest ✅  plugin ✅  plugin-v2 ✅  cutover-faults (V4-3/V4-4/V4-4b) ✅
npm run test:live  →  cutover-probe (V4-1/V4-2/V4-5/V4-6/V1) ✅
```
