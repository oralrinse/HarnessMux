# P3.4-B reconnaissance — VS Code / GitHub Copilot: the client is not on this machine

Date: 2026-10-06 · VS Code **1.140.0** (x64, `<VSCODE_INSTALL>`) ·
Windows.

Verdict: **this phase cannot be executed as planned, because GitHub Copilot is not installed
here.** That is the whole finding, and it is worth recording precisely rather than working
around, because it changes what "P3.4-B" can mean on this machine.

## 1. Copilot is absent — three independent checks

```
code --list-extensions | findstr copilot   →  (nothing)
extension directories matching ^github\.    →  github.remotehub, github.vscode-github-actions
extensions matching /copilot|chat/          →  (nothing)
```

VS Code does not ship Copilot as a built-in either (nothing under
`resources/app/extensions` matches). The running instance uses the default user-data and
extension directories (`--user-data-dir=<APPDATA>\Code`), so there is no
profile in which it might be hiding.

The user settings contain a `github.copilot.enable` block, which is easy to misread as
evidence of an install. It is a **stale setting**, and it is why "the settings mention Copilot"
cannot be used as a proxy for "Copilot is present" — the same class of mistake as trusting a
documented format over the loaded one.

## 2. What this machine does have

| Extension | What it is | Why it is not the planned target |
|---|---|---|
| `openai.chatgpt` 26.928.31416 — display name **"Codex – OpenAI's coding agent"** | the official Codex extension for VS Code, with `chatSessions`, views and commands | it is a **Codex** surface, and Codex is already verified at the CLI; it is not Copilot |
| `anthropic.claude-code` 2.1.289 | Claude Code for VS Code; contributes a `claude-vscode.installPlugin` command | a **Claude Code** surface, already verified at the CLI |
| `saoudrizwan.claude-dev` (Cline) | a third-party agent extension | not Copilot, and not a target we agreed to support |

So the two AI clients this machine *does* expose inside VS Code are the two that are already
verified end-to-end. Neither is the subject of P3.4-B.

## 3. Why the planned checks are not merely inconvenient but invalid here

Every condition in the agreed set needs the client itself:

```text
E1  HarnessMux plugin loads in Copilot        needs Copilot
E2  Copilot sees the shared MCP tools         needs Copilot
E3  Copilot calls the shared server           needs Copilot
E4  Copilot → DSH delivery                    needs Copilot
E5  DSH → Copilot at the next lifecycle       needs Copilot
```

Substituting a different extension would test a different client and produce evidence that
does not belong to the Copilot row of the compatibility table. That is exactly the kind of
substitution this project has been refusing: a PASS has to belong to the thing it names.

## 4. What can be established without Copilot, and what cannot

**Can be established offline**, from VS Code's own surface and the documented Agent Plugins
layout, but only as *format* evidence:

- whether the `.github/` / `com.github.copilot/` layout the phase assumes is what VS Code 1.140
  actually reads (needs the extension present to check against its loader, so in practice:
  **not checkable here either**);
- that VS Code 1.140 offers `code --add-mcp <json>` for user-level MCP definitions and that
  `code agent` exists as an agent host. Both are real surfaces on this build, and both are
  user-level configuration rather than a portable plugin.

**Cannot be established here at all**: everything about Copilot's plugin discovery, its
`com.github.copilot/` conventions, its MCP loading, its hooks, and whether any of it reaches a
model. Those require the extension.

## 5. Options, with the trade-offs stated

1. **Install GitHub Copilot in VS Code and rerun this reconnaissance.** The only path that
   produces the evidence the phase is for. Requires a Copilot subscription/sign-in.
2. **Verify the Codex VS Code extension as a separate client row.** Honest and cheap — it is
   installed, it is a different surface from the Codex CLI (a UI with its own `chatSessions`),
   and it can answer a real question: does the VS Code surface inherit the CLI's MCP
   configuration and plugin, or does it need its own? It is **not** Copilot, and it would be
   recorded as its own row, never as Copilot's.
3. **Defer P3.4-B and finish what is already verifiable**: the two clients with real evidence
   are done, Cursor's reconnaissance is done, and the remaining unverified client work is
   blocked on clients that are not installed here.

Option 1 is the only one that advances P3.4-B as agreed; option 2 is the only one that
advances anything today; option 3 is the honest default if neither is wanted.

## 6. Note for the compatibility table

The Copilot row stays **⏳ not installed here** — not "untested", which would imply the client
is available. The distinction matters, because an untested-but-present client can be tested
later without any new decision, while an absent one needs a subscription first.

## 7. A caution carried over from P3.4-A

The Cursor reconnaissance corrected an assumption that came from documentation ("a root
`plugin.json` is an Agent Plugins 1.0 manifest that both clients load") by reading the loader.
The same caution applies to the Copilot half of that assumption: `com.github.copilot/` and
"Agent Plugins 1.0 portable core" are documented claims that this machine cannot check, and are
therefore **not** treated as established anywhere in the design or the docs.
