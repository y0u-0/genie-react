# Genie React

> Live DevTools for your running React + TanStack app — driven from the terminal by your AI agent, through one CLI.

The idea is simple: give your AI coding agent the same view into the running app that you have as an engineer — so it doesn't have to guess from the source code, or wait for you to describe what's happening. Genie connects the agent (Claude Code, Codex, OpenCode, PI, etc.) to your app's live DevTools while it runs. It can **see** what's going on and **act** on it, across everything you'd normally open by hand: all of TanStack's DevTools (Query, Router, with more on the way), any custom devtools you've built on top of TanStack, and React's own internals — which components rendered and why, what's slow, what data is loaded, and more. Taking that back-and-forth out of the way lets the agent work on its own and, most importantly, check its own work end to end: it can confirm a change really works, find what's slow, and improve performance against the real app instead of hoping the code is right.

One command drives everything: `genie call <tool> '<json>'`.

## Install

Dev-only. Never ships to production.

```bash
pnpm add -D @genie-react/react @genie-react/vite   # the packages you import
npx @genie-react/cli init                          # add the Vite plugin
pnpm dev                                           # start your app
```

Add one line near your app root:

```tsx
import { Genie } from '@genie-react/react'

{import.meta.env.DEV && <Genie />}
```

Then drive it:

```bash
npx @genie-react/cli status     # connected once a browser opens the app
npx @genie-react/cli tools      # list the tools the live app exposes
npx @genie-react/cli call react_get_renders '{"sort":"renders"}'
npx @genie-react/cli call query_list '{}'
npx @genie-react/cli call router_navigate '{"to":"/dashboard"}'
```

The bridge rides Vite's dev server — loopback only, no extra port. Run `npx @genie-react/cli doctor` to check the wiring.

## Give your agent the skill

Install the [agent skill](https://github.com/vercel-labs/skills) so your agent knows when and how to use Genie:

```bash
npx skills add y0u-0/genie-react
```

## Pair with agent-browser

[agent-browser](https://github.com/vercel-labs/agent-browser) is the hands — it opens the app, clicks, types, and takes screenshots. Genie is the eyes — it reads what happens underneath, the renders, effects, queries, and errors the page can't show. Together your agent closes the loop on its own: make a change, drive the app, check the result, then fix or optimize — verifying its own work end to end, without you in the middle.

## What you get

**See** —

- the component tree; find components by name
- a component's props, state, hooks, and the contexts it consumes
- the DOM node(s) a component renders, each with a selector
- what re-rendered, how often, and why — including unstable props that defeat `memo`
- which effects fired and why — catches refetch / setState loops
- caught errors and suspended boundaries — why a screen is blank or stuck
- a profiler: slowest, most re-rendered, most wasted on unstable props
- the TanStack Query cache: staleness, observers, refetch storms, cache churn
- the Router: state, matches, params, loaders
- the browser JS heap

**Do** —

- navigate, preload, and invalidate routes
- invalidate / refetch / reset / remove / setData / cancel / fetch / ensure queries
- re-run a mutation
- override a component's props, hook state, or a context value
- force a Suspense fallback or an error boundary — hold loading / error UI open to inspect it, no code edits

50 tools total. `read` is safe to call freely; `action` mutates the running app.

## Tools

**React** — `react_get_tree`, `react_find_components` (tree); `react_inspect_component` (props / state / hooks), `react_inspect_context` (consumed contexts + values), `react_dom_for_component` (DOM element(s) + selectors); `react_get_renders`, `react_clear_renders` (why-did-render), `react_effect_audit` (which effects fired), `react_error_state` (errors / suspended); `react_profile_start`, `react_profile_report` (profiler) — read. `react_override_props`, `react_override_hook_state`, `react_override_context` (drive props / hook state / context), `react_toggle_suspense_fallback`, `react_force_error_boundary` (hold loading / error UI open) — action.

**Query** — read: `query_list`, `query_get`, `query_get_data`, `query_is_fetching`, `query_list_mutations`, `mutation_get`. action: `query_invalidate`, `query_refetch`, `query_cancel`, `query_reset`, `query_remove`, `query_clear`, `query_set_data`, `query_fetch`, `query_ensure`, `mutation_rerun`.

**Router** — read: `router_get_state`, `router_list_matches`, `router_list_routes`, `router_build_location`, `router_match_route`. action: `router_navigate`, `router_preload`, `router_load`, `router_invalidate`, `router_clear_cache`, `router_history`.

**Plugin passthrough** — read: `plugin_list`, `plugin_get_events`. action: `plugin_emit`.

**Memory** — read: `browser_get_memory`, `browser_measure_memory` (Chromium only).

**Meta** — read: `devtools_status`, `devtools_wait`.

## How it works

Collectors in the browser (React, Query, Router, plugins, memory) run tool calls against the real fibers and caches, and talk over a WebSocket to a small hub on your Vite dev server. The `genie` CLI connects to that hub, runs tools, and prints JSON.

Several tabs can be connected at once: calls hit the most recent, `genie status` lists every session, and `--session <id>` targets a specific tab — so parallel agents can each drive their own.

Dev-only and local: the Vite plugin is inert in production builds, the browser client only starts under `import.meta.env.DEV`, and the hub listens on `localhost` only.

## Packages

- `@genie-react/core` — types, tool contracts, wire protocol, serializer
- `@genie-react/react-collector` — React tree, inspect, render tracking, profiling (bippy + react-scan)
- `@genie-react/tanstack-collector` — Query + Router reads and actions
- `@genie-react/devtools-plugin` — TanStack DevTools event-bus passthrough
- `@genie-react/memory` — browser JS heap readings
- `@genie-react/react` — the one-line `<Genie />` component
- `@genie-react/client` — orchestrates collectors, runs tool calls
- `@genie-react/bridge` — the hub: WS server, request router
- `@genie-react/vite` — mounts the hub on Vite, injects the client
- `@genie-react/cli` — the agent interface: `init` / `doctor` / `link`, `status` / `tools` / `call`

MIT © Genie React Agent contributors
