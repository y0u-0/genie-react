---
"genie-react": minor
---

Add React Native / Expo support.

- New `genie-react/native` entry (`startGenie()` + `<Genie />`) that composes the DOM-free collectors and takes TanStack instances by value, so it bundles under Metro whether or not TanStack is installed.
- `findRootFiber()` now falls back to the fiber root captured from bippy's commit hook when there is no DOM, so every React tool works in React Native (web is unchanged; DOM seeding is still tried first).
- `react_dom_for_component` describes native host views (fiber type + `testID` / accessibility props) instead of returning empty on non-DOM hosts.
