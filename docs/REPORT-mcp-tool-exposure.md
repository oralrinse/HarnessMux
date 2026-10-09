# MCP tool exposure — why a Codex session has no HarnessMux tools

Status: **diagnosed to the environment boundary; one causal link is supported but not directly logged.**
Date: 2026-10-09
Scope: read-only reconnaissance. No Codex configuration, no bridge, no Protocol v2 semantics were changed.

---

## 1. The exposure chain, layer by layer

| layer | question | verdict | evidence |
| --- | --- | --- | --- |
| A | plugin installed and enabled | **green** | `codex mcp get harnessmux` → `enabled: true`, `transport: stdio`; `config.toml` → `[plugins."harnessmux@harnessmux"] enabled = true`, marketplace `source = '\\?\H:\…\harnessmux'` |
| B | MCP server starts | **green on the Windows client** | the app-server's own catalogue reports it running with `serverInfo: harnessmux@0.1.0` and no error |
| C | `tools/list` returns the tools | **green, 9 tools** | direct JSON-RPC handshake: `get_status, reply_message, bind_thread, list_sessions, read_messages, list_endpoints, send_message, wait_for_reply, list_threads` |
| D | the client's catalogue discovered them | **green on the Windows client** | `mcpServerStatus/list` (method confirmed to exist in this build from its own generated schema before calling it) |
| E | the model was offered them | **RED in the session that matters** | that session's own rollout: the tool names appear **only as prose** in injected skill text, never as a definition |
| F | the model called one | **RED** | 0 HarnessMux tool calls in every recent session; in the two sessions examined the model invoked **no MCP-namespaced tool of any kind** — only built-in `exec`/`wait` |

A→C success does not imply D→F success, and here it did not.

## 2. Environment and versions — there are two Codex builds

| | node CLI | desktop app |
| --- | --- | --- |
| version | `codex-cli 0.154.0` | **`0.162.0-alpha.17.2`** |
| entry | `H:\…\compiler\nodejs\codex.ps1` → `node_modules/@openai/codex/bin/codex.js` | `C:\Program Files\WindowsApps\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0` (Electron 155.0.8059.40, `ChatGPT.exe`) |
| how it was identified | `codex --version` | the session's own `session_meta`: `"originator":"codex_work_desktop"`, `"source":"vscode"`, `"cli_version":"0.162.0-alpha.17.2"` |

**The session that matters is the desktop app.** Its own record says so, and its environment is **WSL**:

```
world_state.environments = {"local":{"cwd":"/mnt/h/<checkout>/2026-10-09/…",
                                    "status":"available","shell":"bash"}}
session_meta.cwd        = /mnt/h/<checkout>/2026-10-09/…
```

Every recent session on this machine has an `/mnt/…` cwd; `wsl -l -v` shows `Ubuntu Running` as the default
distro. The Windows CLI and the WSL-hosted desktop session are therefore **different clients with different
environments**, and all of my earlier `codex exec` results came from the Windows one.

## 3. The three catalogues

**1. The server's own `tools/list`** (direct handshake, isolate bridge): 9 tools, `get_status` works.

**2. The client's catalogue** — `mcpServerStatus/list` over a fresh app-server (node CLI 0.154.0, the user's
real `CODEX_HOME`; request shapes derived from the client's own generated JSON Schema, not guessed):

```text
servers reported: 4
name=codex_apps  pluginId=-                    serverInfo=plugin-runtime@0.1.0  tools=157  error=-
name=cua_repl    pluginId=-                    serverInfo=-@-                    tools=0    error=-
name=harnessmux  pluginId=harnessmux@harnessmux serverInfo=harnessmux@0.1.0     tools=9    error=-
    tools: get_status, reply_message, bind_thread, list_sessions, read_messages, list_endpoints,
           send_message, wait_for_reply, list_threads
name=node_repl   pluginId=-                    serverInfo=-@-                    tools=0
    error=MCP startup failed: 系统找不到指定的路径。 (os error 3)
```

`harnessmux` reports `toolsError: null`, `authStatus: "unsupported"` — so "Auth: Unsupported" in the UI is
not a fault. `node_repl` genuinely fails to start (its own path problem) and is a separate defect.

**3. What the model actually had** — from the desktop session's rollout (1617 events, 10/8 13:45 → 10/9 03:13):

- `get_status` ×3, `list_sessions` ×3, `send_message` ×5, `wait_for_reply` ×2 — **all occurrences are inside
  injected developer/skill prose** ("HarnessMux: `get_status` -> `list_sessions` -> `bind_thread` -> …"),
  never a tool definition, never a call;
- tools the session invoked: `exec` ×130, `wait` ×5 — **no MCP-namespaced tool at all**;
- `turn_context.disabled_plugin_ids: []` — the plugin was not disabled per session;
- the model's own words in the user's 15:53 session: *"HarnessMux MCP 工具在当前会话中不可用：我检查了可调用工具列表，未发现 `get_status` 或 `list_sessions`。"*

## 4. Root cause

**The installed MCP entry is Windows-only, and the session that needs it runs inside WSL.**

The installed plugin overlay was rewritten by the HarnessMux installer to a Windows command:

```json
"harnessmux": {
  "command": "%SystemRoot%\\System32\\cmd.exe",
  "args": ["/d","/s","/c",
           "%CODEX_HOME%\\plugins\\cache\\harnessmux\\harnessmux\\0.2.0\\scripts\\node-shim.cmd",
           "launch-mcp.mjs"]
}
```

