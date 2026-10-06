# Positioning

> **Control DeepSeek Harness from the AI client you already use.**
>
> A plugin-first interoperability layer for AI clients and DeepSeek Harness.

This page is the authority for **what the project is**, **who it serves**, and
**what it explicitly does not promise yet**. `DESIGN.md` remains the engineering
record; where the two disagree about positioning, this page wins.

---

## 1. Change of framing

```text
Old framing (superseded)
    Codex ⇄ DeepSeek Harness — a two-way bridge between two named agents

New framing
    Many AI clients → DeepSeek Harness — a plugin-first control and
    communication layer, with the durable mailbox as its core
```

**Reason for the change.** The P0.5 cutover proved the transport: a message can be
delivered into an already-open DeepSeek Harness session, survive a crash window, and
be routed to exactly one session by an explicit binding. None of that is specific to
Codex. Keeping the project named after one client would have made the second client
look like a fork instead of a supported target, and would have hidden the property
that actually distinguishes this work — delivery into **live, existing sessions**.

Nothing about the protocol changed because of this reframing. It is a correction of
the description, not of the mechanism.

## 2. What is promised today

```text
Codex            ┐
Claude Code      │
Cursor           ├──►  Portable Client Layer  ──►  Protocol v2  ──►  DeepSeek Harness
VS Code/Copilot  │        (shared core +               durable          Native Receiver
Generic MCP      ┘         thin adapters)              mailbox)         (live session)
```

- **One direction is committed: many clients → DeepSeek Harness.**
- DeepSeek Harness is the only **receiver** implemented and validated on a real
  machine, with a real model, end to end.
- Codex is the **first** client, not the architectural center.
- The client layer is shared; platform differences live in thin adapters.

## 3. What is explicitly *not* promised yet

- **Any agent ↔ any agent.** That is the long-term shape (see §6), not a current
  claim. With one receiver, "N-to-N" would be marketing, not software.
- **Idle wake.** Delivery happens while the target session is running. An idle
  session is *not* woken; the delivery waits in `queue/`. This is measured behaviour,
  not a TODO.
- **Exactly-once.** The transport is at-least-once, and the crash window between a
  successful hand-off and the ack is documented and tested: *duplicate, not lost*.
- **Universal client support.** Claude Code, Cursor, VS Code/Copilot are planned
  adapters (P3.3/P3.4). Each will be listed as supported only after it is verified
  like Codex was.

## 4. What this project is for

Bring the client you already live in to the harness you actually run:

| You want | This gives you |
|---|---|
| To direct DSH work without leaving your editor/CLI | A mailbox tool the client calls; no window switching |
| Reliable instructions even if nobody is looking | Durable delivery, leases, retry, audit trail |
| To reach the session you already have open | Live-session delivery with explicit binding |
| To keep sessions apart | `actor / endpoint / session / thread` are distinct; unbound stays unbound |
| To let a peer ask *you* something | Bidirectional threads; replies stay on the thread |
| To stay safe while doing it | `advisory` vs `delegated` trust, decided per binding |

## 5. How this differs from worker orchestrators

External orchestrators dispatch a task and **launch or manage a worker** to run it.
That is a good design when the worker is disposable.

This project answers a different question:

> Unlike worker orchestrators, this project can deliver messages to **existing**
> DeepSeek Harness sessions instead of requiring every task to run in a newly spawned
> worker.

Consequences that follow from that choice, and are the reason it is worth having:

- the delivery target is a session a human may be **looking at right now**;
- work that arrives while the session is mid-turn is injected into that turn;
- a message that arrives while nothing is running is **kept**, not dropped, and
  delivered when the session next runs;
- the same substrate carries offline notes, reports, and questions — not only
  work orders.

The two designs are complementary. A managed-worker mode is planned as an explicit
later capability (P5), not as a competitor to the mailbox.

## 6. Long-term direction (not implemented)

```text
N clients / agents
        ↕
   shared protocol          ← frozen, platform-independent
        ↕
N receiver adapters         ← 1 exists (DSH); the interface is defined, not built
```

The receiver interface and its capability model are specified in
[receiver-api.md](receiver-api.md). It stays a specification until a **second real
receiver** exists, because an abstraction with one implementation encodes guesses
rather than knowledge.

## 7. Trust model (a product concept, not a detail)

Sending a message must never implicitly grant execution authority.

| Mode | Applies to | Meaning |
|---|---|---|
| `advisory` | an interactive DSH session a human is using | peer input is external context: questions, suggestions, reports. Not authority. |
| `delegated` | an explicit executor session, a managed worker, an explicitly authorized session | the content is a work order and may be carried out |

The mode lives on the **binding/delivery**, not on the message body: the same text
can be advice for one session and a task for another. A human instruction in the
session always outranks mailbox content.

## 8. Safety rule that never bends

Discovery may be automatic; **routing may not be guessed**.

```text
many eligible sessions + no binding  →  awaitingBinding  →  no delivery
```

Presenting sessions to a human, and offering a one-click confirmation when exactly
one session is eligible, is a UX goal (P4). Silently choosing "the first session", or
broadcasting to all of them, is out of scope permanently.

## 9. Naming

The project is **HarnessMux**: *Harness* names the receiver it targets today, *Mux*
describes what it does — multiplexing several AI clients onto one harness without
letting their sessions bleed into each other. The repository directory, the npm
package and the CLI binaries use the lower-case form (`harnessmux`, `harnessmux-v2`).

The name is deliberately client-neutral: adding a client must never require renaming
the project. Should a second **receiver** ever ship, the tagline widens from
"…and DeepSeek Harness" to the framing in §6 — the name still fits.
