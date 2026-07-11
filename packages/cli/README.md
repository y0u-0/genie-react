# Genie CLI

Give your coding agent DevTools for the running React app.

The CLI lets the agent inspect, optimize, test, and verify the app from the terminal.

## Start

```bash
pnpm add -D genie-react
npx @genie-react/cli init
pnpm dev
npx @genie-react/cli status
```

## Find wasted renders

```bash
npx @genie-react/cli call react_clear_renders '{}'
# Drive one flow in the app.
npx @genie-react/cli call react_get_renders '{"sort":"selfTime","limit":3}'
```

Real demo output:

```text
4 commits · 6 components · 24 renders · 24 updates · 4 unstable · 2 unnecessary
unstable props: onClick×4
  Button #81 4× (0m 4u) · 4 unstable · self 0.2ms · ↻ props: onClick(unstable) (button.tsx:50)
```

The agent gets the component, source line, render cost, and cause. It knows what to optimize.

## Inspect live hooks

```bash
npx @genie-react/cli call react_find_components '{"name":"App"}'
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

See the [full setup and tool list](https://github.com/Genie-sa/genie-react#readme).
