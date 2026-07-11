# genie-react

## 0.6.1

### Patch Changes

- 156b50c: Add concise package READMEs, clearer npm descriptions, and focused search keywords.

## 0.6.0

### Minor Changes

- 006dc90: Upgrade to Bippy 0.6 and add `react_refresh_events` with state-preservation/remount details, source-cache invalidation, HMR-safe instrumentation teardown, and refresh-aware profiling.
- 006dc90: Add reversible `query_simulate_state` and `query_restore_state` tools for inspecting TanStack Query pending and error UI without editing application code.

## 0.5.2

### Patch Changes

- f205bb8: Pack releases with pnpm before publishing through npm so internal workspace dependencies resolve to installable versions.

## 0.5.1

### Patch Changes

- 32edfea: Pack releases with pnpm before publishing through npm so internal workspace dependencies resolve to installable versions.

## 0.5.0

### Minor Changes

- 3413d52: Make render causes actionable: `react_get_renders` now identifies each changed `useState`/`useReducer` slot, its flat and stateful hook positions, and bounded before/after values. Class state is reported separately, non-state hook internals are excluded, and the CLI prints compact value diffs while remaining compatible with older generic state markers.

### Patch Changes

- 922b635: Faster tools on large React trees: tree reads cached between commits, O(depth) fiber lookups instead of full-tree scans, LRU id registry (no more clear-all overflow), and source classification that skips cached fibers and warms in the background.

## 0.4.0

### Minor Changes

- 8d4d7bf: Better agent experience: typed errors with retry hints, fast busy detection, hook kinds and overrides by stateful index, override list/reset, render snapshot/diff, CLI `batch` / `--fields` / `--timeout`, and one bin name: `genie-react`.
- 5314fbf: Add React Native / Expo support.

  - New `genie-react/native` entry (`startGenie()` + `<Genie />`) that composes the DOM-free collectors and takes TanStack instances by value, so it bundles under Metro whether or not TanStack is installed (RN 0.79+ / Expo SDK 53+). Instances are duck-validated with a loud skip on mismatch, and a `queryClient`/`router` passed on a later call or render registers onto the running client instead of being dropped.
  - `findRootFiber()` now falls back to the live roots captured from bippy's commit hook when there is no DOM, so every React tool works in React Native. Roots are tracked per `FiberRoot` and dropped on unmount: the first-mounted root wins (a dev-overlay root like LogBox can't hijack the tools), an unmounted tree is never reported, and nothing is retained after teardown. Web still seeds from the DOM first.
  - `react_dom_for_component` describes native host views (fiber type + `testID` / accessibility props) instead of returning empty on non-DOM hosts, including text from string, number, and interpolation-array children.
  - The web and native entries now compose their default collectors from one shared list, so future collectors ship to both platforms.

### Patch Changes

- 8c945ed: `react_error_state` now includes boundaries held open by `react_force_error_boundary` / `react_toggle_suspense_fallback`, flagged `forced: true` (real errors/suspends are `forced: false`), so a forced state is visible without cross-checking `react_list_overrides`.

## 0.3.0

### Minor Changes

- fc7eb33: New `browser_fps` tool (perf collector): sample the page frame rate on demand via requestAnimationFrame — avg fps, frames dropped against the estimated display refresh rate (fair on 120Hz panels), long frames (>50ms), the single worst stall, and a smooth/degraded/janky verdict using react-scan's thresholds as refresh-rate ratios plus its 150ms hard-stall rule. Registered by `<Genie />` and the script-tag client; the CLI prints a one-line summary. Also bumps bippy to ^0.5.43 (a republish of 0.5.42 — no API changes).

## 0.2.2

### Patch Changes

- 9379751: Fixes from a blind agent field run:

  - Component names resolve through `memo()`/`forwardRef` wrappers: react-refresh's `_c`/`_c2` placeholder names no longer mask a wrapper's `displayName` or the inner function's real name, so renders/errors/find report the component you named — previously, memoizing an arrow component made it drop out of `react_find_components` and show as `_c` in reports, exactly when verifying the memoization fix mattered most.
  - The react tools accept `component`/`query`/`name` interchangeably for their component-name argument (remapped before validation only when unambiguous, so unknown-key rejection still guards everything else).

## 0.2.1

### Patch Changes

