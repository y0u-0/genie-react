---
name: genie
description: Drive live DevTools on a RUNNING React + TanStack app from the shell via the `genie` CLI. Use to diagnose why a component re-renders or wastes renders, an effect that re-runs or loops (refetch/setState storms), why a page is blank or stuck (caught errors, suspended boundaries), live component props/state/hooks, the TanStack Query cache, or TanStack Router state — and to invalidate/refetch/navigate or override props on the running app. Pairs with agent-browser (it drives the UI; genie reads the React internals the DOM can't show). Not for static source reading.
---

# genie

`genie` is your **eyes on the live app** — the React fiber tree, why-did-render, effect firings, caught errors, suspended boundaries, the TanStack Query cache and Router state of the *actually running* dev server. Source and the DOM can't show these; genie can.

`genie` in every command below is the CLI: run it as **`npx @genie-react/cli`** (a bare `npx genie` is a *different* npm package), or as the local `genie` bin once installed (`pnpm genie`, `./node_modules/.bin/genie`).

## Set it up (once)

Dev-only — never ships to production. Wire it into the app you want to inspect:

```bash
pnpm add -D genie-react     # 1. everything app-side in one package
npx @genie-react/cli init   # 2. add the genie() plugin to the Vite config
```

Then one line near the app root, and start the dev server:

```tsx
import { Genie } from 'genie-react'
// in your root layout:
{import.meta.env.DEV && <Genie />}
```

The bridge rides Vite's dev server (loopback only, no extra port). `npx @genie-react/cli doctor` diagnoses a broken wiring; `init` only edits the Vite config.

## Connect first

```bash
genie status     # bridge live + app connected? Also prints the bridge URL + a ready-to-paste call.
```

Collectors run **in the browser**, so a `react_*` read is empty until a browser has opened the app and mounted it. Not connected → the dev server isn't running with the `genie()` plugin, or no browser is on the page. From another directory, pass the URL `genie status` printed: `genie --url ws://localhost:5173/__genie/ws call …` (or `export GENIE_BRIDGE_URL=…`) — no `cd` needed.

## The loop

Every measurement runs **clear → drive → read**, so the numbers mean *one* interaction instead of the whole session:

1. `genie call react_clear_renders '{}'` — reset counters right before the interaction you care about (clears renders, effects, and error state).
2. **Drive** it — agent-browser clicks/types, or the user reproduces. A `react_*` reading is empty until something has rendered.
3. **Read** the tool for the symptom, then act.

Skip the clear and counts blend mount plus every prior commit.

## Tools by symptom

Output is a compact text summary by default; add `--json` for the raw blob. `genie tools` prints the authoritative live catalog with argument schemas. Reach for:

- **Re-renders / jank** (you have a suspect component) → `react_get_renders` (why-did-render: which prop/state changed, unstable refs, unnecessary vs wasted renders, Compiler status, self-time, each component's `file:line`).
- **Slow flow / where's the cost?** (offender unknown, whole interaction) → `react_profile_start` (clears counters for you) → drive the flow → `react_profile_report` — four leaderboards: slowest by self-time, most re-rendered, most unnecessary renders, most renders wasted on unstable-reference props. `'{"limit":N}'` sizes each list. Then drill into a named offender with `react_get_renders`.
- **Effects re-running / loops** (refetch or setState storms) → `react_effect_audit` (did each effect fire, deps mode, the dep slot that changed, cleanup, and each effect's own `file:line` — an effect created inside a library hook resolves to that library, not your component; `'{"onlyHot":true}'` for just the smells).
- **Blank / stuck page** → `react_error_state` (which error boundary caught what, the throwing component + message + `file:line`, plus suspended boundaries — a caught error or a suspended subtree is invisible to a tree/DOM snapshot).
- **A specific component** → `react_find_components` → `react_inspect_component` (props/state/hooks), `react_inspect_context` (the contexts it consumes + their current values, invisible from source), `react_dom_for_component` (the live DOM node(s) it renders, each with a selector a browser tool can act on); `react_get_tree` for structure; `react_override_props` to force a UI state.
- **TanStack Query** → read with `query_list`/`query_get`/`query_get_data`; act with `query_invalidate`/`refetch`/`reset`/`set_data`.
- **TanStack Router** → read with `router_get_state`/`router_list_matches`; act with `router_navigate`/`router_invalidate`.

`react_get_renders`, `react_effect_audit`, and `react_get_tree` show **your own code by default** and hide library noise (Base UI, cmdk, devtools) — `react_effect_audit` also drops the effects libraries schedule on your components (e.g. TanStack Query's `useSyncExternalStore`), so a data component stops reporting effects it never wrote. Pass `'{"appOnly":false}'` to include library code (labeled by its `file:line`, tagged `· lib`). Args are a JSON string: `genie call react_get_renders '{"sort":"unnecessary"}'`.

## Hands and eyes

agent-browser is the **hands** (open, click, type, screenshot); genie is the **eyes** (the React/Query/Router internals behind the pixels). agent-browser reproduces and times an interaction; genie explains *why* — the offending component at its `file:line`, the unstable prop, the looping effect, the caught error, the stale query. Use them together.
