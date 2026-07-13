# Genie React

[![npm version](https://img.shields.io/npm/v/genie-react.svg)](https://www.npmjs.com/package/genie-react)
[![npm downloads](https://img.shields.io/npm/dm/genie-react.svg)](https://www.npmjs.com/package/genie-react)
[![CLI](https://img.shields.io/npm/v/@genie-react/cli.svg?label=%40genie-react%2Fcli)](https://www.npmjs.com/package/@genie-react/cli)
[![CI](https://github.com/y0u-0/genie-react/actions/workflows/ci.yml/badge.svg)](https://github.com/y0u-0/genie-react/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/genie-react.svg)](./LICENSE)

> Live DevTools for your running React + TanStack app — driven from the terminal by your AI agent, through one CLI.

AI coding agents work blind: they read source code and guess what the running app does. Genie removes the guessing. It connects your agent (Claude Code, Codex, OpenCode, …) to the app's live DevTools — React internals, TanStack Query, TanStack Router, and any custom devtools built on TanStack — so the agent can **see** what's happening and **act** on it.

That closes the loop. The agent makes a change, checks the real app, and confirms the change works — finds what's slow, fixes it, proves the fix — without you relaying screenshots or console output.

One command drives everything:

```bash
genie-react call <tool> '<json>'
```

## Install

Dev-only. Never ships to production.

```bash
pnpm add -D genie-react     # everything app-side: collectors, <Genie />, Vite plugin, hub
npx @genie-react/cli init   # detects your setup and wires it
pnpm dev                    # start your app
```

`init` adapts to your framework. The same tools work everywhere.

### Vite

Covers TanStack Start, plain React, and any Vite-based framework. `init` adds the `genie()` plugin: the hub rides the dev server (loopback only, no extra port) and the client is injected automatically. Router/Start apps also get one line near the app root:

```tsx
import { Genie } from 'genie-react'

{import.meta.env.DEV && <Genie />}
```

`<Genie />` finds your Router and QueryClient on its own. If yours live somewhere unusual, pass them in: `<Genie queryClient={queryClient} router={router} />`.

### Next.js

`init` adds `<GenieScript />` to your root layout and creates `instrumentation.ts`, which starts a standalone hub alongside `next dev`. The hub serves the browser client to the page as one classic script.

### Other bundlers (CRA, Parcel, Rsbuild, …)

Run `npx @genie-react/cli hub` and add one line first in `<head>`:

```html
<script src="http://localhost:4390/__genie/client.js"></script>
```

The tag ships the React + memory tools. To add the Query/Router tools, compose the client in your own bundle instead, passing your own instances:

```ts
import 'genie-react/hook' // first import, before React
import { createGenieClient, reactCollector, sessionCollector } from 'genie-react/client'
import { memoryCollector, queryCollector } from 'genie-react/collectors'
import { queryClient } from './query-client' // the instance your <QueryClientProvider> renders with

createGenieClient({
  url: 'ws://localhost:4390/__genie/ws',
  collectors: [sessionCollector(), reactCollector(), memoryCollector(), queryCollector(queryClient)],
}).start()
```

### React Native / Expo

`genie-react/native` wires the DOM-free collectors (React, memory, perf, plugins) and takes your TanStack instances by value, so it loads under Metro whether or not TanStack is installed. Needs Metro with `package.json` exports enabled (React Native 0.79+ / Expo SDK 53+).

Run the hub on your dev machine (`npx @genie-react/cli hub`), then start Genie from your app entry, dev-only:

```tsx
import { Genie } from 'genie-react/native'

// iOS simulator: 127.0.0.1, Android emulator: 10.0.2.2, physical device: your machine's LAN IP
// Use 127.0.0.1, not localhost — the hub binds IPv4 loopback, and some runtimes resolve localhost to IPv6 (::1) first.
{__DEV__ && <Genie url="ws://127.0.0.1:4390/__genie/ws" />}
```

Or start it imperatively (e.g. in `index.js`, before `registerRootComponent`): `if (__DEV__) startGenie({ url: 'ws://127.0.0.1:4390/__genie/ws' })`. Pass `queryClient` / `router` on any render to add the Query/Router tools — Genie registers them onto the running client.

Almost everything works as on the web. The differences: `react_dom_for_component` reports native views with their `testID` / accessibility props (there are no CSS selectors); `browser_get_memory` needs RN 0.85+ (Hermes exposes `performance.memory` there); `react_component_for_dom` needs a DOM and is unavailable.

## Drive it

```bash
npx @genie-react/cli status --sessions-only    # connected once a browser opens the app
npx @genie-react/cli tools                     # group index; drill in: tools <group> / tools <tool>
npx @genie-react/cli call react_get_renders '{"sort":"renders"}'
npx @genie-react/cli call react_render_causes '{"component":"Checkout"}'
npx @genie-react/cli call query_list '{}'
npx @genie-react/cli call router_navigate '{"to":"/dashboard"}'
```

Run the CLI from the app directory. From a workspace root, it selects the only live Genie bridge. If several apps are live, it stops and lists each bridge instead of guessing.

Render reports name the exact cause: a prop, state hook, context, query, router update, parent render, or mount. They also show a small value diff, for example `state[0] false→true`.

Give each browser tab a stable name when several agents or tabs share a hub:

```text
http://localhost:3000/?_genie=my-agent
```

Then pass `--session my-agent`, or set `GENIE_SESSION=my-agent` once. The same target keeps working after navigation, reloads, and reconnects—even when the route removes `_genie` from the URL.

If connection startup is unclear, add `--verbose`. Diagnostics go to stderr, so JSON stdout stays clean. `--connect-timeout <ms>` bounds the bridge connection without changing the tool timeout.

Wait for exact state instead of sleeping:

```bash
npx @genie-react/cli call devtools_wait \
  '{"condition":"query-settled","queryKey":["demo","greeting"]}'
```

Query waits accept an exact `queryHash` or structured `queryKey`. Legacy names are exact too; partial text never matches. `router_get_state` returns Router state and browser history together, with `locationSync` set to `matched`, `mismatched`, or `unavailable`.

For a dense React tree, find a component and read only that mounted subtree:

```bash
npx @genie-react/cli call react_find_components '{"query":"Checkout","exact":true}'
npx @genie-react/cli call react_get_tree '{"rootId":42,"depth":3,"maxNodes":100}'
```

Machine output is bounded and pipeable. `--json` writes one JSON value. `batch` writes JSONL by default; `--ndjson` makes that choice explicit, while `batch --json` writes one array. CLI-owned status, batch, and error envelopes include `schemaVersion`; successful tool payloads keep each tool's advertised schema.

`npx @genie-react/cli doctor` checks the wiring; `doctor --live` also probes the running hub, the served client, and a session round-trip. Stale `.genie/bridge.json` files left by a killed dev server are cleaned up automatically.

## Prove a change with captures

A capture records one bounded view of React, effects, Query, Router, memory, and optional frame-rate data.

```bash
npx @genie-react/cli call react_clear_renders '{}'
# Drive one exact flow.
npx @genie-react/cli call devtools_capture_create '{"name":"before-1"}' --json
```

Repeat the same flow at least three times before and three times after the change. Compare the returned capture IDs:

```bash
npx @genie-react/cli call devtools_capture_compare \
  '{"baselineCaptureIds":["<before-1>","<before-2>","<before-3>"],"candidateCaptureIds":["<after-1>","<after-2>","<after-3>"],"metrics":["react.renders","react.selfTimeMs"],"budgets":[{"metric":"react.renders","maxRegressionPct":0}]}'
```

The result includes sample counts, median, p95, spread, and a clear budget verdict. Small or missing samples are `insufficient-data`, never a false pass. The hub keeps the latest 20 captures, so export important JSON results.

## Try a change before it ships

Every pull request and every push to `main` publishes preview builds to [pkg.pr.new](https://pkg.pr.new) — no npm release required. The Preview Release workflow comments ready-to-copy URLs on each PR:

```bash
pnpm add -D https://pkg.pr.new/genie-react@<sha>
npx https://pkg.pr.new/@genie-react/cli@<sha> status
```

## Give your agent the skill

Install the [agent skill](https://github.com/vercel-labs/skills) so your agent knows when and how to use Genie:

```bash
npx skills add y0u-0/genie-react
```

## Use with agent-browser & agent-device

Genie is the eyes — it reads what happens underneath the pixels: renders, effects, hooks, queries, errors no screenshot can show. Pair it with the hands that drive the UI:

- **Web** — [agent-browser](https://github.com/vercel-labs/agent-browser) opens the app, clicks, types, and takes screenshots.
- **React Native** — [agent-device](https://github.com/callstack/agent-device) taps, types, and screenshots the simulator or device.

Together your agent closes the loop on its own: make a change, drive the app, read why, then fix or optimize — verifying its own work end to end.

## What you get

**See** —

- the component tree; find components by name
- a component's props, state, hooks (each labeled: state / reducer / memo / callback / ref / effect), and the contexts it consumes
- the DOM node(s) a component renders, each with a selector
- what re-rendered, how often, and why — including unstable props that defeat `memo`
- the causal event behind each render: props, state, context, query, router, or parent
- which effects fired, who owns them, and whether enough samples prove they are hot
- caught errors and suspended boundaries — why a screen is blank or stuck
- a profiler: slowest, most re-rendered, most wasted on unstable props
- the TanStack Query cache: staleness, observers, refetch storms, cache churn
- the Router: state, matches, params, loaders
- the browser JS heap

**Do** —

- navigate, preload, and invalidate routes
- invalidate / refetch / reset / remove / setData / cancel / fetch / ensure queries
- simulate a query's pending or error state, then restore its exact prior state
- re-run a mutation
- override a component's props, hook state, or a context value
- force a Suspense fallback or an error boundary — hold loading / error UI open to inspect it, no code edits
- list every active override and reset them all
- create named runtime captures and compare repeated before/after runs against typed budgets

## Tools

The available tool count depends on the collectors in the running app. `read` tools are safe to call freely; `action` tools mutate the running app. Each tool documents itself — `tools <group>` lists a group, `tools <tool>` prints the full schema — so here are just the names:

**React** — read: `react_get_tree`, `react_find_components`, `react_inspect_component`, `react_inspect_context`, `react_dom_for_component`, `react_component_for_dom`, `react_get_renders`, `react_render_causes`, `react_clear_renders`, `react_effect_audit`, `react_error_state`, `react_refresh_events`, `react_profile_start`, `react_profile_stop`, `react_profile_report`, `react_profile_snapshot`, `react_renders_diff`, `react_list_overrides`. action: `react_override_props`, `react_override_hook_state`, `react_override_context`, `react_toggle_suspense_fallback`, `react_force_error_boundary`, `react_reset_overrides`.

**Query** — read: `query_list`, `query_get`, `query_get_data`, `query_is_fetching`, `query_list_mutations`, `mutation_get`. action: `query_invalidate`, `query_refetch`, `query_cancel`, `query_reset`, `query_remove`, `query_clear`, `query_set_data`, `query_simulate_state`, `query_restore_state`, `query_fetch`, `query_ensure`, `mutation_rerun`.

**Router** — read: `router_get_state`, `router_list_matches`, `router_list_routes`, `router_build_location`, `router_match_route`. action: `router_navigate`, `router_preload`, `router_load`, `router_invalidate`, `router_clear_cache`, `router_history`.

**Plugin passthrough** — read: `plugin_list`, `plugin_get_events`. action: `plugin_emit`. Discovery is traffic-based; declare silent plugins up front with `<Genie plugins={['cart-devtools']} />` so they're listed before their first event.

**Memory** — read: `browser_get_memory`, `browser_measure_memory` (Chromium only).

**Perf** — read: `browser_fps` (frame-rate sample with a smooth / degraded / janky verdict).

**Meta** — read: `devtools_status`, `devtools_wait`, `devtools_capture_create`, `devtools_capture_list`, `devtools_capture_read`, `devtools_capture_compare`.

## How it works

Collectors in the browser (React, Query, Router, plugins, memory) run tool calls against the real fibers and caches, and talk over a WebSocket to a small hub — embedded in your Vite dev server, or standalone (`genie-react hub` / Next.js `instrumentation.ts`), where it also serves the browser client as a single script. The CLI connects to that hub, runs tools, and prints JSON.

Several tabs, apps, and agents coexist. Calls hit the most recent tab unless you target a physical session ID, a durable logical ID, or a unique name from `?_genie=<name>`. `genie-react status` shows readiness and every session; `--sessions-only` keeps that response small. Set `GENIE_SESSION` once to pin an agent to its tab. A reconnect keeps the logical identity and stable name. A standalone hub identifies the app it serves, so a second app's hub walks to the next free port instead of cross-connecting, and each app's `.genie/bridge.json` pins its CLI to its own hub.

Dev-only and local: the Vite plugin is inert in production builds, the browser client only starts under `import.meta.env.DEV`, and the hub listens on `localhost` only.

## Packages

| Package / export | What it is |
| --- | --- |
| `genie-react` | `<Genie />` component |
| `genie-react/vite` | Vite plugin |
| `genie-react/script` | `<GenieScript />` for any SSR root layout |
| `genie-react/next` | Next.js helpers |
| `genie-react/native` | React Native / Expo entry |
| `genie-react/client`, `genie-react/hook` | the injected browser client |
| `genie-react/collectors` | every collector, for manual composition |
| `genie-react/hub` | the WebSocket hub |
| `genie-react/protocol` | the wire protocol |
| `@genie-react/cli` | the agent interface: `init` / `doctor` / `link`, `status` / `tools` / `call` |

MIT © Genie React Agent contributors
