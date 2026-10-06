# The agent-bridge mailbox protocol

> **v2 设计已冻结（见 DESIGN.md §0.3），本节描述的是 v1 原型。**
> v1 的核心缺陷：`read` 是 destructive move（把"已移动"当成"已消费"），且用单调整的
> cursor 承担正确性 —— 二者在崩溃与并发下都不成立。v2 用 `messages`/`queue`/`claims`/`acks`
> 四层把「消息」与「投递」分开，语义为 **at-least-once**。迁移工具 `agent-bridge migrate` 待实现。

## v1（当前实现，将被 v2 取代）

The protocol *is* the directory layout. Any program that can read and write
JSON files can join the bridge; the bundled CLI and the DSH plugin are the
first two implementations.

## Layout

```
<bridge-root>/
  bridge.json                 manifest: version, actors, creation time
  inbox/<message-id>.json     pending messages
  read/<message-id>.json      consumed messages (same content, moved)
  state/<actor>-cursor.json   per-actor read watermark
  log/<message-id>.json       audit copy of every message ever posted
```

`<bridge-root>` is any directory both agents can reach. Nothing else in the
bridge is required, and no daemon or network port is involved.

## Message schema

```jsonc
{
  "id": "20261006084139259-a6e96890",   // lexicographic == chronological
  "createdAt": "2026-10-06T08:41:39.260Z",
  "from": "codex",                       // sender actor
  "to": "dsh",                           // recipient actor
  "topic": "ship the bridge",            // human-readable thread topic
  "threadId": "ship-the-bridge-fa332835",// stable id shared by all replies
  "kind": "instruction",                 // instruction | question | answer | report | note
  "expectReply": true,                   // sender is waiting for an answer
  "replyTo": "20261006084139259-a6e96890", // present on replies
  "refs": ["src/bridge.ts"],             // optional files/URLs the message refers to
  "body": "markdown body"
}
```

Only `id`, `createdAt`, `from`, `to`, `topic`, `threadId`, `kind`, and `body`
are guaranteed. Consumers must ignore unknown fields — that is how the protocol
stays forward compatible.

## Rules

1. **Atomic writes.** Write the JSON to a temp file in the *same* directory and
   rename it into place. A rename inside one directory is atomic, so a reader
   never sees a half-written message. The bundled core does this for you.
2. **Addressing is by field, not by directory.** `read --actor dsh` selects every
   pending message whose `to` is `dsh`. Senders never need to know the layout.
3. **Consumption is a move.** Reading (without `--peek`) moves the file from
   `inbox/` to `read/`. A crash between read and move at worst re-delivers a
   message; it never loses one.
4. **Watermarks move forward only.** `state/<actor>-cursor.json` records the last
   consumed message id. `--from-cursor` skips anything at or below it. Because
   ids sort lexicographically by time, the comparison is a plain string compare.
5. **Replies stay in the thread.** A reply copies the parent's `threadId` and
   `topic`, swaps `from`/`to`, and sets `replyTo`. Use `list --thread <id>` to
   read a whole conversation.
6. **The log is append-only.** `log/` keeps every message regardless of
   consumption, so a human can audit what the two agents told each other.
7. **README-style discovery.** Every agent should be told the bridge root at
   session start and instructed to poll it — that is what the DSH plugin's
   briefing and Codex's `AGENTS.md` are for.

## Concurrency

Two writers can post at the same instant: message ids embed a timestamp plus a
random suffix, and each write targets its own file, so nothing collides. Two
readers of the same actor can race on the `inbox → read` move; the loser sees
the file already gone and treats the message as delivered. Run one reader per
actor to keep the watermark honest.

## Interaction with agent frameworks

Agent frameworks differ in what they allow, and the protocol is deliberately
blind to that:

| Capability | Consequence |
|---|---|
| A framework can inject a turn into a *live* session | The agent can be woken mid-work (the DSH plugin does this with `agent.steer`) |
| A framework can only act on its next turn | The message waits in `inbox/`; the agent sees it at its next poll |
| A framework has no background loop | A human, a hook, or a scheduled job triggers the poll |

Nothing in the protocol requires push semantics, which is why it works for
agents that only ever run when a human presses enter.
