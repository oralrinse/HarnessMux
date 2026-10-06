# Open defect: a stopped harness instance can leave a stale endpoint behind

Found by the first P3.3-C acceptance run, 2026-10-06. Status: **narrowed, workaround in
place, root cause not yet proven.** This entry records what is verified, because the
symptom is severe (clients bind to a session that no longer exists) and the remaining
question is specific.

## Symptom

`list_sessions` — and every adapter's binding UI — read the endpoint the receiver publishes.
The published list was 50 minutes out of date and named sessions that had stopped:

```
endpoints/dsh-endpoint.json   (modified 16:28:21)
  sessions: ["91525228-2110-44e7-9b93-2ce6dfba873e", "948b5853-e460-43a0-81a9-9acbd6267a14"]

the pump, in the same ticks, was serving:
  session-f43409f1-441c-4251-ac4f-ddf74974412b
```

A delivery addressed to `91525228…` therefore waited forever: a stopped session is
indistinguishable from an idle one, and the documented boundary says an idle session is not
woken. The acceptance run reported this as a D3 failure until the trace showed that the
target had never been live.

## What is verified

1. **The publisher works, including on the busy path.** `tests/endpoint-freshness.test.mjs`
   mounts the receiver with a stale publication and a queue that keeps the pump delivering,
   and asserts that the live session is published within a tick and the stale one is
   dropped. It passes. So `refreshEndpointIfChanged()` is not skipping the delivering path,
   and the P9 fix holds.

2. **The stale write did not come from the running app.** The receiver logs
   `registerV2Endpoint` unconditionally when `debugLog` is set, and the running app's last
   registration is:

   ```
   2026-10-06T16:04:25.954Z registerV2Endpoint … sessions=["session-f43409f1-…"]
   ```

   There is **no** registration line for `91525228/948b5853` and none at 16:28:21, yet that
   is when the file was written.

3. **The timing matches the ACP probe I ran, not the app.** The file's mtime (16:28:21) is
   seconds before the pump first saw a delivery addressed to `91525228…` (16:28:26), and the
   two published session ids are the two sessions that `examples/live/cutover-probe.mjs`
   spawns with `dsh --profile acp`. That probe starts **separate harness processes** with the
   same `endpointId`.

4. **The current app never republished afterwards**, so the file stayed as the exited probe
   left it.

## Leading hypothesis (not proven)

Endpoint records are keyed by `endpointId` alone, so two harness instances configured with
the same `endpointId` overwrite each other's record. When the short-lived instance exits, its
last write survives and the long-lived instance has no reason to rewrite — its own published
set has not changed since 16:04:25, and `refreshEndpointIfChanged()` is deliberately
idempotent.

That fits every observation: same `endpointId`, different processes, an unconditional write
from the transient one, and an idempotent writer that stays silent afterwards.

## What would settle it

A campaign that records every `registerV2Endpoint` with its process identity, and a
deliberate reproduction: start harness A, start harness B with the same `endpointId`, stop B,
then observe whether A's endpoint record is the one that survives. That is a receiver-design
question — endpoint identity across instances — and it is worth deciding deliberately,
because "two harnesses share one endpoint id" may be a legitimate configuration or a
misconfiguration that should be rejected at registration.

## Workaround in place now

`examples/live/claude-acceptance.mjs` no longer trusts the published list:

- it reports the endpoint's age and **refuses to run** when the harness has not republished
  for more than two minutes, explaining that a delivery to a stopped session would wait
  forever by design;
- `--target-session <id>` states the target explicitly for that case.

This is a consumer-side guard, not a fix. The defect remains open.
