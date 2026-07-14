---
name: genie
description: Drive live DevTools on a RUNNING React, React Native, or TanStack app with the `genie-react` CLI. Use it to inspect components, explain renders, audit effect schedules and hotness, read Query or Router state, force hard-to-reach UI, and prove a change with repeated runtime captures. Pair it with agent-browser on web or agent-device on native. Do not use it for static source review.
metadata:
  version: "0.9.0"
  package: "@genie-react/cli"
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

Verify that the runtime and this installed guidance match before diagnosis:

```bash
genie-react doctor --json
```

If doctor reports a stale skill hash/version, rerun `genie-react init` to refresh the bundled copy.

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

Saved browser state must omit all `genie-react:*` sessionStorage keys. Status warns and forks cloned logical identities; never continue with an identity collision.

This step is complete when the named target says `ready=true`. Run full `genie-react status` once if you need its domain list.

If startup hangs, rerun with `--verbose`. It prints the CLI version, chosen bridge, session, and time budgets to stderr. Use `--connect-timeout <ms>` to bound only the WebSocket connection.

## 2. Measure one exact flow

Prefer one atomic interaction boundary when the running collector advertises it:

```bash
genie-react call devtools_interaction_begin '{"name":"open target","components":["TargetRow"]}' --json
# Drive exactly one UI interaction.
genie-react call devtools_interaction_stop '{"interactionId":"int_…","domains":["react","query","router","frames"]}' --json
```

Use the same loop every time:

```bash
genie-react call react_clear_renders '{"components":["TargetRow"],"budget":{"adaptive":true}}'
# Click, type, navigate, or reproduce the issue.
genie-react call react_get_renders '{"sort":"selfTime","limit":5}'
```

Clear immediately before the flow. Keep the returned observation ID. Otherwise the result mixes old work with the flow you care about.

Named components/roots receive reserved commit-analysis and lifecycle capacity. Read the returned `observationConfig` and targeted coverage instead of assuming a large table was fully scanned.

This step is complete when the output covers one known interaction.

## 3. Ask the smallest useful question

- Unexpected render: `react_get_renders`, then `react_render_causes`.
- Missing or repeated instance: `react_component_cohort`.
- Slow flow: `react_profile_start`, drive the flow, then `react_profile_report`.
- Effect behavior: `react_effect_timeline`, then `react_effect_audit`.
- Source/ownership gap: `react_provenance`.
- Query delivery: `query_notifications`, then `query_list`/`query_get`.
- Blank or stuck UI: `react_error_state`.
- Component state: `react_find_components`, then `react_inspect_component`.
- DOM owner: `react_component_for_dom`.
- Query state: `query_list`, `query_get`, or a focused Query action.
- Route state: `router_get_state`, `router_list_matches`, or a focused Router action.
- Memory: `browser_get_memory`.
- Frame rate: `browser_fps` while the tab is visible.

Read evidence literally:

- `exact` means the runtime relationship was observed directly.
- `inferred` means it is a useful lead, not proof.
- `unknown` means the agent needs another check.
- `not-proven-safe` means do not remove the render yet. Test DOM, ARIA, focus, URL, network, and transitions first.

`coverage.complete` covers the tool's primary measurement. `coverage.inputAttributionComplete` covers render-cause inputs. A timing profile can be complete while input attribution is partial. If attribution is `stale`, wait for commits to settle and retry. If primary coverage is incomplete, follow the reported limit or budget and repeat a smaller flow. A render diff reports coverage for both runs.

Summary `semantics` is decisive: `exact` supports a count, `lower-bound` means more work may exist, and `unknown` means an empty result is not a clean pass. Require `comparable:true` before a before/after claim.

`propsNotEnumerated` is intentional, not retryable. Genie does not enumerate an arbitrary props container because it may be a Proxy. Inspect a named component prop or path instead. Never use partial input attribution to prove that a render had no cause.

