---
name: genie
description: Drive live DevTools on a RUNNING React (web or React Native) + TanStack app from the shell via the `genie-react` CLI. Use to diagnose why a component re-renders or wastes renders, an effect that re-runs or loops (refetch/setState storms), why a page is blank or stuck (caught errors, suspended boundaries), live component props/state/hooks, the TanStack Query cache, or TanStack Router state; to override props/hook state/context or force loading/error UI on the running app; to prove a perf fix with a before/after render diff; and to invalidate/refetch/navigate. Pairs with agent-browser on web and agent-device on React Native (they drive the UI; genie reads the React internals the pixels can't show). Not for static source reading.
---

# genie

Genie is your **eyes on the live app** — the React fiber tree, why-did-render, effect firings, caught errors, suspended boundaries, the TanStack Query cache and Router state of the *actually running* dev server. Source and the DOM can't show these; genie can.

`genie-react` in every command below is the CLI: run it as the installed bin (`pnpm genie-react`, `./node_modules/.bin/genie-react`) or **`npx @genie-react/cli`** with no install.

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

The bridge rides Vite's dev server (loopback only, no extra port). **Cloudflare** (`@cloudflare/vite-plugin` in the config): `genie()` detects it and moves the bridge to a standalone hub automatically — workerd drops that port's WebSocket upgrades — nothing extra to wire; `genie-react status` finds the hub. **Next.js**: the same `init` instead wires `<GenieScript />` into the root layout and creates `instrumentation.ts`, which starts a standalone hub on port 4390 with `next dev`. **Any other non-Vite React app**: run `npx @genie-react/cli hub`, then add `<script src="http://localhost:4390/__genie/client.js"></script>` first in `<head>`. **React Native / Expo**: run `npx @genie-react/cli hub`, then `import { Genie } from 'genie-react/native'` and render `{__DEV__ && <Genie url="ws://localhost:4390/__genie/ws" />}` (iOS sim: localhost, Android emulator: 10.0.2.2, physical device: your machine's LAN IP); pass `queryClient`/`router` to add the TanStack tools (on any render — late instances register onto the running client; needs RN 0.79+ / Expo SDK 53+). There is no DOM, so `react_dom_for_component` reports the native view(s) by `testID`/accessibility props, while `react_component_for_dom` is unavailable (`browser_get_memory` works where Hermes exposes `performance.memory`, RN 0.85+). Drive the app with agent-device (the RN hands) instead of agent-browser (web). `npx @genie-react/cli doctor` diagnoses a broken wiring in every setup; `doctor --live` additionally probes the running hub, the served client, and a session round-trip.

## Connect first

```bash
genie-react status     # bridge live + app connected? Also prints the bridge URL + a ready-to-paste call.
genie-react call devtools_wait '{"condition":"connected"}'   # block until the app connects instead of polling
```

Collectors run **in the browser**, so a `react_*` read is empty until a browser has opened the app and mounted it. Not connected → the dev server isn't running with the `genie()` plugin, or no browser is on the page. From another directory, pass the URL `genie-react status` printed: `genie-react --url ws://localhost:5173/__genie/ws call …` (or `export GENIE_BRIDGE_URL=…`) — no `cd` needed. Parallel work is safe: multiple agents can share one hub (`--session` targets a tab), and hubs for different apps never collide — a busy port walks upward and each app's `.genie/bridge.json` points at its own hub. **Several agents, same app**: each agent owns a tab — open the app with a marker (`http://localhost:3000/?_genie=<your-name>`), find your sessionId by that url in `genie-react status`, then `export GENIE_SESSION=<id>` once; every later call is pinned. Never measure a tab another agent owns: `clear`/profiler/override state is per-page.

## The loop

Every measurement runs **clear → drive → read**, so the numbers mean *one* interaction instead of the whole session:

1. `genie-react call react_clear_renders '{}'` — reset counters right before the interaction you care about (clears renders, effects, and error state).
2. **Drive** it — agent-browser clicks/types, or the user reproduces. A `react_*` reading is empty until something has rendered.
3. **Read** the tool for the symptom, then act.

Skip the clear and counts blend mount plus every prior commit.

**Verifying a fix**: `react_profile_snapshot '{"label":"pre"}'` → apply the change → repeat the *identical* drive → `react_renders_diff '{"baseline":"pre"}'`. The diff is a machine verdict — total self-time delta with pct, `regressed[]`/`improved[]` sorted by impact, `added`/`removed` — not two dumps to eyeball. `clearsSinceBaseline` in the result tells you what you compared: `0` = the baseline shares this session (after includes before); `≥1` = counters were cleared in between (session-vs-session — only meaningful if both sessions drove the same interaction). A fix that doesn't move the numbers gets reverted.

## Tools by symptom

Output is a compact text summary by default; add `--json` for the raw (compact) blob. Discover tools progressively instead of dumping the catalog: `genie-react tools` (group index) → `genie-react tools <group>` (that group's params) → `genie-react tools <tool>` (full description + a runnable example); `--all` prints everything. Reach for:

- **Re-renders / jank** (you have a suspect component) → `react_get_renders` (why-did-render: changed prop names plus exact `state[n]`/`reducer[n]` slots with bounded before→after values, unstable refs, unnecessary vs wasted renders, Compiler status, self-time, each component's `file:line`).
- **Slow flow / where's the cost?** (offender unknown, whole interaction) → `react_profile_start` (clears counters for you) → drive the flow → `react_profile_report` — four leaderboards: slowest by self-time, most re-rendered, most unnecessary renders, most renders wasted on unstable-reference props. `'{"limit":N}'` sizes each list; `react_profile_stop` freezes counters between reads. Then drill into a named offender with `react_get_renders`.
- **Prove a perf fix** → `react_profile_snapshot` before, `react_renders_diff` after (see "Verifying a fix" above) — the regressed/improved verdict replaces hand-diffing two dumps.
- **Effects re-running / loops** (refetch or setState storms) → `react_effect_audit` (did each effect fire, deps mode, the dep slot that changed, cleanup, and each effect's own `file:line` — an effect created inside a library hook resolves to that library, not your component; `'{"onlyHot":true}'` for just the smells).
- **Blank / stuck page** → `react_error_state` (which error boundary caught what, the throwing component + message + `file:line`, plus suspended boundaries — a caught error or a suspended subtree is invisible to a tree/DOM snapshot).
- **A specific component** → `react_find_components` → `react_inspect_component` (props/state/hooks), `react_inspect_context` (the contexts it consumes + their current values, invisible from source), `react_dom_for_component` (the live DOM node(s) it renders, each with a selector a browser tool can act on); `react_get_tree` for structure.
- **A specific DOM element** (a selector agent-browser found, a button that renders wrong) → `react_component_for_dom` maps it to the owning component: id (feed to inspect/overrides), props, and source `file:line` — "whose pixel is this?" answered in one call.
- **Force a UI state without code edits** → `react_override_props`, `react_override_hook_state`, `react_override_context`; hold loading/error UI open with `react_toggle_suspense_fallback` / `react_force_error_boundary`. Hooks are labeled in `react_inspect_component` (`kind: state/reducer/memo/callback/ref/effect` + `stateIndex` on the stateful ones) — target by `stateIndex` (ordinal among stateful hooks, survives library-hook noise) or flat `hookIndex`; a wrong target errors with the full stateful-hook list to pick from. The suspense toggle resolves the nearest boundary ABOVE the id you pass — pass a component inside the target boundary, or you may catch a router's code-split boundary (blank route).
- **What's overridden / undo everything** → `react_list_overrides` (every active override with its captured original and mounted state) and `react_reset_overrides` (restores props/context originals, releases forced boundaries — works even when a forced subtree re-mounted and its old id is gone, so it is the recovery for a stuck forced error; no reload needed).
- **TanStack Query** → read with `query_list`/`query_get`/`query_get_data`; act with `query_invalidate`/`refetch`/`reset`/`set_data`. Query tools appear when `<Genie />` can see a QueryClient — an explicit `<Genie queryClient={qc} />` prop, the router context, or any surrounding `QueryClientProvider`.
- **TanStack Router** → read with `router_get_state`/`router_list_matches`; act with `router_navigate`/`router_invalidate`. (Query/Router tools appear on Vite apps rendering `<Genie />`; the script-tag/Next.js path exposes the React + memory tools unless the app composes its own client — see the README's manual-composition snippet.)
- **Custom devtools plugins** (TanStack event bus) → `plugin_list` / `plugin_get_events`; act with `plugin_emit` (a bare `type` is auto-prefixed with the pluginId). Discovery is traffic-based — declare silent plugins with `<Genie plugins={['cart-devtools']} />` to list them before their first event.
- **Browser memory** → `browser_get_memory` / `browser_measure_memory` (Chromium only).
- **Frame rate / dropped frames** (is it actually janky, and how badly?) → `browser_fps` samples rAF for `durationMs` (default 5s) and returns avg fps, dropped frames vs the display's refresh rate (fair on 120Hz panels), long frames (>50ms), the single worst stall, and a smooth/degraded/janky verdict. Page-wide, not React-specific — start the animation/interaction first (the sample blocks for its duration), then pair a bad verdict with `react_get_renders`/`react_profile_report` to name the offender. The tab must be visible; `hidden:true` in the result means the numbers are unreliable.

`react_get_renders`, `react_effect_audit`, and `react_get_tree` show **your own code by default** and hide library noise (Base UI, cmdk, devtools) — `react_effect_audit` also drops the effects libraries schedule on your components (e.g. TanStack Query's `useSyncExternalStore`), so a data component stops reporting effects it never wrote. When the filter hid anything, the result says so (`0 app effects (37 library effects hidden — set appOnly:false to include)`) — an empty filtered read is never "none exist". Pass `'{"appOnly":false}'` to include library code (labeled by its `file:line`, tagged `· lib`). Args are a JSON string: `genie-react call react_get_renders '{"sort":"unnecessary"}'`. The react tools accept `component`/`query`/`name` interchangeably for their component-name arg; any other unknown key is rejected with the valid keys listed.

**CLI mechanics for agents**: `--fields id,name,renders` projects the result to JSONL (one object per row — top-level keys win when present, else the first array-of-records; zero matches = zero rows). `genie-react batch '[{"tool":…,"args":…},…]'` runs many calls on one connection (one JSON line each, continue-on-error, exit 1 if any failed). `--timeout <ms>` bounds one call (clamped 1s–120s). Failures carry a typed code — `[busy]` means the app's main thread is blocked, not crashed: wait the suggested `retry in 500ms` and re-call; `[timeout]`/`[not-connected]`/`[unknown-session]`/`[tool-error]` each name their own fix.

## Hands and eyes

agent-browser (web) or agent-device (React Native) is the **hands** — open, click/tap, type, screenshot; genie is the **eyes** (the React/Query/Router internals behind the pixels). The hands reproduce and time an interaction; genie explains *why* — the offending component at its `file:line`, the unstable prop, the looping effect, the caught error, the stale query. Use them together.
