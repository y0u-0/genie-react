# Genie React — Improvement Plan

> Gap analysis of the 0.1.0 release, ranked by impact. Grounded in a full audit of the monorepo — every finding carries a `file:line` reference.

**Structural bright spot worth preserving:** `react-collector` has zero TanStack imports (pure bippy/fiber walking, portable to any React app), and the bridge is already transport-agnostic (`packages/bridge/src/standalone.ts`). The two biggest expansion paths — other frameworks, other bundlers — are adapter problems, not rewrites.

---

## Tier 1 — Fix what's silently broken

### 1. Add a CI test gate ⭐ cheapest, highest value
`.github/workflows/release.yml` only publishes (changesets version/publish on push to `main`). Nothing runs `pnpm test`, `typecheck`, or `lint` on PRs or pushes — 17 test files never execute in CI.

**Fix:** a `ci.yml` workflow running test + typecheck + lint on PRs and pushes to `main`.

### 2. The push channel is dead
Collectors actively push snapshots on every Query cache and Router change (`tanstack-collector/src/query.ts:525`, `router.ts:238`, `devtools-plugin/src/passthrough.ts:111`). The client forwards them as `app/snapshot` / `app/event` frames (`client.ts:126-128`) — and the bridge decodes and **discards them all**: `handleAppMessage` has no `app/snapshot` case, and `app/event` is a no-op (`bridge.ts:155-182`).

The "snapshot store" in the ROADMAP architecture diagram (`ROADMAP.md:17`) was never built. Today this is wasted browser→node traffic on every cache change; it's also the blocker for `genie watch` (Tier 2).

**Fix:** implement the snapshot store in the bridge; buffer recent snapshots/events per session.

### 3. Multiple browser tabs clobber each other
The bridge holds a single `app: AppSession | null` (`bridge.ts:81`). Every `app/hello` overwrites it without closing the previous socket (`bridge.ts:157-164`). Closing the **active** tab drops the connection even when other tabs are open; closing a background tab is silently ignored (`bridge.ts:337-338`). Two tabs open is a completely normal dev situation.

**Fix:** session map keyed by `sessionId` + a `--session` CLI flag (default: most recent).

### 4. Protocol version is decoration
`GENIE_PROTOCOL_VERSION = 1` (`core/src/constants.ts:1`) is sent in `app/hello` (`client.ts:137`) and typed in the schema (`protocol.ts:59`), but the bridge never reads it. Harmless now; a trap the first time the wire format changes.

**Fix:** one-line check-and-reject on mismatch in the bridge handshake.

### 5. Transport hardening
- Reconnects are fixed 1 s with no backoff/jitter/cap on both sides (`client.ts:96-102`, `cli/src/agent-link.ts:144-150`) — a downed dev server gets hammered indefinitely.
- No backpressure: neither side checks `bufferedAmount` before `socket.send` (`bridge.ts:367-369`, `client.ts:193-195`).
- No frame-size cap: the serializer bounds values (depth/entries/string length, `serialization.ts:167-309`) but nothing measures the encoded frame before send, and there's no max-message guard on receive.

---

## Tier 2 — Capability unlocks

### 6. `genie watch` / streaming mode ⭐ the differentiator
The README's pitch is begging for this. "Diagnose a refetch storm" today means clear → interact → poll; `call` is strictly one-shot request→response→close (`cli/src/agent.ts:220-239`). With the push channel actually stored at the bridge (item 2), the CLI could do `genie watch query` or `genie tail renders` and the agent sees the storm **as it happens**. This is what separates Genie from every "dump the React tree" tool.

### 7. An MCP server package
The only agent interface is shelling out to `genie call <tool> '<json>'` — no MCP exposure exists anywhere in the repo. An `@genie-react/mcp` package exposing the same 46 tools over stdio would make Genie a native tool surface in Claude Code, Cursor, etc.: no JSON-string-quoting friction, schema-validated args for free. `defineAgentToolContract` already produces JSON Schema (`client.ts:245-247`), so the mapping is mostly mechanical.

**Design note:** build it as a second entry point over `agent-link.ts`, not a separate implementation — tool additions then stay zero-cost across CLI and MCP.

### 8. A framework adapter beyond Vite
The hub mounts on a raw Node HTTP `upgrade` (`bridge.ts:92-97`) and collectors are framework-agnostic. What a Next.js / webpack / Rspack adapter needs: (a) mount `handleUpgrade` on the dev server, (b) inject the client bundle, (c) write the discovery file. No core/bridge changes required.

**Cheap first step:** document the existing `createStandaloneBridge` path — "run the hub on its own port, add one script tag" — to unlock non-Vite users immediately.

---

## Tier 3 — Polish

### 9. Human summaries for more tools
Only 4 of 46 tools have compact summaries (`agent.ts:37-42`: renders, effects, tree, dom). `query_list`, `query_get`, `router_get_state`, `react_error_state`, `react_inspect_component`, `react_profile_report` — the most-called tools — always dump raw JSON.

### 10. Test gaps
- `devtools-plugin` and `memory` ship runtime logic with **zero tests**.
- No integration/e2e layer at all. The ROADMAP Phase 7 capstone — the scripted agent-browser walkthrough (`ROADMAP.md:33`) — is not in the repo; building it would double as the only end-to-end test.
- `react-collector`'s `fiber.ts`, `hook.ts`, and `collector.ts` (the tool wiring) have no direct tests — only the sub-trackers do.

### 11. `react_profile_export`
The ROADMAP v5 follow-up (`ROADMAP.md:30`) — export to the React DevTools Profiler tab format — is unimplemented.

### 12. CLI ergonomics (minor)
- No shell completion generator.
- Invoke timeout hard-coded to 20 s (`agent.ts:32`); no `--timeout` flag distinct from `--wait`.
- `call` requires JSON as one quoted arg; no `--arg key=value` sugar, no stdin-piped args.
- No `genie call --help <tool>` to print a single tool's schema.

---

## Suggested 0.2.0 sequence

| Step | Work | Why this order |
|---|---|---|
| 1 | CI workflow | ~1 hour, protects everything after it |
| 2 | Bridge session map + snapshot store | One architectural change; items 2, 3, and 6 all hinge on the bridge becoming stateful |
| 3 | `genie watch` / `genie tail` | Falls out of step 2; the headline feature |
| 4 | `@genie-react/mcp` | Distribution multiplier once the tool surface is stable |

That's the version where Genie stops being "a nicer way to poll DevTools" and becomes **"the agent sees your app live."**
