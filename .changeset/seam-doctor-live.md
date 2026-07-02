---
"genie-react": minor
"@genie-react/cli": minor
---

New `react_component_for_dom` tool: a CSS selector resolves to the owning React component(s) with id, props, and source file:line — the reverse of `react_dom_for_component`. `genie doctor --live` probes the running stack end to end (hub HTTP + identity, served client bundle, WS session round-trip). Stale `.genie/bridge.json` files whose pid is gone are announced and removed by both discovery and doctor. Piped `--json` output is no longer truncated at 64KB (natural exit instead of `process.exit`).