- c0c0025: Coexist with `@cloudflare/vite-plugin` (Start-on-Cloudflare apps like tanstack.com): its workerd dev proxy owns the dev port's WebSocket upgrades and drops genie's socket within milliseconds (close 1006, permanent reconnect flap). The `genie()` plugin now detects the Cloudflare plugin in the resolved config and reroutes transport automatically — it starts a standalone hub on its own port, points the injected client's WebSocket at it, writes discovery for the CLI accordingly, and shuts the hub down with the dev server (a killed server heals via the existing stale-pid cleanup). No wiring changes: `genie()` + `<Genie />` stay as-is, and existing setups fix themselves on upgrade. `init` prints a note when it sees the Cloudflare plugin in dependencies.
- c0c0025: Harden the attach paths against real-world hosts, from OSS-app field testing (Excalidraw, tanstack.com, Cal.com/react.dev):

  - Vite plugin excludes `genie-react` from dependency pre-bundling so the optional-peer stubs actually apply — importing `<Genie />` no longer black-screens apps without TanStack installed — and pre-lists its nested deps so the first post-install boot connects instead of 504ing on stale optimized-dep hashes.
  - Opt out of ws's optional native addons before ws loads: a host bundler or stale prebuild that half-resolves `bufferutil` crashed the hub with `bufferUtil.unmask is not a function` on Node 22 and 500'd the host app.
  - Tool dispatch rejects unrecognized argument keys (a `maxDepth` typo for `depth` used to no-op silently), formats validation errors readably, and unknown-tool errors now list the advertised domains and explain that query/router tools are gated on a discovered QueryClient/Router.
  - CLI: when no `.genie/bridge.json` exists, say so and call the localhost default a guess instead of presenting it as fact; `doctor --live` reports "no app session connected yet" instead of a warning-glyphed success sentence; hub timeouts hint at busy main threads and `devtools_wait`.
  - `init` adds `.genie/` to `.gitignore` and prints next-steps with the repo's actual package manager instead of hardcoded pnpm.

## 0.2.0

### Minor Changes

- d4f511c: New `react_component_for_dom` tool: a CSS selector resolves to the owning React component(s) with id, props, and source file:line — the reverse of `react_dom_for_component`. `genie doctor --live` probes the running stack end to end (hub HTTP + identity, served client bundle, WS session round-trip). Stale `.genie/bridge.json` files whose pid is gone are announced and removed by both discovery and doctor. Piped `--json` output is no longer truncated at 64KB (natural exit instead of `process.exit`).
- a11e8bf: Consolidate the app-side packages into one `genie-react` package.

  `@genie-react/core`, `client`, `react-collector`, `tanstack-collector`, `devtools-plugin`, `memory`, `react`, `bridge`, and `vite` are replaced by the single `genie-react` package with subpath exports: `genie-react` (the `<Genie />` component), `genie-react/vite` (the plugin), `genie-react/client` + `genie-react/hook` (the injected client), `genie-react/hub` (the standalone bridge), and `genie-react/protocol` (wire protocol + tool contracts).

  Migration: `pnpm add -D genie-react`, then `import { Genie } from 'genie-react'` and `import { genie } from 'genie-react/vite'`. The CLI (`@genie-react/cli`) is unchanged in usage; `genie init`, `doctor`, and `link` now wire the single package.

- 5e60814: Framework-agnostic attach: Next.js support and a standalone hub for any non-Vite React app.

  The hub now serves a self-contained browser client at `GET /__genie/client.js`, so any React setup attaches with one classic script tag — no bundler integration required. New surface: `genie hub` (CLI command, default port 4390), `<GenieScript />` from `genie-react/script` (dev-only script tag for any SSR root layout, RSC-safe), and `genie-react/next` with `registerGenie()` for Next.js `instrumentation.ts`. `genie init` and `doctor` now detect Next.js apps and wire the layout + instrumentation automatically.

### Patch Changes

- ac61385: Context economy for agents: `genie tools` becomes progressive discovery (group index → `tools <group>` → `tools <tool>` with the full description and a runnable example; `--all` for the flat catalog, `--json` slim by default with full schemas per tool); ten new compact summarizers (status, find_components, component_for_dom, inspect_component, error_state, profile_report, query_list, query_get, router_get_state, router_list_matches) so hot reads stop dumping pretty JSON; `--json` output is now compact machine JSON; per-command `--help` for every subcommand.
- 0f2f2e4: Discovery polish from the three-model economy tests: read-group listings point at their domain's mutation tools in the `action` group; small flat action results render as one line (`ok=true · pathname="/error"`) instead of pretty JSON; `router_list_routes` gets a summary; generic basenames keep a parent segment (`routes/index.tsx:106`); array-valued query data previews as `[N items]` instead of dumping; the caught-error message is recovered from the console text when React 19.2 passes no Error instance.
- 8d99b93: Five-host E2E fleet fixes: `<GenieScript />` keeps a walked hub port across Next.js recompiles (global-symbol handoff); `<Genie />` discovers the QueryClient from a plain `QueryClientProvider` and accepts explicit `queryClient`/`router` props; `plugin_emit` auto-prefixes bare event types; React 19 error-boundary console text is parsed (message + thrower no longer dropped); consumed contexts are deduped (StrictMode double-reads); `react_get_tree` defaults to `appOnly` like its siblings; meta tools appear in the advertised catalog so counts agree; `genie tools` honors `--json` and `--session`; `init`/`doctor` treat the universal hub + script-tag path as a valid setup (exit 0); hub-down CLI errors no longer assume Vite; clearer `query_fetch` and effect-audit messages.
