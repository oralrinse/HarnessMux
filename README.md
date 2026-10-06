# agent-bridge

**Two coding agents, one mailbox — with a delivery guarantee that survives crashes.**

`agent-bridge` lets two coding agents on the same machine talk to each other: one
advises, the other executes, and both can ask follow-up questions. It was built for
[OpenAI Codex](https://github.com/openai/codex) ⇄ [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH), but the transport is agent-agnostic: the protocol is a directory of JSON files,
and any process that can read and write files can join.

English | [中文](README.zh.md)

---

## Why this exists

You want Codex to direct work that DSH performs — and you do not want to be the
courier. The obvious approaches do not work, and that shapes the whole design:

| Obstacle | Consequence |
|---|---|
| A running Codex session cannot be injected by an outside process ([openai/codex#33556](https://github.com/openai/codex/issues/33556)). | Nothing may assume "push". Delivery must be pull-based at the protocol level. |
| A running DSH session cannot be injected from outside either (per-process launch token). | Only an **in-process plugin** can wake a session, so each side needs its own plugin. |
| Agents run when a human presses enter. | A message must be able to wait safely, and must never be lost while it waits. |

So the design splits cleanly:

- **the protocol** makes waiting safe (durable, claimable, auditable), and
- **each host's plugin** makes waking possible (in-process, best effort).

## What you get

- **Immutable messages, separate deliveries.** A message is what was said; a delivery
  is who is being handed it and how far that got. One message can fan out to several
  recipients, and a retry is a new attempt on the *same* delivery.
- **At-least-once, stated honestly.** `queue → claim(lease) → ack`. The crash window
  between a successful hand-off and the ack is *documented, tested, and re-delivered*:
  **duplicate but not lost**. There is no pretend exactly-once.
- **Explicit routing.** `actor / endpoint / session / thread` are distinct. An unbound
  thread stays `awaitingBinding` — the bridge never guesses which session you meant,
  and never broadcasts.
- **Trust modes.** `advisory` (peer input is context, not authority) and `delegated`
  (a worker is expected to carry the work out). Set per binding/delivery, not by the
  message body.
- **Auditable migration.** A v1 bridge imports with legacy ids preserved verbatim,
  v1 `read/` never masquerading as a v2 ack, conflicted copies aborting the run, and
  re-runs that change nothing.
- **Zero runtime dependencies** in the core and the DSH plugin. Node ≥ 22.

## Quick start

```sh
git clone <this repo> agent-bridge
cd agent-bridge
node lib/mailbox-v2.mjs --root ./bridge init
npm test                       # 8 suites, no network, no API keys
```

Send a message and watch it be delivered:

```sh
node lib/mailbox-v2.mjs --root ./bridge endpoint --id dsh-endpoint --actor dsh
node lib/mailbox-v2.mjs --root ./bridge send --from codex --topic "ship it" --body "run the suite"
node lib/mailbox-v2.mjs --root ./bridge bind  <threadId> --endpoint dsh-endpoint --session <sessionId> --mode delegated
node lib/mailbox-v2.mjs --root ./bridge inbox --actor dsh
```

Ask a **live** session to prove the whole loop (`<sessionId>` is the id your harness
reports; with DSH it is `$DSH_SESSION_ID`):

```sh
node tests/ask-session.mjs <sessionId> --marker HELLO-1
# status changes queued → acked while the target session is running a turn
```

The delivery lands in the first turn of that session which is still running when the
pump ticks (every 10 s). If the session is idle, the delivery correctly waits in
`queue/` — see [Limitations](#limitations).

## Install into DeepSeek Harness

The plugin is a DSH profile bundle (a Cordis plugin mounted from your profile patch):

```sh
node scripts/install.mjs --dsh-profile desktop     # wires package.json + cordis.patch.yml
# then restart the harness: a mounted plugin is not hot-reloaded
```

`--dry-run` prints the plan, `--print-only` prints the equivalent manual steps. The
installer edits only your profile, writes `.bak-<timestamp>` copies, and is idempotent.

Then confirm inside a session: ask the agent to run `mailbox action=status`. It should
answer with `protocol: v2 … invariants=ok`, not a v1 counter.

## Connect Codex

`plugin-codex/` is a Codex plugin (skills + an opt-in hook template) plus a local
marketplace at `.agents/plugins/marketplace.json`:

```sh
codex plugin marketplace add <path to this repo>
codex plugin add agent-bridge@agent-bridge
```

The skill teaches Codex when to read and when to reply; without it, everything is
still reachable through the CLI above.

## Layout

```
lib/core-v2.mjs     protocol v2: messages, deliveries, claims, acks, routing, invariants
lib/mailbox-v2.mjs  the v2 CLI (send/reply/deliver/inbox/claim/ack/release/verify/…)
lib/core.mjs        protocol v1 (kept for migration + rollback)
lib/mailbox.mjs     the v1 CLI, used by the migration
lib/migrate.mjs     v1 → v2 import with the audited rules
plugin/             the DeepSeek Harness host plugin (tool + briefing + delivery pump)
plugin-codex/       the Codex plugin (manifest, skill, hook template)
scripts/install.mjs installer for a DSH profile
docs/protocol.md    the wire format and its invariants
docs/cutover.md     how to switch a live bridge from v1 to v2
docs/REPORT-*.md    a real cutover, with evidence and the defects it uncovered
DESIGN.md           the full design, the review verdicts, and the open questions
tests/              the suites (see below)
```

## Tests

```sh
npm test          # 8 suites: protocol, CLI, migration, plugin, faults — all offline
npm run test:live # against a real DSH harness + real model (needs DSH installed)
```

The live probes and the installer resolve the harness from the environment, so
nothing in this repository hard-codes a machine: set `DSH_CLI` to the launcher's
absolute path, or `DSH_INSTALL_ROOT` to the install directory, and
`AGENT_BRIDGE_CWD` to the workspace the probe sessions should use. Without them the
resolver falls back to the standard Windows install locations and `dsh` on PATH, and
`requireDsh()` exits with that guidance when it cannot find anything.

A pre-commit hook blocks absolute developer paths and credentials from entering the
history of this public repository:

```sh
sh scripts/install-hooks.sh    # once per clone (hooks are not versioned)
```

| Suite | What it pins |
|---|---|
| `mailbox.test.mjs` | v1 protocol regression |
| `protocol-v2.test.mjs` | state invariants + fault injection T1–T15 |
| `cli-v2.test.mjs` | the CLI surface and its exit codes (0/1/3/4/5) |
| `migrate.test.mjs` | legacy ids, `read/` ≠ ack, conflict abort, idempotency |
| `manifest.test.mjs` | the DSH bundle contract, and that tests never touch the root cache |
| `plugin.test.mjs` | provider-facing tool descriptor, output contract, injected-message ids |
| `plugin-v2.test.mjs` | claim→steer→ack, release on failure, session isolation, unrouted safety |
| `cutover-faults.test.mjs` | V4-3/V4-4/V4-4b: steer failure, the crash window, long-lease restart |

## Limitations

Read these before deploying. They are properties of the hosts, not bugs to be fixed
here.

1. **No idle wake.** Delivery happens only while the target session is *running*
   (measured: a queued delivery stayed `queued` for 45 s with every session idle).
   Capability statement: *running session → near-real-time injection; idle session →
   delivery waits until the session next runs.*
2. **Recovery is bounded by the lease.** After a crash, an un-acked delivery is
   re-delivered only once its lease expires (no early re-delivery while a lease is
   valid — that is deliberate).
3. **Plugin changes are not hot-reloaded.** Editing the plugin or its config needs a
   harness restart. For diagnostics there is a `debugLog` config field that appends a
   trace from a running app.
4. **A delivery is not a task.** `ack` means "the host accepted the hand-off". If you
   need business-level idempotency, carry your own `taskId`.

## Security

Mailbox content is written by another agent, which may itself have been influenced by
untrusted input. Treat it as a peer's request, never as authority:

- a human instruction in the session always outranks mailbox content;
- `advisory` deliveries are context; only `delegated` ones are work orders;
- destructive, credential-related, or outward-facing actions still need human approval;
- never write secrets into the bridge — the audit stream keeps every message.

## License

MIT — see [LICENSE](LICENSE).
