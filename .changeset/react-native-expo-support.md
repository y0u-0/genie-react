---
"genie-react": minor
---

Add React Native / Expo support.

- New `genie-react/native` entry (`startGenie()` + `<Genie />`) that composes the DOM-free collectors and takes TanStack instances by value, so it bundles under Metro whether or not TanStack is installed (RN 0.79+ / Expo SDK 53+). Instances are duck-validated with a loud skip on mismatch, and a `queryClient`/`router` passed on a later call or render registers onto the running client instead of being dropped.
- `findRootFiber()` now falls back to the live roots captured from bippy's commit hook when there is no DOM, so every React tool works in React Native. Roots are tracked per `FiberRoot` and dropped on unmount: the first-mounted root wins (a dev-overlay root like LogBox can't hijack the tools), an unmounted tree is never reported, and nothing is retained after teardown. Web still seeds from the DOM first.
- `react_dom_for_component` describes native host views (fiber type + `testID` / accessibility props) instead of returning empty on non-DOM hosts, including text from string, number, and interpolation-array children.
- The web and native entries now compose their default collectors from one shared list, so future collectors ship to both platforms.
