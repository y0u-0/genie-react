# Genie CLI

Give your coding agent DevTools for the running React app.

The CLI lets the agent inspect, optimize, test, and verify the app from the terminal.

## Start

```bash
pnpm add -D genie-react
npx @genie-react/cli init
pnpm dev
npx @genie-react/cli status --sessions-only
```

If more than one tab is open, add `?_genie=my-agent` to your app URL. Then use `--session my-agent` on each command, or set `GENIE_SESSION=my-agent` once.

The alias survives navigation, reloads, and reconnects. From a workspace root, the CLI selects one live app or stops with an explicit list when several are live.

## Find wasted renders

```bash
npx @genie-react/cli call react_clear_renders '{}'
# Drive one flow in the app.
npx @genie-react/cli call react_get_renders '{"sort":"selfTime","limit":3}'
npx @genie-react/cli call react_render_causes '{"component":"Button","limit":3}'
```

Real demo output:

```text
4 commits · 6 components · 24 renders · 24 updates · 4 unstable · 2 unnecessary
unstable props: onClick×4
  Button #81 4× (0m 4u) · 4 unstable · self 0.2ms · ↻ props: onClick(unstable) (button.tsx:50)
```

The agent gets the component, source line, render cost, and exact cause. Causes include props, state, context, Query, Router, parent renders, and mounts.

## Audit an effect

```bash
npx @genie-react/cli call react_effect_audit '{"appOnly":true,"onlyHot":true}'
```

Each effect reports its own source and whether ownership evidence is `exact`, `inferred`, or `unknown`. Hotness uses a minimum sample count and a 95% interval, so a short run is marked `insufficient-data`.

## Inspect live hooks

```bash
npx @genie-react/cli call react_find_components '{"query":"App","exact":true}'
# Use the id returned above. The demo returned App #65.
npx @genie-react/cli call react_inspect_component '{"id":65}'
```

Excerpt from the demo:

```text
App #65 · function
  props: {}
  hooks: 12
    [0] effect
    [1] state stateIndex 0 = listeners, subscribe, options, refetch
    [3] other = status="success", fetchStatus="idle", isPending=false, isSuccess=true, isError=false, data, +18 more
```

The agent can read the mounted component's real props, state, and hooks instead of guessing from source.

## Test a TanStack state

```bash
npx @genie-react/cli call query_simulate_state \
  '{"queryKey":["demo","greeting"],"state":"pending"}'
```

```text
ok=true · queryHash="[\"demo\",\"greeting\"]" · simulatedState="pending" · originalStatus="success"
```

The agent can drive and verify the real loading UI, then restore the exact query state:

```bash
npx @genie-react/cli call query_restore_state '{"queryKey":["demo","greeting"]}'
```

```text
ok=true · restored=1
```

## Output for agents

Common read tools print short text by default. Add `--json` for the full compact JSON result:

```bash
npx @genie-react/cli call react_inspect_component '{"id":65}' --json
```

Use `--fields` when the agent only needs a few fields:

```bash
npx @genie-react/cli call query_list '{}' --fields queryHash,status,fetchStatus
```

```json
{"queryHash":"[\"demo\",\"greeting\"]","status":"success","fetchStatus":"idle"}
```

Every tool includes its input schema and a runnable example:

```bash
npx @genie-react/cli tools
npx @genie-react/cli tools react_inspect_component
```

`--json` prints one compact JSON value to stdout. `batch` prints JSONL by default; use `--json` for one JSON array. Errors use the same stable machine format and do not mix prose into stdout.

Use `--ndjson` when you want to state JSONL explicitly. CLI-owned status, batch, and error objects include `schemaVersion`. Successful calls keep the output schema shown by `tools <tool>`.

Use `--verbose` when startup is unclear. It prints the CLI version, bridge target, session, and time budgets to stderr. `--connect-timeout <ms>` bounds only the bridge connection.

Wait on an exact Query key instead of sleeping:

```bash
npx @genie-react/cli call devtools_wait \
  '{"condition":"query-settled","queryKey":["demo","greeting"]}'
```

For a large component tree, call `react_find_components`, then pass its id as `rootId` to `react_get_tree`.

## Compare repeated runs

Clear the render data, drive one exact flow, and create a named capture:

```bash
npx @genie-react/cli call react_clear_renders '{}'
# Drive the flow.
npx @genie-react/cli call devtools_capture_create '{"name":"before-1"}' --json
```

Run the same flow at least three times before and after the change. Then compare the returned IDs:

```bash
npx @genie-react/cli call devtools_capture_compare \
  '{"baselineCaptureIds":["<before-1>","<before-2>","<before-3>"],"candidateCaptureIds":["<after-1>","<after-2>","<after-3>"],"metrics":["react.renders"],"budgets":[{"metric":"react.renders","maxRegressionPct":0}]}'
```

The verdict is `pass`, `fail`, or `insufficient-data`. It also reports sample counts, median, p95, and spread. The hub keeps the latest 20 captures.

See the [full setup and tool list](https://github.com/Genie-sa/genie-react#readme).
