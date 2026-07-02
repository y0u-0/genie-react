---
"genie-react": patch
"@genie-react/cli": minor
---

Context economy for agents: `genie tools` becomes progressive discovery (group index → `tools <group>` → `tools <tool>` with the full description and a runnable example; `--all` for the flat catalog, `--json` slim by default with full schemas per tool); ten new compact summarizers (status, find_components, component_for_dom, inspect_component, error_state, profile_report, query_list, query_get, router_get_state, router_list_matches) so hot reads stop dumping pretty JSON; `--json` output is now compact machine JSON; per-command `--help` for every subcommand.
