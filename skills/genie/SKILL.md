---
name: genie
description: Drive live DevTools on a RUNNING React, React Native, or TanStack app with the `genie-react` CLI. Use it to inspect components, explain renders, audit effect ownership and hotness, read Query or Router state, force hard-to-reach UI, and prove a change with repeated runtime captures. Pair it with agent-browser on web or agent-device on native. Do not use it for static source review.
---

# Genie

Genie reads the app that is running now. It shows React, effects, Query, Router, memory, and performance data that source code and screenshots cannot show.

Use agent-browser or agent-device to drive the UI. Use Genie to explain what happened underneath it.

## Set up once

For a Vite or Next.js app:

```bash
pnpm add -D genie-react
npx @genie-react/cli init
pnpm dev
```

For another web bundler, run `npx @genie-react/cli hub` and load its client script first in `<head>`. For React Native, run the hub and use `genie-react/native`. See the package README for the exact setup.

## 1. Connect and pin the tab

Open the app. Run this from the app directory:

```bash
genie-react status --sessions-only
```

From a workspace root, Genie selects the only live app. If several apps are live, it stops and lists them. Move into the right app directory or pass `--url`.

With several tabs or agents, give your tab a name:

```text
http://localhost:3000/?_genie=my-agent
```

Pin every later call to it:

```bash
export GENIE_SESSION=my-agent
```

The name and logical session survive navigation, reloads, and reconnects. A physical session ID also works, but it is less useful for long jobs.

This step is complete when the named target says `ready=true`. Run full `genie-react status` once if you need its domain list.

If startup hangs, rerun with `--verbose`. It prints the CLI version, chosen bridge, session, and time budgets to stderr. Use `--connect-timeout <ms>` to bound only the WebSocket connection.

## 2. Measure one exact flow

Use the same loop every time:

```bash
genie-react call react_clear_renders '{}'
# Click, type, navigate, or reproduce the issue.
genie-react call react_get_renders '{"sort":"selfTime","limit":5}'
```

Clear immediately before the flow. Otherwise the result mixes old work with the flow you care about.

This step is complete when the output covers one known interaction.

## 3. Ask the smallest useful question

- Unexpected render: `react_get_renders`, then `react_render_causes`.
- Slow flow: `react_profile_start`, drive the flow, then `react_profile_report`.
- Effect loop: `react_effect_audit`.
- Blank or stuck UI: `react_error_state`.
- Component state: `react_find_components`, then `react_inspect_component`.
- DOM owner: `react_component_for_dom`.
- Query state: `query_list`, `query_get`, or a focused Query action.
- Route state: `router_get_state`, `router_list_matches`, or a focused Router action.
- Memory: `browser_get_memory`.
- Frame rate: `browser_fps` while the tab is visible.

Effect results include ownership, the effect's own source, and `exact`, `inferred`, or `unknown` evidence. A hotness result is only strong after enough updates. Treat `insufficient-data` as unknown, not healthy or hot.

For one dependency's effects, use an exact package name with `appOnly:false`:

```bash
genie-react call react_effect_audit '{"packageName":"@tanstack/react-query","appOnly":false}'
```

For a large tree, find a component and read only its subtree:

```bash
genie-react call react_find_components '{"query":"Checkout","exact":true}'
genie-react call react_get_tree '{"rootId":42,"depth":3,"maxNodes":100}'
```

`router_get_state` reads Router state and browser history in one call. Check `locationSync` before trusting the URL.

Wait for one exact Query key instead of matching text:

```bash
genie-react call devtools_wait '{"condition":"query-settled","queryKey":["cart"]}'
```

Genie can prove readiness, Query idle, and Router navigation. It cannot prove that every custom request or animation frame in an app is idle.

Use `genie-react tools` to list groups. Use `genie-react tools <tool>` for the full schema and an example. Do not dump every contract unless it is needed.

## 4. Prove the change with repeated captures

Run the same flow at least three times before the change and three times after it. For every run:

```bash
genie-react call react_clear_renders '{}'
# Drive the exact same flow.
genie-react call devtools_capture_create '{"name":"before-1"}' --json
```

Keep the returned capture IDs. Compare both groups:

```bash
genie-react call devtools_capture_compare \
  '{"baselineCaptureIds":["<before-1>","<before-2>","<before-3>"],"candidateCaptureIds":["<after-1>","<after-2>","<after-3>"],"metrics":["react.renders","react.selfTimeMs"],"budgets":[{"metric":"react.renders","maxRegressionPct":0}]}'
```

The comparison reports sample counts, median, p95, median absolute deviation, and budget failures. `insufficient-data` is not a pass. Use the same app build, route, device, and interaction for both groups.

This step is complete when the requested budgets pass and the UI behavior is still correct.

## 5. Leave the app clean

- Restore simulated Query state with `query_restore_state`.
- List active overrides with `react_list_overrides`.
- Remove them with `react_reset_overrides`.
- Check the browser or device for visible errors.
- Save important capture JSON. The hub only keeps the latest 20 captures.

## CLI rules

- `--json` prints one compact JSON value to stdout.
- `--fields id,name,renders` prints selected records as JSONL.
- `batch` uses one connection and prints JSONL by default. `batch --ndjson` is explicit JSONL. `batch --json` prints one JSON array.
- CLI-owned JSON envelopes include `schemaVersion`. Raw successful tool results follow that tool's advertised output schema.
- Machine-mode failures keep stdout as valid JSON and include a stable `reason` plus a safe next command when recovery is known.
- `devtools_wait` waits for a connection, component, exact query, or navigation. Prefer it to polling.
- `[busy]` means the app's main thread is blocked. Wait for the returned delay and try again.

The job is done only when the UI test passes, the live Genie evidence supports the result, and temporary runtime state has been restored.
