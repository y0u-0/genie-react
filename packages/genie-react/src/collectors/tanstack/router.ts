import type { AnyRouter, NavigateOptions, ToOptions } from '@tanstack/react-router'
import { z } from 'zod'
import { defineCollector, defineCollectorTool, type GenieCollector } from '../../client'
import { defineAgentToolContract, dehydrate } from '../../protocol'
import { registerRouterStore } from '../causal/external-store-registry'

interface RouteEntry {
  id: string
  path?: string
  fullPath?: string
  rank?: number
  isRoot?: boolean
  options?: { loader?: unknown; beforeLoad?: unknown }
}

function isRouteEntry(value: unknown): value is RouteEntry {
  return (
    typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
  )
}

// The single runtime boundary narrowing the `any`-typed routesById internal; entries without a string id are dropped.
function asRouteEntries(routesById: unknown): RouteEntry[] {
  if (typeof routesById !== 'object' || routesById === null) return []
  const values: unknown[] = Object.values(routesById)
  return values.filter(isRouteEntry)
}

const toOptionsSchema = z.object({
  to: z.string().describe('Target path, e.g. "/posts/$postId" or "/about".'),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Path params for the target route.'),
  search: z.record(z.string(), z.unknown()).optional().describe('Search/query params.'),
  hash: z.string().optional(),
})

const routerGetStateContract = defineAgentToolContract({
  name: 'router_get_state',
  title: 'Get router state',
  description:
    'Get one synchronous snapshot of TanStack Router state and the browser location. `locationSync` makes history/Router disagreement explicit instead of returning one potentially stale URL.',
  group: 'router',
  input: z.object({}),
  output: z.object({
    routerId: z.string().nullable(),
    pathname: z.string(),
    href: z.string(),
    searchStr: z.string().optional(),
    hash: z.string().optional(),
    status: z.string(),
    statusCode: z.number().optional(),
    isLoading: z.boolean(),
    isTransitioning: z.boolean(),
    loadedAt: z.number().optional(),
    matchCount: z.number(),
    pendingMatchCount: z.number(),
    browserLocation: z
      .object({
        href: z.string(),
        pathname: z.string(),
        search: z.string(),
        hash: z.string(),
      })
      .nullable(),
    locationSync: z.enum(['matched', 'mismatched', 'unavailable']),
    snapshotAt: z.number().describe('Epoch milliseconds after both locations were read.'),
  }),
  annotations: { readOnlyHint: true },
})

