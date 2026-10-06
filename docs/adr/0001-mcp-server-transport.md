# ADR 0001 — Hand-rolled MCP server instead of the official SDK

Status: **accepted** (2026-10-06) · Supersedes the earlier "use the official SDK"
position recorded in `DESIGN.md` §0.2 (Q4).

## Context

`packages/mcp/server.mjs` is the shared client-facing tool layer: every MCP-capable
client (Codex, Claude Code, Cursor, VS Code/Copilot, …) uses it, and it must expose
the protocol-v2 mailbox as tools without re-implementing any mailbox logic.

Two ways to build it:

1. the official `@modelcontextprotocol/sdk`;
2. a hand-rolled stdio JSON-RPC server.

During the P0.5 review the recommendation was (1), on the grounds that protocol
negotiation, cancellation, error codes, transports and version drift are not worth
maintaining by hand. That reasoning was sound in the abstract; the dependency facts
changed the trade.

## Decision

Hand-roll the stdio server. Zero dependencies.

## Why

| Consideration | SDK | hand-rolled |
|---|---|---|
| Install size | `@modelcontextprotocol/sdk@1.32.1` unpacks to ~4.5 MB and brings `express`, `hono`, `ajv`, `ajv-formats`, `jose`, `cors`, `raw-body`, `cross-spawn` | none |
| What we actually serve | stdio only | stdio only |
| Surface to implement | full protocol framework | `initialize`, `tools/list`, `tools/call`, `ping`, notifications — a few hundred lines |
| Repo posture | would be the project's first runtime dependency, in a core that is otherwise dependency-free | unchanged |
| Contract tests | test the SDK's server object, or drive it over a pipe | call `handle()` directly, then drive the real stdio loop over in-memory streams |

Concretely: the SDK's value is concentrated in the **HTTP** transports and the
framework plumbing around them. This layer offers neither, so we would be paying
4.5 MB and eight transitive packages for capability we do not expose.

The risk the original recommendation named — protocol drift — is real but bounded
here, because the stdio surface we implement is the oldest and most stable part of
MCP, and the contract tests pin the wire envelope (`jsonrpc`, `id`, `result` /
`error` shapes) rather than our internal objects.

## Consequences

- No dependency to audit, no version drift, and the MCP layer is testable offline.
- We own the wire details: if MCP changes the stdio framing, or if a client requires
  a capability we do not implement, we must change this file.
- **Revisit trigger**: the moment Streamable HTTP, OAuth, or resource subscriptions
  are actually needed, take the SDK. At that point its dependencies are paying for
  something we use, and this decision should be reversed rather than defended.
- The tool-level error contract (a failed tool is `isError` content, not a JSON-RPC
  error) is ours to keep correct; `tests/mcp-contract.test.mjs` pins it.

## Alternatives considered

- **SDK with only the stdio server imported** — still installs the whole package plus
  its dependency closure; the saving is cosmetic.
- **Expose the CLI instead of MCP** — kept as the fallback path for clients without MCP,
  but it cannot be the primary surface: every MCP client would then need to shell out
  and parse text.
