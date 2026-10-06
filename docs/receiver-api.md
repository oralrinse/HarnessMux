# Receiver API (specification, not yet implemented in code)

A **Receiver** is whatever turns a protocol-v2 delivery into something a host agent
can actually see. DeepSeek Harness has one; this document defines the interface the
next one must satisfy so that the second implementation validates the shape instead
of inheriting guesses.

Status: **specification only.** The DSH receiver is *not* refactored to implement this
interface (see [Why there is no refactor yet](#why-there-is-no-refactor-yet)).

```
Protocol v2
    │
Receiver interface
    │
    ├─ receiver-dsh      ← implemented and validated on a real machine
    ├─ receiver-codex    ← future
    ├─ receiver-claude   ← future
    └─ receiver-pull     ← future (generic polling consumer)
```

## 1. What a receiver owns

A receiver decides **only** the platform-specific questions:

| Question | Answer lives in |
|---|---|
| How are endpoints discovered and registered? | the receiver |
| How are sessions discovered, and which are eligible? | the receiver |
| How is a message injected into a session? | the receiver |
| How is polling/waking triggered? | the receiver |
| How is the situation shown to a human? | the receiver (or its plugin) |

A receiver must **never** redefine:

- what `ack` means (**the host accepted this hand-off**, not "the work is done");
- what a delivery is, or the message/delivery split;
- lease semantics, binding semantics, or the at-least-once guarantee;
- `advisory` / `delegated` trust.

Those are platform-independent transport semantics owned by the protocol
([protocol.md](protocol.md), [DESIGN.md §0.3](../DESIGN.md)).

## 2. Capability model

Capabilities differ between hosts, and the protocol already tolerates that: a
capability that does not exist simply means deliveries wait. A receiver advertises
them; nothing may assume them.

```jsonc
{
  "receiver": "dsh",
  "version": "1",
  "capabilities": {
    "pushDelivery": true,          // can inject without waiting for a host-side poll
    "pullDelivery": true,          // can poll the queue on its own schedule
    "liveSessionInjection": true,  // can reach a session a human is currently using
    "idleWake": false,             // can start a turn in a session that is idle
    "sessionRouting": true,        // can target one session rather than the process
    "sessionDiscovery": true,      // can enumerate eligible sessions
    "bindingEnforcement": true,    // respects bindings and refuses unbound work
    "deliveryReceipt": true        // reports acceptance back as an ack
  }
}
```

The values above are the **measured** capabilities of `receiver-dsh` after the P0.5
cutover, including `idleWake: false` — a boundary, not a bug to paper over.

A protocol client must therefore never require `idleWake`, and must present the
capability set (or its consequences) rather than assuming near-real-time delivery.

## 3. Interface

Names are provisional; the semantics are not.

```js
/**
 * A receiver adapter. Every method is optional except `capabilities` and `deliver`.
 */
export const receiver = {
  /** @returns {object} the advertised capability set (§2). */
  capabilities,

  /**
   * Register this host as an endpoint so deliveries can target it.
   * @param {object} context - `{ root, actor, endpointId }`.
   * @returns {object} the registered endpoint record.
   */
  register(context),

  /**
   * Enumerate sessions that could receive work (for binding UX; never for guessing).
   * @param {object} context - as above.
   * @returns {Array<{ sessionId: string, label?: string, live: boolean }>}
   */
  listSessions(context),

  /**
   * Attempt to hand a delivery's message to a session.
   * Return `accepted: false` (with a reason) instead of throwing when the host
   * merely cannot take it right now — the protocol treats that as "release and
   * retry", not as a failure of the bridge.
   *
   * @param {object} input - `{ root, delivery, message, sessionId, mode, owner }`.
   * @returns {Promise<{ accepted: boolean, reason?: string }>}
   */
  deliver(input),

  /**
   * Called when reconciliation moved a delivery back to the queue.
   * Optional: hosts without leases can ignore it.
   * @param {object} input - `{ root, delivery, attempts }`.
   */
  onRecover(input) {},

  /**
   * Optional human-facing summary (what is waiting, what failed, why).
   * @returns {string} markdown.
   */
  describe(context) {
    return "";
  }
};
```

### Delivery outcome contract

| Outcome | Receiver returns | Protocol effect |
|---|---|---|
| Host took the message | `{ accepted: true }` | the receiver acks the delivery |
| Host cannot take it now (idle, busy, no session) | `{ accepted: false, reason }` | release; retry after backoff |
| Receiver is broken | throw | release; the failure is logged and retried |

A receiver that acked before a successful hand-off would reintroduce the v1 failure
mode (a message marked consumed that nobody ever saw). That ordering is not
negotiable.

## 4. Reference implementation: `receiver-dsh`

| Capability | Value | Evidence |
|---|---|---|
| `pushDelivery` | true | the plugin's pump claims and steers without a host-side request |
| `pullDelivery` | true | the pump runs on a 10 s tick and reconciles on each pass |
| `liveSessionInjection` | true | a delivery landed inside a running Desktop session (V4-2/V4-6) |
| `idleWake` | **false** | a queued delivery stayed queued for 45 s with every session idle |
| `sessionRouting` | true | the bound session received it; a second live session did not |
| `sessionDiscovery` | true | the endpoint publishes its live session set |
| `bindingEnforcement` | true | unrouted deliveries are never claimed (`awaitingBinding`) |
| `deliveryReceipt` | true | `acks/` records `{deliveryId, messageId, target, mode, attempt, note: "steered"}` |

Mapping to the actual code, so the interface stays honest about what already exists:

| Interface method | DSH implementation today |
|---|---|
| `capabilities` | implicit in the plugin's behaviour (documented above; not yet an object) |
| `register` | `registerV2Endpoint()` + `refreshEndpointIfChanged()` |
| `listSessions` | `ctx.agents.roots()` mapping to `session.header.id` |
| `deliver` | the pump's `claim → load → steer → ack`, with release on failure |
| `onRecover` | `reconcile()` result + the release path and its backoff |
| `describe` | the `mailbox action=status` view |

## 5. Why there is no refactor yet

> Define the interface now; implement it when a second receiver exists.

The DSH receiver passed a real cutover with a real model: provider-facing tool schema,
endpoint registration, session binding, multi-session isolation, claim→steer→ack,
lease recovery, watcher singleton, and crash recovery. Rewriting that shape around an
interface with exactly one implementation would replace verified behaviour with an
unverified guess, and the guess would be the thing that shipped.

The work order for the second receiver (P6.1) is therefore: implement it against this
document, note every place the interface did not fit, and only then adjust the
interface — and `receiver-dsh` — together.
