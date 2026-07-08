---
"genie-react": patch
---

`react_error_state` now includes boundaries held open by `react_force_error_boundary` / `react_toggle_suspense_fallback`, flagged `forced: true` (real errors/suspends are `forced: false`), so a forced state is visible without cross-checking `react_list_overrides`.