`react_component_cohort` separates mounted-idle, updated, unmounted, and absent instances. Check `omittedByLimit` before calling the result complete.

Effect schedules alone are leads. `react_effect_timeline` distinguishes exact passive execution/cleanup and exact Query/Router notification consequences from inferred resulting commits and explicitly unobserved domains. Require the relevant consequence before editing behavior. A hotness result is strong only after enough updates; treat `insufficient-data` as unknown.

Query evidence can include an exact observer, tracked/changed fields, structural sharing, notification ID, subscriber, app hook callsite, and linked render IDs. Exact Query/Router causes require a matching notification ID; proximity-only causes stay inferred and list competing candidates.

Component locations can be JSX use sites or definition fallbacks. Treat that source as inferred. Exact hook provenance is the better edit target when present.

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

When available, use multi-domain settle and fail the shell on a result timeout:

```bash
genie-react call devtools_wait '{"condition":"settled","domains":["react","query","router","frames"],"timeoutMs":10000}' --json --fail-on-result-error
```

Inspect every per-domain state; partial quiet is not idle.

Use `genie-react tools` to list groups. Use `genie-react tools <tool>` for the full schema and an example. Do not dump every contract unless it is needed.

## 4. Prove the change with repeated captures

Run the same flow at least five usable times before the change and five times after it; the first run is warm-up by default. For every run:

```bash
genie-react call react_clear_renders '{}'
# Drive the exact same flow.
genie-react call devtools_capture_create '{"name":"before-1"}' --json
```

Keep the returned capture IDs. Compare both groups:

```bash
genie-react call devtools_capture_compare \
  '{"baselineCaptureIds":["<before-0>","<before-1>","<before-2>","<before-3>","<before-4>","<before-5>"],"candidateCaptureIds":["<after-0>","<after-1>","<after-2>","<after-3>","<after-4>","<after-5>"],"metrics":["react.renders","react.selfTimeMs"],"budgets":[{"metric":"react.renders","maxRegressionPct":0}]}'
```

The comparison rejects warm-up/outliers, gates coverage and FPS refresh mode, and reports confidence/noise and practical effect size. Only `pass`/`fail` is decisive; `inconclusive`, `not-comparable`, and `insufficient-data` are not passes. Use the same build, route, device, and interaction.

This step is complete when the requested budgets pass and the UI behavior is still correct.

## 5. Leave the app clean

- Restore simulated Query state with `query_restore_state`.
- List active overrides with `react_list_overrides`.
- Remove them with `react_reset_overrides`.
- Check the browser or device for visible errors.
- Pin or export important captures before the 20-item retention boundary:

```bash
genie-react call devtools_capture_pin '{"captureId":"cap_…"}' --json
genie-react capture export cap_… --output .context/captures/before.json --section react,effects
```

Capture reads default to bounded summaries. Exports verify their embedded SHA-256 checksum before writing.

## CLI rules

- `--json` prints one compact JSON value to stdout.
- `--fields id,name,renders` prints selected records as JSONL.
- `--select 'sections.react.components[*].name'` selects nested paths and reports matched/omitted counts; RFC 6901 pointers are also accepted.
- `--max-bytes <n>` is a hard ceiling. Oversized output becomes an explicit truncation envelope, never clipped JSON.
- `batch` uses one connection and prints JSONL by default. `batch --ndjson` is explicit JSONL. `batch --json` prints one JSON array.
- CLI-owned JSON envelopes include `schemaVersion`. Raw successful tool results follow that tool's advertised output schema.
- Machine-mode failures keep stdout as valid JSON and include a stable `reason` plus a safe next command when recovery is known.
- `devtools_wait` waits for a connection, component, exact query, or navigation. Prefer it to polling.
- `--fail-on-result-error` makes a wait result with `ok:false` fail a shell pipeline.
- `[busy]` means the app's main thread is blocked. Wait for the returned delay and try again.

The job is done only when the UI test passes, the live Genie evidence supports the result, and temporary runtime state has been restored.
