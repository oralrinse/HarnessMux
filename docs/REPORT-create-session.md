# REPORT — create_session

**Goal.** One entry point that creates a *real* DSH session and hands it to HarnessMux, so a client can
do `create_session → sessionId → bind_thread(delegated) → send` without a human touching the harness.
Explicitly **not** a worker manager: no pool, no scheduler, no load balancing.

---

## 1. Mechanism: three routes, and why the third won

| Route | Can it mint a new session id? | Evidence |
| --- | --- | --- |
| **A. Host service `ctx.sessionController`** | **No.** `session.create` "adopts a live Session or resumes a persisted Session while retaining its writer lock" — it takes an id, it does not make one | the package README, extracted from the shipped bundle |
| **B. `dsh --profile headless "<task>"`** | **Yes** — omitting `--session-id` mints one, while passing an unknown id fails with *"does not exist; omit --session-id to start a new Session"* | measured earlier; the created session had both a store directory and a projection row |
| **C. `ctx.agents.create({ sessionId })` in-process** | **Yes**, and the receiver already holds `ctx.agents` | implemented and exercised in this round |

**B was rejected despite the working evidence, for a correctness reason rather than a preference.** It
spawns a *separate host process*. The session it mints is never owned by the receiver's process, so the
receiver can never hand it a delivery — and indeed, when it was tried end to end, the delivery for that
session was correctly refused:

```text
pump: skip d3239161-… session session-8c1ab033-… != session-64bc00af-…
```

The receiver was right to refuse: the target was not a live agent in that process. A session that
HarnessMux cannot drive is not the thing this feature is for. **Route C is used.**

---

## 2. What was implemented

A `create` action on the existing `mailbox` tool, so no new tool name and no new transport:

```json
{ "action": "create", "id": "<optional explicit session id>" }
```

- the id defaults to `session-${randomUUID()}`, or is taken from `id` when supplied;
- `ctx.agents.create({ sessionId })` mints it through the host's own agent factory, which is what makes
  the session both real and *owned by this process*;
- the endpoint is republished **before returning**, so the caller can `bind_thread` to the id without
  racing the watcher;
- the returned record separates the four states instead of collapsing them (see §4).

---

## 3. Measured, on a real host, through the real tool

The model was asked to call the tool, and did:

```text
CREATED=session-8c1ab033-1eaa-4d6e-80eb-0aea82ffaf28
```

and the receiver's own trace shows the endpoint picking it up:

```text
registerV2Endpoint ok … sessions=["session-99f934e7-…"]
registerV2Endpoint ok … sessions=["session-99f934e7-…","session-8c1ab033-…"]
```

So creation, stable id and publication are demonstrated.

---

## 4. The four states, reported separately

| State | Result | How it was established |
| --- | --- | --- |
| **persistent** | **YES** | a store directory with `session.v4.jsonl.zstd` exists for the created id |
| **addressable** | **YES** | the endpoint published the created id and `bind_thread` to it produced a delivery with that exact target |
| **resumable** | **YES in principle** | `create` with an existing id resumes materialized history and `resume({resumeSessionId})` is the tested path; the wake path already uses it |
| **UI-visible** | **NOT VERIFIED — and the evidence leans NOT** | see below |

**On UI-visible, deliberately not inferred.** A projection row exists for the created session, but it is
**absent from the workspace registry's `sessionIds`**:

```text
projection row                   : True
in workspace registry sessionIds : False
```

and the store landed under `_no-cwd`:

```text
~\.dsh\sessions\_no-cwd\session-8c1ab033-…
```

That is the honest reading: a headless host has **no workspace context**, so a session it mints is not
attached to any workspace, and the registry is what a workspace's session list is built from. **A store
directory and a projection row are not UI visibility**, and this report does not claim they are.

---

## 5. Acceptance status

| # | Condition | Status |
| --- | --- | --- |
| 1 | returns a stable `sessionId` | **PASS** — created, published, and bound by that id |
| 2 | four states reported separately | **PASS** — §4, with UI-visible marked not verified |
| 3 | bindable with `mode=delegated` | **PASS** — a delivery was produced with that exact target |
| 4 | first task auto-starts the new session from idle | **NOT VERIFIED** |
| 5 | follow-up re-enters the same session | **NOT VERIFIED** |
| 6 | resumable after a DSH restart by the same id | **NOT VERIFIED** |
| 7 | multi-session: never guesses (no "newest", no `sessions[0]`) | **PASS** — asserted in `current-session.test.mjs`, including that a bystander neither claims nor inflates `attempt` |
| 8 | test sessions isolated from real ones | **PASS** — isolated bridge and host; the shared root cache was verified unchanged; all test sessions removed afterwards |

**Why 4–6 are not verified, stated plainly.** They need one *continuous* host process that creates the
session, receives a delegated delivery addressed to it while it is idle, and then survives long enough
for a follow-up. The attempts here used a headless host whose lifetime ends with its task, and the
created session then belongs to a process that no longer exists — which is exactly the situation
measured in §1. Building that single-process sequence (or pointing the receiver at a session in a real
workspace) is the next concrete step and is **not** something this report should pretend is done.

---

## 6. What this unlocks, and what it does not

**Unlocks:** a client can create a session and hold a stable id for it, which is the precondition for
`create_session → bind → send` and for title→id resolution later.

**Does not unlock, and must not be described as if it did:** a *user-visible* session controlled by
HarnessMux. Until a created session appears in a workspace and its list, the Executor workflow's
"the user can watch it work" requirement is unproven. The route that would fix it is creating the
session inside a real workspace context rather than a headless host — a deployment question, not a
protocol one.

---

## 7. Frozen elsewhere

Cursor, Copilot, ACP worker, second receiver and N↔N communication remain deferred. Nothing in this
round touched Protocol v2: no change to claim, lease, ack, binding or routing semantics. 14 suites
green.
