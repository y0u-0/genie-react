s# Genie React — Tool Expansion Research

> What extra tools could genie expose to the agent, beyond the current 46? Researched across four streams: (1) what comparable agent-devtools projects expose, (2) the untapped TanStack API surface, (3) deeper React fiber/DevTools-backend capabilities, and (4) browser-side collectors feasible from in-page JS. Every proposal names the API that powers it and a feasibility rating.
>
> **Operating assumption: genie runs alongside agent-browser.** Anything agent-browser already provides — or that an agent can get with one `agent-browser eval` line — genie does not build.

**Division of labor:**

- **agent-browser owns the page**: DOM snapshots and interaction, screenshots, `console`, `network requests` + `network route` (mock/abort), `cookies`, `storage local`, waits on DOM/network, and arbitrary JS via `eval`.
- **genie owns what the page can't show**: React fibers, hooks, contexts, render causality, TanStack caches and routers, the devtools event bus, and the Vite dev server.
- **The seam between them is where the highest-value new tools live** — mapping agent-browser's world (elements, failed clicks) into genie's world (components, source) and back.

**Headline findings:**

1. **TanStack Form is a nearly-free new domain.** Form already broadcasts full form state on the exact devtools event bus genie's plugin passthrough taps (`form-devtools:*` events), including request/response pairs for reads and reset/force-submit actions. No new integration required — just decode what's already flowing.
2. **React's DevTools backend has an "override trio" genie only ships a third of.** Props can be overridden today; hook state and context can too (`overrideValueAtPath`, bippy `overrideHookState`), plus **force a Suspense fallback** and **force an error boundary** — completing the "test any UI state without editing code" story.
3. **Live scheduling attribution beats post-hoc render diffing.** `renderer.injectProfilingHooks` (the stable contract powering the DevTools timeline; react-scan vendors a 67-line version) reveals *which setState scheduled which render on which lane* — a causal trace instead of a commit diff.
4. **Two "seam" tools would make the pair work as one system:** `react_component_for_dom` (agent-browser ref → owning component + source file:line) and `dom_explain_visibility` (why agent-browser's click failed — the covering element, clipping, `inert`).

---

## 1. Dropped — agent-browser already covers it

Originally-researched proposals cut to avoid duplication:

| Would-have-been genie tool | agent-browser equivalent |
|---|---|
| `console_get_logs` / `console_get_errors` / `console_clear` | `agent-browser console` / `console --clear` |
| `net_get_requests` / `net_get_response_body` | `agent-browser network requests [--filter]` |
| network mock/intercept (competitor idea) | `agent-browser network route <url> [--abort] [--body]` |
| `storage_get_entries` / `set` / `remove` | `agent-browser storage local [key] [set k v] [clear]` |
| `storage_get_cookies` / `set_cookie` | `agent-browser cookies [set] [clear]` |
| `page_evaluate` / `page_get_global` / `page_get_environment` / `page_get_permissions` | `agent-browser eval` |
| `sw_get_registrations` / `sw_unregister`, `anim_get_animations` / `anim_pause_all`, `dom_get_box`, `storage_get_idb_summary` / `get_caches` / `get_quota`, `perf_sample_fps` | one-liner or short `eval` scripts |
| a11y snapshot, in-page screenshots | `snapshot -i`, `screenshot` |

Two notes from the research worth keeping despite the cuts:

- **Eval recipes doc.** The eval-able items (pause all animations before a screenshot, unregister a stale service worker, dump IndexedDB store counts, sample FPS) are non-obvious enough to be worth shipping as a documented recipe page rather than as tools.
- **Query ↔ network correlation** was the one genuinely genie-unique piece of a network tap. It doesn't need one: `query_get`'s existing `recentFetches` read next to `agent-browser network requests` gives the agent both halves; a docs example showing the correlation workflow captures most of the value.

## 2. Seam tools — agent-browser ↔ genie bridges ⭐ new top priority

| Tool | Powered by | R/A | Feasibility |
|---|---|---|---|
| `react_component_for_dom` | inverse of existing `react_dom_for_component`: selector (from an agent-browser ref) → owning component, props, source file:line via bippy `getFiberFromHostInstance` + `getFiberSource` | read | easy — turns "this button is wrong" (a snapshot ref) into "edit this file" |
| `dom_explain_visibility` | walk ancestors for display/visibility/opacity/clip/`inert`, off-viewport check, `elementFromPoint` to name the covering element + stacking context | read | moderate — directly diagnoses agent-browser click/assert failures; prior art: Playwright actionability checks |
| `devtools_wait` extensions | wait until: named component mounts, query settles, navigation resolves, effect storm quiets | read | easy — agent-browser `wait` covers DOM/network idle; genie waits cover React/Query state the DOM can't signal |
| `react_dom_for_component` enrichment | add iframe-safe bounding rect (`getNestedBoundingClientRect`) to the existing tool's output | read | trivial — hardens the handoff to agent-browser for portals/iframes |

## 3. Performance & vitals — genie-unique correlation only

Raw Web Vitals numbers are eval-able; what an eval can't do is correlate them with genie's collectors. Keep only the correlated versions:

| Tool | Powered by | R/A | Feasibility |
|---|---|---|---|
| `vitals_get_route_report` | `web-vitals` attribution build injected at page load (buffered observers — genie's injection point beats post-hoc eval), bucketed per route via the existing router collector | read | moderate, genie-unique |
| `perf_get_long_tasks` | `long-animation-frame` observer (per-script attribution, Chromium 123+) paired with render profiling → answers "React or not-React slow?" | read | easy |

## 4. TanStack Query additions

| Tool | Powered by | R/A | Feasibility |
|---|---|---|---|
| `query_set_online` / `query_get_online_state` | `onlineManager` (public singleton) | action + read | trivial — offline simulation for paused mutations/retry |
| `query_set_focused` | `focusManager.setFocused` (`undefined` reverts to real) | action | trivial — test `refetchOnWindowFocus` |
| `query_resume_paused_mutations` | `queryClient.resumePausedMutations()` | action | trivial |
| `query_get_defaults` / `query_set_defaults` | `get/setQueryDefaults` (scalar options only over the wire) | read + action | easy; no "list all defaults" API exists |
| `query_set_loading` / `query_set_error` | force a query into loading/error state (Rozenite's TanStack plugin ships these verbs) | action | moderate — cheapest way to verify error/loading UI |

Not worth building: infinite-query page ops (visible via existing `query_get`), streamedQuery (ditto), persisters (need app-provided instance), cache-event tool (churn heuristic already derives the signal).

## 5. TanStack Router additions

| Tool | Powered by | R/A | Feasibility |
|---|---|---|---|
| `router_get_events` | buffer all 6 `router.subscribe` events with timestamps → phase-by-phase navigation timing (slow loader vs slow render) | read | easy, high value |
| `router_list_blockers` | `history.getBlockers()` — count + `enableBeforeUnload` (fns unserializable) | read | easy — explains why `router_navigate` silently no-ops, currently a total blind spot |
| `router_get_match` | expose `context`, `preload`, `invalid`, `paramsError`, `searchError` per match | read | easy — deepens `router_list_matches` |
| `router_get_not_found` | `isNotFound(match.error)` | read | trivial |
| `router_list_route_masks` | `router.options.routeMasks` | read | trivial |

Not feasible: blocker proceed/reset (resolver lives in hook state), scroll-restoration cache (module-private), search-schema introspection (opaque validator fns).

## 6. TanStack Form — new domain, nearly free ⭐

Form's `FormApi` broadcasts on the devtools event bus the plugin passthrough already taps (pluginId `form-devtools`), dev-only, with pull-based reads and action listeners built in upstream:

| Tool | Bus mechanism | R/A |
|---|---|---|
| `form_list` | decode buffered `form-api` / `form-unmounted` events | read |
| `form_get` | emit `request-form-state {id}` → await `form-api` reply (full FormState: values, fieldMeta, errors, isSubmitting, canSubmit…) | read |
| `form_get_submission_log` | decode `form-submission` stage events (validate → inflight → success/error) — answers "why won't this form submit" | read |
| `form_reset` | emit `request-form-reset {id}` | action |
| `form_submit` | emit `request-form-force-submit {id}` — bypasses `canSubmit` by design; flag as destructive-ish | action |

Genie's form tools complement agent-browser's, not duplicate them: agent-browser fills and submits like a user; genie reads what the form *thinks* its state is (validation errors, dirty fields, submission stage) — the internals a failed fill can't explain.

Precondition (same as existing plugin passthrough): the app has `@tanstack/react-devtools`'s bus mounted. Form ids are random UUIDs unless the app sets `formId`.

## 7. TanStack DB / Pacer / Store / Table

| Library | Verdict |
|---|---|
| **DB** | `db_list_collections` / `db_get_collection` / `db_insert/update/delete` — rich public API (`status`, `size`, `state`, `subscribeChanges`), but no auto-discovery: app must register collections, same integration tier as `queryClient`. Worth it as adoption grows. |
| **Pacer** | `pacer_list` / `pacer_get` (read-only) — broadcasts on the already-tapped bus, but only for instances created with an explicit `key`; no request/response pair upstream, so flush/cancel/reset actions are upstream-gated. Essentially free reads. |
| **Store** | Only wireable if the app hands genie its Store instances — possible `store_get`/`store_set_state` behind explicit registration; low priority. |
| **Table** | Not a standalone domain — instances live in component hook state; point users at `react_inspect_component`. |
| **Start server fns** | No client-side registry exists; the idiomatic `useQuery(() => serverFn())` pattern means existing query/mutation tools already cover it. Document, don't build. |

## 8. React internals additions

Each entry: what powers it, a concrete agent use case, and the impact on how the agent works.

### `react_scheduling_events` — read, stability: med
- **Powered by:** `renderer.injectProfilingHooks` (`markStateUpdateScheduled` etc. — the stable renderer contract behind the DevTools timeline; react-scan vendors a 67-line impl) + lane-label translation.
- **Use case:** "Typing in search is laggy." Agent starts capture, agent-browser types into the field, then reads the events: `SearchProvider` scheduled a sync-lane update on every keystroke, cascading renders through the tree. Today `react_get_renders` shows *that* components re-rendered and which props changed — not *who initiated* it.
- **Impact:** Turns re-render debugging from correlation into causation. The agent stops guessing which of five re-rendered components started the cascade; it gets the initiating setState plus its priority (sync vs transition), so the fix — `startTransition`, state colocation, memo — is targeted on the first attempt.

### `react_interaction_attribution` — read, stability: med-high (ship as experimental)
- **Powered by:** react-scan's Event Timing `interactionId` staging: attributes renders to a single user interaction.
- **Use case:** "Clicking Add to Cart feels slow." Agent-browser clicks the button; genie reports that specific click cost 340 ms of render work, with `CartBadge` re-rendering 12 times from an unstable context value.
- **Impact:** Connects the user's own vocabulary ("this click is slow") straight to a component-level cost breakdown. One interaction replaces profiling a whole session and hunting through the report — and it composes naturally with agent-browser driving the clicks.

### `react_toggle_suspense_fallback` — action, stability: low risk
- **Powered by:** `overrideSuspense(id, forceFallback)` — the same bridge message real DevTools uses.
- **Use case:** Agent just wrote a skeleton loader. Instead of throttling the network or hacking a delayed `queryFn`, it forces the boundary into fallback, has agent-browser screenshot it, and toggles back.
- **Impact:** Makes loading states testable on demand. A state normally visible for milliseconds becomes a stable state the agent can hold open, inspect, and screenshot — closing the verify-your-own-fix loop for loading UI without touching code or network.

### `react_force_error_boundary` — action, stability: low risk
- **Powered by:** `overrideError(id, forceError)`.
- **Use case:** Agent adds an `ErrorBoundary` fallback, forces the boundary, screenshots the error UI, releases it. Also: force a boundary deep in a subtree to confirm which boundary actually catches — i.e. verify the blast radius matches intent.
- **Impact:** Error paths are the least-exercised code in any app. The agent verifies error UI without manufacturing a real crash (which can corrupt app state mid-session), and can prove boundary placement contains failures where the design intended.

### `react_override_hook_state` — action, stability: low-med (hook index is positional)
- **Powered by:** `overrideValueAtPath('hooks',…)` / bippy `overrideHookState` (works without DevTools attached).
- **Use case:** "The modal won't close when you're on step 3 with an invalid form." Reaching that state via agent-browser takes seven UI steps; the agent instead sets `step = 3` and `isValid = false` directly and observes.
- **Impact:** Completes the override trio (props today; + state + context). State-heavy components — wizards, toggles, reducers — become directly drivable: repro drops from a multi-step UI script to one call, and corrupt/hard-to-reach state combinations become testable at all.

### `react_override_context` — action, stability: med
- **Powered by:** bippy `overrideContext` — class components / provider-prop rewrite only; `useContext` consumers are not editable (must be documented in the tool description).
- **Use case:** "Is this rendering bug caused by the theme/locale/feature-flag context?" Agent swaps the provider's value live and watches whether the symptom follows.
- **Impact:** Isolates context-caused bugs by experiment instead of source-reading. The documented limitation matters: without it the agent burns turns on silent no-ops against function-component consumers.

### `react_hook_names` — read, stability: low-med (best-effort, needs source maps)
- **Powered by:** bippy `parseHookNames` (sourcemap fetch + source regex).
- **Use case:** Today `react_inspect_component` returns `hooks[3] = false` and the agent must open the source and count hook call order to learn that's `isSubmitting`. With names, the inspect output is self-describing.
- **Impact:** Pure readability leverage for an LLM consumer — and a safety multiplier: the main risk of `react_override_hook_state` is editing the wrong positional index, which names largely eliminate. Cheapest quality win in the whole React domain.

### `react_get_owners` — read, stability: med (`_debugOwner` is dev-only internal, but DevTools itself depends on it)
- **Powered by:** `fiber._debugOwner` walk — the JSX call-site owner chain, distinct from the structural parent chain.
- **Use case:** The problem component is `<Tooltip>` from a UI library, used in 40 places. The owner chain says *this* instance was created by `BillingRow` in `billing-table.tsx` — the file to edit.
- **Impact:** Kills the "found the component, but which usage?" dead end. Parent chains run through wrappers and portals; the owner chain points at the app code that wrote the JSX — which is where the fix goes.

### `react_suspense_resources` — read, stability: med
- **Powered by:** `markComponentSuspended` via the same `injectProfilingHooks` channel → promise name + resolution state (resolved/rejected/unresolved).
- **Use case:** Page stuck on a skeleton. `react_error_state` says boundary X is suspended; this adds "unresolved for 30 s" and — when the wakeable is named — *which* resource, so the agent pivots straight to `query_get` for that query.
- **Impact:** Converts "stuck suspended" from a dead-end symptom into a pointer at the offending async resource. Honest caveat: `promiseName` is often empty for plain fetch/Query promises, so this augments rather than replaces boundary detection.

### `react_build_type_check` — read, stability: low risk
- **Powered by:** bippy `detectReactBuildType`.
- **Use case:** User points genie at a preview/prod build; half the tools return degraded data. Agent calls this first, sees `production`, and says "start the dev server" instead of chasing ghost bugs for twenty minutes.
- **Impact:** A guardrail, not a capability — it prevents entire wasted sessions built on bad data. Worth calling once in every session preamble (and `doctor` could run it too).

### `react_activity_state` — read, stability: med, niche today
- **Powered by:** Offscreen/Activity fiber tags (resolved dynamically at attach time — the numeric tags renumber across React majors).
- **Use case:** "Why is this effect running for a tab that isn't visible?" Agent checks whether the subtree sits inside a hidden `<Activity>` — mounted and rendering, but deprioritized and invisible.
- **Impact:** Prevents misreading hidden-but-mounted trees as bugs (they show up in render counts today with no explanation). Low value now, grows with React 19 Activity adoption.

Skipped: `hotSwapFiberType` (deep-internal, easy to misuse), visual FPS overlays (not agent material).

## 9. Dev server & remaining ideas

- **Vite dev-server surface** — Next.js MCP's killer feature, and genie owns the Vite plugin: `vite_get_errors` (build/transform errors behind a blank page), `vite_get_hmr_events`, `vite_get_module_graph`. Nothing in the browser — agent-browser can't see these at all.
- **Profiler export/diff** — agent-react-devtools ships `profile export` (React DevTools Profiler JSON) and `profile diff before.json after.json --threshold` — diffing two profiles is how an agent *proves* a perf fix worked. Extends the ROADMAP's planned `react_profile_export`.
- **Heap snapshot suite** — Chrome MCP has 11 tools (take/compare/retainers). Not possible from in-page JS; would need a CDP sidecar. Park it — and if it ever matters, it belongs in agent-browser's world, not genie's.
- **App-defined controls** — Rozenite's controls plugin: app registers feature flags/debug actions, agent flips them. Natural extension of plugin passthrough.
- **Other-store adapters** (Redux/Zustand/Jotai: state, action history, time-travel) — Rozenite's redux plugin proves the shape; many TanStack apps still keep client state elsewhere in hook/context state genie can only partially see today.

---

## Suggested waves

**Wave 1 — cheap + on-brand:** `form_*` (bus decode), `query_set_online`/`set_focused`/`resume_paused_mutations`, `router_list_blockers`, `react_hook_names`, `react_build_type_check`, `react_component_for_dom`, `devtools_wait` extensions.

**Wave 2 — differentiators:** `react_scheduling_events`, `router_get_events`, `react_toggle_suspense_fallback` + `react_force_error_boundary` + `react_override_hook_state`, `vite_get_errors`, `dom_explain_visibility`.

**Wave 3 — advanced/experimental:** `react_interaction_attribution`, route-scoped vitals + LoAF, profile export/diff, DB/Pacer domains, app-defined controls, other-store adapters.

De-duplication against agent-browser cut the researched proposals from ~50 to ~35; what remains is either unreachable from the DOM (fibers, caches, the bus, Vite) or exists to make the agent-browser + genie pairing sharper (the seam tools).

---

*Sources: [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp), [Rozenite](https://github.com/callstackincubator/rozenite), [agent-react-devtools](https://github.com/callstackincubator/agent-react-devtools), [dev-inspector-mcp](https://github.com/mcpc-tech/dev-inspector-mcp), [playwright-mcp](https://github.com/microsoft/playwright-mcp), [next-devtools-mcp](https://github.com/vercel/next-devtools-mcp), [Nuxt DevTools](https://devtools.nuxt.com/guide/features), [vite-plugin-vue-mcp](https://github.com/webfansplz/vite-plugin-vue-mcp), [react-scan](https://github.com/aidenybai/react-scan), [bippy](https://github.com/aidenybai/bippy), React DevTools backend (`react-devtools-shared`), TanStack query/router/form/store/db/pacer/devtools sources (pinned SHAs verified 2026-07), [web-vitals](https://github.com/GoogleChrome/web-vitals), agent-browser command reference (local skill).*
