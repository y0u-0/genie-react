---
"genie-react": minor
"@genie-react/cli": minor
---

Make render causes actionable: `react_get_renders` now identifies each changed `useState`/`useReducer` slot, its flat and stateful hook positions, and bounded before/after values. Class state is reported separately, non-state hook internals are excluded, and the CLI prints compact value diffs while remaining compatible with older generic state markers.