const routerListMatchesContract = defineAgentToolContract({
  name: 'router_list_matches',
  title: 'List route matches',
  description:
    'List the active route matches: routeId, pathname, params, search, loader status, and loader data.',
  group: 'router',
  input: z.object({ depth: z.number().int().min(1).max(4).default(2) }),
  output: z.object({
    matches: z.array(
      z.object({
        routeId: z.string(),
        pathname: z.string(),
        params: z.unknown(),
        search: z.unknown(),
        status: z.string(),
        isFetching: z.union([z.boolean(), z.string()]),
        loaderData: z.unknown(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true },
})

const routerListRoutesContract = defineAgentToolContract({
  name: 'router_list_routes',
  title: 'List registered routes',
  description:
    'List every route registered on the router (the route tree, from routesById): routeId, path, fullPath, rank, and whether it declares a loader / beforeLoad. Use to discover navigable paths for router_navigate / router_preload.',
  group: 'router',
  input: z.object({
    includeRoot: z.boolean().default(false).describe('Include the synthetic __root__ route.'),
  }),
  output: z.object({
    routes: z.array(
      z.object({
        routeId: z.string(),
        path: z.string().optional(),
        fullPath: z.string().optional(),
        rank: z.number().optional(),
        hasLoader: z.boolean(),
        hasBeforeLoad: z.boolean(),
      }),
    ),
    total: z.number(),
  }),
  annotations: { readOnlyHint: true },
})

const routerBuildLocationContract = defineAgentToolContract({
  name: 'router_build_location',
  title: 'Resolve a location',
  description:
    'Resolve a path into a full location (href, pathname, searchStr, hash, parsed search) WITHOUT navigating (TanStack buildLocation). Use to preview where a router_navigate would land or to read computed search params.',
  group: 'router',
  input: toOptionsSchema,
  output: z.object({
    href: z.string(),
    pathname: z.string(),
    searchStr: z.string(),
    hash: z.string(),
    search: z.unknown(),
  }),
  annotations: { readOnlyHint: true },
})

const routerMatchRouteContract = defineAgentToolContract({
  name: 'router_match_route',
  title: 'Match a route',
  description:
    'Test whether a path matches the current (or pending) location and return the extracted path params (TanStack matchRoute). Returns matched=false when it does not match.',
  group: 'router',
  input: z.object({
    to: z.string().describe('Path pattern to test, e.g. "/posts/$postId".'),
    pending: z.boolean().default(false).describe('Match against the pending location instead.'),
    fuzzy: z.boolean().default(false).describe('Allow matching a prefix of the location.'),
    includeSearch: z.boolean().default(false),
  }),
  output: z.object({ matched: z.boolean(), params: z.unknown() }),
  annotations: { readOnlyHint: true },
})

const routerNavigateContract = defineAgentToolContract({
  name: 'router_navigate',
  title: 'Navigate',
  description:
    'Drive client-side navigation to a path. Use an absolute path like "/about". Preview the destination first with router_build_location if unsure.',
  group: 'action',
  input: z.object({
    to: z.string(),
    replace: z.boolean().default(false),
    params: z.record(z.string(), z.unknown()).optional(),
    search: z.record(z.string(), z.unknown()).optional(),
    hash: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean(), pathname: z.string() }),
  annotations: { idempotentHint: false },
})

const routerPreloadContract = defineAgentToolContract({
  name: 'router_preload',
  title: 'Preload a route',
  description:
    'Warm the cache for a route by running its loader without navigating (TanStack preloadRoute). Returns the routeIds that were matched/loaded. A no-op (matched=0) if the router has preloading disabled.',
  group: 'action',
  input: toOptionsSchema,
  output: z.object({
    ok: z.boolean(),
    matched: z.number(),
    matchedRouteIds: z.array(z.string()),
  }),
  annotations: { idempotentHint: true },
})

const routerHistoryContract = defineAgentToolContract({
  name: 'router_history',
  title: 'History back/forward/go',
  description:
    'Move through the browser history stack: go back, go forward, or jump by a relative delta (TanStack router.history). Use delta with action="go" (negative = back).',
  group: 'action',
  input: z.object({
    action: z.enum(['back', 'forward', 'go']).default('back'),
    delta: z
      .number()
      .int()
      .default(-1)
      .describe('Relative offset for action="go"; negative goes back, positive forward.'),
  }),
  output: z.object({
    ok: z.boolean(),
    pathname: z.string(),
    canGoBack: z.boolean(),
    length: z.number(),
  }),
  annotations: { idempotentHint: false },
})

const routerInvalidateContract = defineAgentToolContract({
  name: 'router_invalidate',
  title: 'Invalidate router',
  description: 'Invalidate all route matches, forcing loaders to re-run.',
  group: 'action',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  annotations: { idempotentHint: true },
})

const routerLoadContract = defineAgentToolContract({
  name: 'router_load',
  title: 'Load current matches',
  description:
    'Run the loaders for the current matches (TanStack router.load), resolving once loading settles. Pair with router_invalidate to force a full reload.',
  group: 'action',
  input: z.object({}),
  output: z.object({ ok: z.boolean(), status: z.string() }),
  annotations: { idempotentHint: true },
})

const routerClearCacheContract = defineAgentToolContract({
  name: 'router_clear_cache',
  title: 'Clear router cache',
  description:
    'Drop cached (inactive) route matches so their loaders re-run on next visit (TanStack clearCache). Does not affect the current active matches.',
  group: 'action',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  annotations: { destructiveHint: true },
})

export function routerCollector(router: AnyRouter): GenieCollector {
  const registeredRouter = routerStoreOf(router)
  const routerId = registeredRouter
    ? registerRouterStore(registeredRouter, () => router.state).routerId
    : null
  return defineCollector({
    meta: { id: 'router', title: 'TanStack Router', description: 'Location, matches, navigation' },
    capabilities: ['router'],
    start: (ctx) => {
      const push = () => ctx.pushSnapshot('router', { pathname: router.state.location.pathname })
      const off = router.subscribe('onResolved', () => push())
      push()
      return off
    },
    tools: [
      defineCollectorTool({
        contract: routerGetStateContract,
        handler: () => {
          const { location, status, statusCode, isLoading, isTransitioning, loadedAt, matches } =
            router.state
          const pendingMatchCount = router.stores?.pendingMatches?.get?.()?.length ?? 0
          const browserLocation = readBrowserLocation()
          const locationSync: LocationSync =
            browserLocation === null
              ? 'unavailable'
              : sameLocation(location, browserLocation)
                ? 'matched'
                : 'mismatched'
          return {
            routerId,
            pathname: location.pathname,
            href: location.href,
            searchStr: location.searchStr,
            hash: location.hash,
            status,
            statusCode,
            isLoading,
            isTransitioning,
            loadedAt,
            matchCount: matches.length,
            pendingMatchCount,
            browserLocation,
            locationSync,
            snapshotAt: Date.now(),
          }
        },
      }),
      defineCollectorTool({
        contract: routerListMatchesContract,
        handler: ({ depth }) => ({
          matches: router.state.matches.map((match) => ({
            routeId: String(match.routeId),
            pathname: match.pathname,
            params: dehydrate(match.params, { depth: 2 }),
            search: dehydrate(match.search, { depth: 2 }),
            status: match.status,
            isFetching: match.isFetching,
            loaderData: dehydrate(match.loaderData, { depth }),
          })),
        }),
      }),
      defineCollectorTool({
        contract: routerListRoutesContract,
        handler: ({ includeRoot }) => {
          const entries = asRouteEntries(router.routesById)
          const routes = entries
            .filter((route) => includeRoot || !(route.isRoot || route.id === '__root__'))
            .map((route) => ({
              routeId: route.id,
              path: route.path,
              fullPath: route.fullPath,
              rank: route.rank,
              hasLoader: typeof route.options?.loader === 'function',
              hasBeforeLoad: typeof route.options?.beforeLoad === 'function',
            }))
          return { routes, total: routes.length }
        },
      }),
      defineCollectorTool({
        contract: routerBuildLocationContract,
        handler: ({ to, params, search, hash }) => {
          const opts: ToOptions<AnyRouter> = { to, params, search, hash }
          const location = router.buildLocation(opts)
          return {
            href: location.href,
            pathname: location.pathname,
            searchStr: location.searchStr,
            hash: location.hash,
            search: dehydrate(location.search, { depth: 3 }),
          }
        },
      }),
      defineCollectorTool({
        contract: routerMatchRouteContract,
        handler: ({ to, pending, fuzzy, includeSearch }) => {
          const location: ToOptions<AnyRouter> = { to }
          const result = router.matchRoute(location, { pending, fuzzy, includeSearch })
          return result === false
            ? { matched: false, params: undefined }
            : { matched: true, params: dehydrate(result, { depth: 2 }) }
        },
      }),
      defineCollectorTool({
        contract: routerNavigateContract,
        handler: async ({ to, replace, params, search, hash }) => {
          const opts: NavigateOptions<AnyRouter> = { to, replace, params, search, hash }
          await router.navigate(opts)
          return { ok: true, pathname: router.state.location.pathname }
        },
      }),
      defineCollectorTool({
        contract: routerPreloadContract,
        handler: async ({ to, params, search, hash }) => {
          const opts: NavigateOptions<AnyRouter> = { to, params, search, hash }
          const matches = await router.preloadRoute(opts)
          const matchedRouteIds = (matches ?? []).map((match) => String(match.routeId))
          return { ok: true, matched: matchedRouteIds.length, matchedRouteIds }
        },
      }),
      defineCollectorTool({
        contract: routerHistoryContract,
        handler: ({ action, delta }) => {
          const { history } = router
          if (action === 'back') history.back()
          else if (action === 'forward') history.forward()
          else history.go(delta)
          return {
            ok: true,
            pathname: router.state.location.pathname,
            canGoBack: history.canGoBack(),
            length: history.length,
          }
        },
      }),
      defineCollectorTool({
        contract: routerInvalidateContract,
        handler: async () => {
          await router.invalidate()
          return { ok: true }
        },
      }),
      defineCollectorTool({
        contract: routerLoadContract,
        handler: async () => {
          await router.load()
          return { ok: true, status: router.state.status }
        },
      }),
      defineCollectorTool({
        contract: routerClearCacheContract,
        handler: () => {
          router.clearCache()
          return { ok: true }
        },
      }),
    ],
  })
}

function routerStoreOf(router: AnyRouter): object | null {
  const stores = (router as unknown as { stores?: { __store?: unknown } }).stores
  return typeof stores?.__store === 'object' && stores.__store !== null ? stores.__store : null
}

interface ComparableLocation {
  pathname: string
  searchStr?: string
  search?: string
  hash?: string
}

type LocationSync = 'matched' | 'mismatched' | 'unavailable'

function readBrowserLocation(): {
  href: string
  pathname: string
  search: string
  hash: string
} | null {
  if (typeof globalThis.location === 'undefined') return null
  const { href, pathname, search, hash } = globalThis.location
  return { href, pathname, search, hash }
}

function sameLocation(router: ComparableLocation, browser: ComparableLocation): boolean {
  const routerSearch = router.searchStr ?? router.search ?? ''
  return (
    router.pathname === browser.pathname &&
    normalizePrefix(routerSearch, '?') === normalizePrefix(browser.search ?? '', '?') &&
    normalizePrefix(router.hash ?? '', '#') === normalizePrefix(browser.hash ?? '', '#')
  )
}

function normalizePrefix(value: string, prefix: '?' | '#'): string {
  if (value === '') return ''
  return value.startsWith(prefix) ? value : `${prefix}${value}`
}
