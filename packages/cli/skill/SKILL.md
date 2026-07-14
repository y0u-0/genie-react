---
name: genie
description: Drive live DevTools on a RUNNING React, React Native, or TanStack app with the genie-react CLI. Use for runtime render, effect, Query, Router, interaction, memory, and FPS evidence; do not use for static source review.
metadata:
  version: "0.9.0"
  package: "@genie-react/cli"
---

# Genie

Genie inspects the app that is running now. Pair it with a browser/device driver to perform the UI interaction, and use Genie to explain and verify what happened underneath it.

## Verify setup before diagnosis

```bash
genie-react doctor --json
genie-react status --sessions-only --json
```

Machine output belongs on stdout; diagnostics belong on stderr. If doctor reports that this skill is stale, run `genie-react init` to refresh the bundled copy before continuing.

When several tabs are connected, name and pin the intended tab:

```text
http://localhost:3000/?_genie=my-agent
```

```bash
export GENIE_SESSION=my-agent
genie-react status --sessions-only --json --marker my-agent
```

Never rely on an implicit current tab during concurrent work. Saved browser state must omit all `genie-react:*` sessionStorage keys; status reports and forks cloned logical identities when a collision is detected.

## Measure one bounded interaction

Prefer an interaction-scoped capture when available:

```bash
genie-react call devtools_interaction_begin '{"name":"filter species","components":["SpeciesRow"]}' --json
# Drive exactly one UI interaction.
genie-react call devtools_interaction_stop '{"interactionId":"int_…","domains":["react","query","router","frames"]}' --json
```

For a focused render window:

```bash
genie-react call react_clear_renders '{"components":["SpeciesRow"],"budget":{"adaptive":true}}' --json
# Drive exactly one UI interaction.
genie-react call react_get_renders '{"component":"SpeciesRow","sort":"selfTime","limit":10}' --json
genie-react call react_render_causes '{"component":"SpeciesRow","limit":20}' --json
```

The target list reserves commit-analysis and lifecycle capacity for those components. Keep the returned observation ID; it joins render, cause, notification, and effect evidence.

## Read evidence literally

- A summary with `semantics:"exact"` can support a count. `lower-bound` means more work may have occurred. `unknown` means an empty result is not a clean pass.
- Require `comparable:true` before claiming a before/after improvement. Read every `notComparableReasons` entry.
- Never classify a render as safely unnecessary when input attribution is incomplete.
- `appOnly:true` excludes unknown ownership. Do not turn `source:null`, `ownership:"unknown"`, or a provenance failure into app ownership.
- An exact Query or Router cause must carry a matching notification ID. Proximity-only causes are inferred leads and must list competing candidates.
- An effect schedule is only a lead. Require observed execution and the relevant consequence edge before editing effect behavior.
- A hidden/throttled FPS sample or refresh-rate-mode change is not comparable.

## Ask the smallest runtime question

- Ownership/source gap: `react_provenance`.
- Unexpected render: `react_get_renders`, then `react_render_causes`.
- Repeated/missing instances: `react_component_cohort`.
- Effect behavior: `react_effect_timeline`, then `react_effect_audit`.
- Query delivery: `query_notifications`, plus `query_list`/`query_get`.
- Router state: `router_get_state` and `router_list_matches`.
- Blank/stuck UI: `react_error_state`.
- Live component state: `react_find_components`, then `react_inspect_component`.
- DOM ownership: `react_component_for_dom`.
- Memory: `browser_get_memory`.
- Frame pacing: `browser_fps` while the tab is visible.

Discover exact contracts instead of guessing:

```bash
genie-react tools react.render
genie-react tools react_effect_timeline
genie-react tools devtools_capture_compare --json
```

Text help includes nested schema keys, defaults, enums, and limits.

## Wait without inventing idle

```bash
genie-react call devtools_wait '{"condition":"settled","domains":["react","query","router","frames"],"timeoutMs":10000}' --json --fail-on-result-error
```

Inspect every per-domain status. Partial quiet is not idle. For Query, prefer an exact `queryHash` or structured `queryKey`; legacy names are exact matches, never substrings.

## Prove changes with repeated captures

Create at least five usable runs per cohort; the first run is warm-up by default:

```bash
genie-react call devtools_capture_create '{"name":"before-1","include":["react","effects","query","performance"]}' --json
genie-react call devtools_capture_create '{"name":"after-1","include":["react","effects","query","performance"]}' --json
genie-react call devtools_capture_compare '{"baselineCaptureIds":["cap_b0","cap_b1","cap_b2","cap_b3","cap_b4","cap_b5"],"candidateCaptureIds":["cap_c0","cap_c1","cap_c2","cap_c3","cap_c4","cap_c5"],"budgets":[{"metric":"react.renders","maxRegressionPct":5}]}' --json
```

Only `pass`/`fail` is decisive. `inconclusive`, `not-comparable`, and `insufficient-data` are terminally honest outcomes, not permission to merge.

Retained captures are bounded. Pin or export important evidence:

```bash
genie-react call devtools_capture_pin '{"captureId":"cap_…"}' --json
genie-react capture export cap_… --output .context/captures/before.json --section react,effects
```

The export verifies its embedded checksum before writing. Capture reads default to summaries; request `{"view":"full","sections":["react"]}` only when needed.

## Bound large output

Use tool limits first, then nested selection and a byte ceiling:

```bash
genie-react call devtools_capture_read '{"captureId":"cap_…","view":"full","sections":["react"]}' \
  --select 'sections.react.tools.react_get_renders.result.components[*].name' \
  --max-bytes 20000
```

`--select` accepts RFC 6901 JSON Pointer or dotted paths with `*`/`[*]`. Its envelope reports matched and omitted path counts. `--max-bytes` never silently clips JSON; an oversized result becomes an explicit bounded truncation envelope.

## Mutation safety

Before a mutation, inspect the exact target and record the intended value. After it, re-read the same target and assert the new value. Treat timeout, busy, `ENOSPC`, `EPIPE`, ambiguity, or a result-level `ok:false` as failure. Use `--fail-on-result-error` in shell pipelines for wait-like tools.

Do not remove uncertainty labels, bypass session targeting, or claim causality from timestamps alone.
