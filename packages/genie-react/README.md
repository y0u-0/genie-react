# Genie React

Give your coding agent live access to your React app.

Genie helps the agent find performance problems, inspect real app state, test hard-to-reach UI, and verify its work end to end.

Source code shows what *should* happen. Genie shows what *did* happen.

## Install

```bash
pnpm add -D genie-react
npx @genie-react/cli init
pnpm dev
```

Open the app, then check the connection:

```bash
npx @genie-react/cli status --sessions-only
```

Genie runs in development only. It does not ship in your production build.

If more than one tab is open, add `?_genie=my-agent` to the app URL. Use `--session my-agent` on each command, or set `GENIE_SESSION=my-agent` once. The same target keeps working after a reconnect.

## Find wasted renders

Clear the counters, drive one flow, then read the result:

```bash
npx @genie-react/cli call react_clear_renders '{}'
# Click, type, or navigate in the app.
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

Each effect reports its own source, whether it belongs to app or library code, and whether the evidence is `exact`, `inferred`, or `unknown`. Short runs are marked `insufficient-data` instead of being called hot too early.

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

Hold a real query in its pending state:

```bash
npx @genie-react/cli call query_simulate_state \
  '{"queryKey":["demo","greeting"],"state":"pending"}'
```

```text
ok=true · queryHash="[\"demo\",\"greeting\"]" · simulatedState="pending" · originalStatus="success"
```

The agent can now drive and verify the real loading UI. Restore the exact query state when done:

```bash
npx @genie-react/cli call query_restore_state '{"queryKey":["demo","greeting"]}'
```

```text
ok=true · restored=1
```

## Close the loop

1. Make a change.
2. Drive the real app.
3. Read its live state.
4. Fix or optimize the issue.
5. Repeat the flow and verify the result.

The agent can extract what it needs without asking you for screenshots, logs, or guesses.

For a stronger performance check, repeat the same flow at least three times before and after the change. Save each run with `devtools_capture_create`, then pass the IDs to `devtools_capture_compare`. The result reports sample counts, median, p95, spread, and a typed budget verdict. Small samples are `insufficient-data`, not a false pass.

Works with React 18 and 19, Vite, TanStack Start, Next.js, React Native, Expo, TanStack Query, and TanStack Router.

See the [full setup and tool list](https://github.com/Genie-sa/genie-react#readme).