(the repository ships `command: "node"`, `args: ["./scripts/launch-mcp.mjs"]`, `cwd: "."`; the rewrite is the
installer's, and `node-shim.cmd` documents why it exists — the desktop app does not put node on the PATH of
the processes it spawns).

Measured in the session's own environment:

```text
$ wsl -d Ubuntu -e bash -lc 'C:\WINDOWS\System32\cmd.exe /d /s /c echo hi'
bash: line 1: C:WINDOWSSystem32cmd.exe: command not found        (exit 127)

$ wsl -d Ubuntu -e bash -lc 'command -v node'
(no output — node is not installed in WSL at all)
```

So in the WSL session neither the rewritten Windows command nor the repository's original `node` form can
start the server. On the Windows side the same entry starts fine and exposes all nine tools — which is why
A/B/C/D are green and E/F are red.

**The one link I could not log directly:** that the desktop app launches plugin MCP servers *inside the
session's environment* rather than on the Windows host. Supporting it: the session's environment is
`shell: bash` under `/mnt/h`, the model saw **no MCP server of any kind**, and the Windows-hosted launch is
proven to work — so "the client launched it on Windows and the model still got nothing" would require a
second, unrelated filter for which there is no evidence. It is very strong inference, not a recorded fact;
§6 gives the experiment that closes it.

Hypotheses eliminated by test, not argument:

- **`tool_search_always_defer_mcp_tools` is not the cause.** `codex exec -c features.tool_search_always_defer_mcp_tools=false …` still answered `NONE`. (That flag is also `removed` in `codex features list`.)
- **The plugin is not disabled per session** (`disabled_plugin_ids: []`).
- **The MCP server is not broken** (9 tools, no `toolsError`).
- **The stale skill was not the cause** of tool exposure (it is fixed, and prose never was the mechanism).

## 5. Minimal fixes, with risks

| # | fix | how | risk |
| --- | --- | --- | --- |
| 1 | **Run the Codex session on Windows** (open the project as a Windows workspace in the desktop app instead of a WSL one) | no HarnessMux change; the installed entry is proven to work on the Windows host | changes the user's working environment for that session; the project lives on `H:` so a Windows workspace is viable |
| 2 | **Make the entry environment-agnostic through WSL interop** — command `/mnt/c/Windows/System32/cmd.exe`, Windows-form args, and `HARNESSMUX_DIR` in Windows form (`H:\…\.harnessmux`) | requires a **user-level `mcp_servers` entry** (i.e. a second registration — needs approval) or an installer change | interop works (verified: `/mnt/c/Windows/System32/cmd.exe … → INTEROP_OK`), but the server is then a Windows process talking to a WSL session, and the bridge path must be passed in Windows form; untested end-to-end |
| 3 | **A WSL-native server** — `command: node`, `args: ["/mnt/h/…/packages/mcp/server.mjs"]`, `HARNESSMUX_DIR=/mnt/h/…/.harnessmux` | installs node inside WSL, then a second registration | installing node in WSL is a system change (approval), and the bridge is then reached over `/mnt/h` — workable but a different trust path |

Not proposed: changing Protocol v2, the receiver, dispatch/ACK/reply semantics, the shared bridge path, or
the P2 executor's state. None of those is implicated.

**If the Windows-only assumption is judged a repository defect** (the adapter installs a command that cannot
work in a WSL-hosted session), the minimal patch is in the adapter/installer: emit an entry that either
works in both environments or fails with a diagnosable message, plus a regression test. That needs approval
and its own round; it is not implemented here.

## 6. The experiment that closes the gap

Run **one** Codex session whose environment is *local Windows* (not WSL) in the desktop app, and ask it:

```text
List the exact names of every MCP tool available to you, grouped by server. Do not call any of them.
```

- tools appear → the environment mismatch is **proven**, fix 1 is the minimal repair, and P2 can proceed in a
  Windows workspace;
- no tools appear even there → the client-side exposure problem is independent of WSL and the next step is
  the app's own logs / the 0.162 app-server's `mcpServerStatus/list`, which I could not reach (the local
  app-server control socket is dead: `failed to connect to …\app-server-control.sock`, `os error 10050`).

Minimal in-session check for the user, no tooling needed: ask the model to print its tool list, or type `/mcp`
— a server can be *listed as enabled* while contributing **zero** tools to the model, and those two facts
must not be conflated.

## 7. Impact on P2, and the verdict

The P2 chain needs the Commander's MCP tools in the Commander's session. The Commander's session is the
desktop app running in WSL; its MCP entry is a Windows command; therefore the Commander has no tools, and
**nothing about HarnessMux's protocol, dispatch, capture or recovery is implicated**. The executor side is
unaffected and still verified.

**P2 BLOCKED**

Blocked on layer E (the model's tool set), not on A–D and not on this repository's semantics. It unblocks the
moment a real Codex interactive session successfully calls a HarnessMux MCP tool — which requires either a
Windows-environment session (fix 1) or an approved change to how the entry is registered (fix 2/3).

## 8. Evidence hygiene

All checks were read-only. Nothing in `~/.codex/config.toml`, the plugin cache, the shared bridge, or the P2
executor's state was modified. Artifacts created and left for inspection (all outside the repository):

- `%TEMP%\codex-appserver-schema\` — the protocol schema generated by the client itself (used to derive the
  request shapes and to confirm `mcpServerStatus/list` exists);
- `.hx-lab\*.mjs` in the session workspace — the scanners and the app-server probe.
