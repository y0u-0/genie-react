# @genie-react/cli

## 0.5.1

### Patch Changes

- 32edfea: Pack releases with pnpm before publishing through npm so internal workspace dependencies resolve to installable versions.
- Updated dependencies [32edfea]
  - genie-react@0.5.1

## 0.5.0

### Minor Changes

- 3413d52: Make render causes actionable: `react_get_renders` now identifies each changed `useState`/`useReducer` slot, its flat and stateful hook positions, and bounded before/after values. Class state is reported separately, non-state hook internals are excluded, and the CLI prints compact value diffs while remaining compatible with older generic state markers.

### Patch Changes

- Updated dependencies [3413d52]
- Updated dependencies [922b635]
  - genie-react@0.5.0

## 0.4.0

### Minor Changes

- 8d4d7bf: Better agent experience: typed errors with retry hints, fast busy detection, hook kinds and overrides by stateful index, override list/reset, render snapshot/diff, CLI `batch` / `--fields` / `--timeout`, and one bin name: `genie-react`.

### Patch Changes

- Updated dependencies [8d4d7bf]
- Updated dependencies [8c945ed]
- Updated dependencies [5314fbf]
  - genie-react@0.4.0

## 0.3.0

### Minor Changes

- fc7eb33: New `browser_fps` tool (perf collector): sample the page frame rate on demand via requestAnimationFrame — avg fps, frames dropped against the estimated display refresh rate (fair on 120Hz panels), long frames (>50ms), the single worst stall, and a smooth/degraded/janky verdict using react-scan's thresholds as refresh-rate ratios plus its 150ms hard-stall rule. Registered by `<Genie />` and the script-tag client; the CLI prints a one-line summary. Also bumps bippy to ^0.5.43 (a republish of 0.5.42 — no API changes).

### Patch Changes

- Updated dependencies [fc7eb33]
  - genie-react@0.3.0

## 0.2.2

### Patch Changes

- Updated dependencies [9379751]
  - genie-react@0.2.2

## 0.2.1

### Patch Changes

- c0c0025: Coexist with `@cloudflare/vite-plugin` (Start-on-Cloudflare apps like tanstack.com): its workerd dev proxy owns the dev port's WebSocket upgrades and drops genie's socket within milliseconds (close 1006, permanent reconnect flap). The `genie()` plugin now detects the Cloudflare plugin in the resolved config and reroutes transport automatically — it starts a standalone hub on its own port, points the injected client's WebSocket at it, writes discovery for the CLI accordingly, and shuts the hub down with the dev server (a killed server heals via the existing stale-pid cleanup). No wiring changes: `genie()` + `<Genie />` stay as-is, and existing setups fix themselves on upgrade. `init` prints a note when it sees the Cloudflare plugin in dependencies.
- c0c0025: Harden the attach paths against real-world hosts, from OSS-app field testing (Excalidraw, tanstack.com, Cal.com/react.dev):

  - Vite plugin excludes `genie-react` from dependency pre-bundling so the optional-peer stubs actually apply — importing `<Genie />` no longer black-screens apps without TanStack installed — and pre-lists its nested deps so the first post-install boot connects instead of 504ing on stale optimized-dep hashes.
  - Opt out of ws's optional native addons before ws loads: a host bundler or stale prebuild that half-resolves `bufferutil` crashed the hub with `bufferUtil.unmask is not a function` on Node 22 and 500'd the host app.
  - Tool dispatch rejects unrecognized argument keys (a `maxDepth` typo for `depth` used to no-op silently), formats validation errors readably, and unknown-tool errors now list the advertised domains and explain that query/router tools are gated on a discovered QueryClient/Router.
  - CLI: when no `.genie/bridge.json` exists, say so and call the localhost default a guess instead of presenting it as fact; `doctor --live` reports "no app session connected yet" instead of a warning-glyphed success sentence; hub timeouts hint at busy main threads and `devtools_wait`.
  - `init` adds `.genie/` to `.gitignore` and prints next-steps with the repo's actual package manager instead of hardcoded pnpm.

- Updated dependencies [c0c0025]
- Updated dependencies [c0c0025]
  - genie-react@0.2.1

## 0.2.0

### Minor Changes

