# REPORT — Configured session creation (Desktop materialize path)

**Status:** researched, not implemented. `create_session` is **PARTIAL / NOT PRODUCT-READY** and is now
**fail-closed**.

**Why this report exists.** The Commander goal is "a client directs an existing DSH session until the task
is done". Workspace-backed session creation is *not* a prerequisite for that, and treating it as one held
the main line hostage. This document freezes what was proven so the research is not lost and does not keep
blocking P0.

---

## The finding in one line

```text
ctx.agents.create()  ≠  Desktop configured session creation
```

It is a **session primitive**: persistent and addressable, but not an assembled agent.

---

## Measured: a working session versus a created one

Two agents compared in one real host, before either first step:

| field | WORKING (host-built) | CREATED (`ctx.agents.create()`) |
| --- | --- | --- |
| `options.provider` | `"deepseek-official"` | **undefined** |
| `options.model` | `"deepseek-flash"` | **undefined** |
| `session.header.cwd` | workspace path | **undefined** |
| `session.header.agentPreset` | `"standard"` | **absent** |
| `session.header.delegationDepth` | `0` | **absent** |
| `session.header.version` / `isSeeded` | number / boolean | same |
| `loopCtx` / `ctx` / `systemPrompt` / `runtimeContext` | present | present |
| session persistent | yes | yes |
| `followup()` accepted | yes | yes |
| `turn/start` reached | yes | yes |
| `step/start` reached | yes | yes |
| **prompt assembly** | yes | **no** |
| step / model execution | yes | **never** |

The created session's first turn ends with:

```text
turn/end reason={"kind":"error","error":{"message":
  "prompt variable \"{{model}}\" has no value for this assembly (section \"deployment:persona-prefix\")"}}
```

So the divergence is **inside prompt assembly**, not in session lifecycle. `turn/start` and `step/start` are
both reached; the model step never runs.

A real persisted session header, for comparison:

```json
{"type":"session","version":4,"id":"session-…","createdAt":…,
 "cwd":"<workspace>","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

---

## The missing layer

Supplying the fields to `create()` does not work, and this was measured rather than assumed:

- `create({ sessionId, agentOptions: { provider, model } })` — route still empty afterwards
- `create({ sessionId, agentOptions, cwd })` — `cwd` does not reach the session header
- `create({ sessionId, agentPreset: "standard" })` — accepted and **dropped**; header unchanged

Three independent fields, all belonging to a layer `create()` does not go through.

### What that layer is

`dsh-agent-preset` is a **registrar**, not a resolver. Its entire implementation registers a named list of
child plugins into the injected `agentPresets` service, and it documents the contract itself:

> "Declare several presets and let sessions select one. `config.id` is the preset identity saved by sessions."

`dsh-agent-preset-registry` adds:

> "Choose an Agent's tools, prompt sections and skills through declarative presets."
> "`default` | required | Preset ID used when none is requested"

So a preset is an ordinary Cordis composition, and the session header's `agentPreset` selects one.

Where a working agent's **route** comes from is also located — the desktop profile's patch:

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: high
```

Meanwhile `<profile>/cordis.yml` is an empty entry list (`[]`) and the patch contains **no preset row at
all**, so whatever defines `standard` is applied from a bundle layer before the patch.

---

## Environment note, stated precisely

`agentPresets` is **not registered in the headless profile** — declaring it in `inject` fails the plugin
silently, and the symptom is a host that prints nothing. That is proven.

It is **not** proven that a Desktop plugin cannot see this layer. What *is* proven is that the
public/discoverable API surface reached from a plugin is **not sufficient to implement workspace-backed
session creation safely**, which is the operative conclusion.

Runtime introspection reached its limit here: the root fiber's registry exposes only
`{ctx,_counter,_internal}` with `_internal` empty, and `session.requestContext()` / `requestHeader()` return
`undefined` when called without arguments, so the assembly input they take was not observable.

---

## Consequence: fail-closed

The `create` action now **refuses by default**:

```text
configured-session creation unavailable
… Nothing was created. Use an existing session instead: list_sessions then bind_thread.
Pass allow_unconfigured=true only to create a primitive deliberately, for inspection.
```

Rationale: a session that looks bound and healthy while being unable to run is **harder to diagnose from
outside than an explicit refusal**. Before this change the action would happily produce one, and the
Commander would have dispatched work into a session that could never answer.

M16–M18 in `tests/mapping.test.mjs` assert the surrounding boundaries: no model name is invented, no
working directory is invented, no `agentPreset` is written into a session, no header `cwd` is patched, the
preset registry is not reached for, and the agent factory is not driven directly.

---

## Where to resume, if this is ever prioritised again

Search the desktop/app bundle — not a plugin — for:

1. the **`agentPresets` registration** that defines `standard`, and what it expands to (sections, tools, skills);
2. a **session-header builder** writing `agentPreset` + `cwd` + `delegationDepth` together — whoever writes
   all three at once is the closest thing to the entry point;
3. the **consumer of the `agent-default-model` row**, already proven to be the route's source;
4. whether any of that is reachable as a **command, service, event or controller** a plugin may call.

Do **not** resume by copying internal logic, writing `agentPreset`/`cwd` by hand, or patching a session
header: those values belong to the definition layer, and fabricating them produces the broken session this
report is about.

---

## Priority, restated

```text
P0  Existing-session Commander Mode      <- the real goal, unblocked by this report
P1  Automatic final capture
P2  Commander two-round autonomous PASS
P3  Workspace-backed configured create_session   <- this document; deferred
P4  title -> sessionId / installer / doctor
```

Existing sessions already have `cwd`, `agentPreset`, a resolved route and working assembly. They are
sufficient to build Commander Mode, which is why this research is parked rather than pursued.
