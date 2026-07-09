---
"genie-react": patch
---

Faster tools on large React trees: tree reads cached between commits, O(depth) fiber lookups instead of full-tree scans, LRU id registry (no more clear-all overflow), and source classification that skips cached fibers and warms in the background.