- ac61385: Context economy for agents: `genie tools` becomes progressive discovery (group index → `tools <group>` → `tools <tool>` with the full description and a runnable example; `--all` for the flat catalog, `--json` slim by default with full schemas per tool); ten new compact summarizers (status, find_components, component_for_dom, inspect_component, error_state, profile_report, query_list, query_get, router_get_state, router_list_matches) so hot reads stop dumping pretty JSON; `--json` output is now compact machine JSON; per-command `--help` for every subcommand.
- d4f511c: New `react_component_for_dom` tool: a CSS selector resolves to the owning React component(s) with id, props, and source file:line — the reverse of `react_dom_for_component`. `genie doctor --live` probes the running stack end to end (hub HTTP + identity, served client bundle, WS session round-trip). Stale `.genie/bridge.json` files whose pid is gone are announced and removed by both discovery and doctor. Piped `--json` output is no longer truncated at 64KB (natural exit instead of `process.exit`).
- a11e8bf: Consolidate the app-side packages into one `genie-react` package.

  `@genie-react/core`, `client`, `react-collector`, `tanstack-collector`, `devtools-plugin`, `memory`, `react`, `bridge`, and `vite` are replaced by the single `genie-react` package with subpath exports: `genie-react` (the `<Genie />` component), `genie-react/vite` (the plugin), `genie-react/client` + `genie-react/hook` (the injected client), `genie-react/hub` (the standalone bridge), and `genie-react/protocol` (wire protocol + tool contracts).

  Migration: `pnpm add -D genie-react`, then `import { Genie } from 'genie-react'` and `import { genie } from 'genie-react/vite'`. The CLI (`@genie-react/cli`) is unchanged in usage; `genie init`, `doctor`, and `link` now wire the single package.

- 5e60814: Framework-agnostic attach: Next.js support and a standalone hub for any non-Vite React app.

  The hub now serves a self-contained browser client at `GET /__genie/client.js`, so any React setup attaches with one classic script tag — no bundler integration required. New surface: `genie hub` (CLI command, default port 4390), `<GenieScript />` from `genie-react/script` (dev-only script tag for any SSR root layout, RSC-safe), and `genie-react/next` with `registerGenie()` for Next.js `instrumentation.ts`. `genie init` and `doctor` now detect Next.js apps and wire the layout + instrumentation automatically.

### Patch Changes

- 0f2f2e4: Discovery polish from the three-model economy tests: read-group listings point at their domain's mutation tools in the `action` group; small flat action results render as one line (`ok=true · pathname="/error"`) instead of pretty JSON; `router_list_routes` gets a summary; generic basenames keep a parent segment (`routes/index.tsx:106`); array-valued query data previews as `[N items]` instead of dumping; the caught-error message is recovered from the console text when React 19.2 passes no Error instance.
- 8d99b93: Five-host E2E fleet fixes: `<GenieScript />` keeps a walked hub port across Next.js recompiles (global-symbol handoff); `<Genie />` discovers the QueryClient from a plain `QueryClientProvider` and accepts explicit `queryClient`/`router` props; `plugin_emit` auto-prefixes bare event types; React 19 error-boundary console text is parsed (message + thrower no longer dropped); consumed contexts are deduped (StrictMode double-reads); `react_get_tree` defaults to `appOnly` like its siblings; meta tools appear in the advertised catalog so counts agree; `genie tools` honors `--json` and `--session`; `init`/`doctor` treat the universal hub + script-tag path as a valid setup (exit 0); hub-down CLI errors no longer assume Vite; clearer `query_fetch` and effect-audit messages.
- Updated dependencies [ac61385]
- Updated dependencies [0f2f2e4]
- Updated dependencies [8d99b93]
- Updated dependencies [d4f511c]
- Updated dependencies [a11e8bf]
- Updated dependencies [5e60814]
  - genie-react@0.2.0

## 0.1.0

### Minor Changes

- Initial public release of Genie — give an AI coding agent full DevTools access to your live React + TanStack app from your terminal via the `genie` CLI.
- a36626f: Make tool arguments discoverable and consistent for agents.

  - `genie tools` now prints each tool's parameters (name, type, and a `?` for optionals) from the input schema the app already advertises, so an agent can call a tool without guessing argument names.
  - `query_get` and `query_get_data` now accept **either** a `queryHash` or a `queryKey` — whichever you already have from `query_list` — instead of each demanding a different identifier.

### Patch Changes

- Updated dependencies
  - @genie-react/core@0.1.0
