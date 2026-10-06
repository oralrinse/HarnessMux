# @harnessmux/portable-plugin — the shared client layer

Everything a client adapter needs, defined **once**. The rule this package exists to
enforce:

> A new client is a manifest plus thin lifecycle integration — never a second copy of
> the plugin.

## What is shared

| Asset | Path | Purpose |
|---|---|---|
| MCP server | `packages/mcp/server.mjs` | the tool roster every MCP client sees |
| Mailbox skill | `skills/harnessmux/SKILL.md` | operating instructions: workflow, the binding rule, at-least-once, limits |
| Registration template | `mcp.json` | a paste-ready `mcpServers` block |
| This module | `index.mjs` | path resolution and `mcpRegistration()` for installers |

## Wiring a client

```js
import { mcpRegistration, describe } from "@harnessmux/portable-plugin";

// Print or write this block into the client's own MCP configuration file.
console.log(JSON.stringify(mcpRegistration({ bridgeRoot: "<bridge>", actor: "codex" }), null, 2));
```

`mcpRegistration()` emits an absolute `command`/`args` pair because MCP clients do not
resolve npm package names in that field, and a relative path would depend on the
client's working directory.

## What an adapter still owns

Only the platform-specific parts:

- the plugin manifest in the shape that host expects (for Codex:
  `.codex-plugin/plugin.json` + a local marketplace entry);
- lifecycle hooks, when the host has them (for Codex: an opt-in `hooks.json`);
- installation and distribution for that host.

Adapter packages live next to this one (`packages/adapter-codex/`, and later
`adapter-claude/`), and must not fork the tool definitions or the skill text.

## Deliberately not here yet

- **Lifecycle hooks.** P3.1 is the shared layer only; hooks arrive with each adapter
  (P3.2/P3.3) once this layer is stable.
- **A generic manifest.** Hosts disagree on manifest shape. Inventing a superset now
  would be a guess; the second adapter is what will show which parts are truly common.
- **A bundler.** The MCP server is a single dependency-free file; adapters can point at
  it directly.
