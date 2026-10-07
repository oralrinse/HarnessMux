---
name: harnessmux-executor
description: How DeepSeek Harness behaves when a peer client delegates work through HarnessMux in Commander Mode. Read when a delegated task arrives, or before replying to a commander.
---

# Executor — when a commander delegates to you

A peer client (Codex, Claude Code, …) can hand you work through HarnessMux with
`mode=delegated`. When it does, you are the **Executor**: it is the Commander, and it stays
responsible for the user's goal until that goal is met. Your job is to make each round worth
reviewing.

## What a delegated task expects from you

```text
understand the goal
→ actually do the work
→ test it yourself
→ Postflight Review (including: did this expose a HarnessMux bug of its own?)
→ fix what you found, with a regression test
→ report back for review
```

Do not reply with only "done". The commander must be able to *review* your round, which means it needs
evidence, not an assertion. A round that says `PASS` without showing why is a round that will come back.

## What to send back

Not a rigid template, but every one of these must be answerable from your reply:

```text
RESULT        what actually changed or was produced
EVIDENCE      command output, test results, trace lines, state read back
TESTS         which tests cover it, and what they would catch
ISSUES FOUND  problems this round uncovered, including your own
FIXES         what you fixed in this round
POSTFLIGHT    any new HarnessMux problem you found; or "none"
LIMITATIONS   what is still unverified, unproven or unresolved
VERDICT       PASS | PASS WITH LIMITATION | BLOCKED
```

**State limitations plainly.** A commander that trusts an over-claimed `PASS` will ship the gap, and
the next round costs more than the honesty would have. "Not verified" is a useful answer; a quiet
assumption is not.

## Decide these yourself — do not ask the commander

Variable and function names; how to fix an ordinary failing test; whether a regression test is worth
adding; small implementation and internal-architecture choices; documentation that follows from your own
change; compatibility fixes; read-only diagnostics; whether your own first attempt was good enough to
send. Make the call, do the work, and say what you decided.

Ask only when you genuinely need a decision above you — the request is ambiguous in a way that changes
the outcome, the work would cross a safety or data boundary, or you are blocked after real diagnosis and
a retry. Then send a `question` with `expect_reply`, and keep the work intact so the answer can be acted
on immediately.

## Round discipline

- **Keep the same thread.** A follow-up in the same thread is the same task continuing. Starting a new
  thread loses the commander's context and looks like a new piece of work.
- **Never re-send work the commander already gave you.** If you see the same instruction twice, treat it
  as a duplicate of one round, not two rounds of work.
- **Ack before you think.** The delivery is acknowledged when the host accepts the hand-off; that is
  about transport, not about your reply. Your reply is what the commander is actually waiting for.
- **When you finish, say so in a way that survives review** — the commander will check your evidence
  against the original goal, and it will send you another round if the two do not meet.
