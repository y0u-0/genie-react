import type { QueryClient, QueryFunction } from '@tanstack/react-query'
import { z } from 'zod'
import { defineCollector, defineCollectorTool, type GenieCollector } from '../../client'
import { defineAgentToolContract, dehydrate } from '../../protocol'

type CachedQuery = ReturnType<ReturnType<QueryClient['getQueryCache']>['getAll']>[number]
type CachedMutation = ReturnType<ReturnType<QueryClient['getMutationCache']>['getAll']>[number]

function formatError(error: unknown): string | undefined {
  if (error == null) return undefined
  return error instanceof Error ? error.message : String(error)
}

type QueryCacheRef = ReturnType<QueryClient['getQueryCache']>

type QueryIdentifier = { queryHash?: string; queryKey?: unknown[] }

// Every query_list row carries both a queryHash and a queryKey, so single-entry tools accept either identifier.
const queryIdentifierFields = {
  queryHash: z.string().optional().describe('Exact queryHash from query_list.'),
  queryKey: z
    .array(z.unknown())
    .optional()
    .describe(
      'Exact query key, e.g. ["todos", 1]. Either identifier works; both come from query_list.',
    ),
}

const requireQueryIdentifier = 'Provide either queryHash or queryKey (both come from query_list).'

const hasQueryIdentifier = (value: QueryIdentifier): boolean =>
  value.queryHash !== undefined || value.queryKey !== undefined

function findQueryByIdentifier(cache: QueryCacheRef, id: QueryIdentifier): CachedQuery | undefined {
  if (id.queryHash !== undefined) return cache.get(id.queryHash)
  if (id.queryKey !== undefined) return cache.find({ queryKey: id.queryKey, exact: true })
  return undefined
}

function describeQueryIdentifier(id: QueryIdentifier): string {
  if (id.queryHash !== undefined) return `queryHash "${id.queryHash}"`
  return `queryKey ${JSON.stringify(id.queryKey)}`
}

const querySummarySchema = z.object({
  queryHash: z.string(),
  queryKey: z.unknown(),
  status: z.string(),
  fetchStatus: z.string(),
  isStale: z.boolean(),
  isActive: z.boolean(),
  observerCount: z.number(),
  dataUpdatedAt: z.number(),
  recentFetches: z.number().describe('Fetches recorded for this query in the last 10s.'),
  simulatedState: z.enum(['pending', 'error']).optional(),
  error: z.string().optional(),
})

const churnSchema = z.object({
  orphaned: z
    .number()
    .describe('Cached queries with zero observers — likely abandoned cache churn.'),
  families: z.array(
    z.object({
      keyPrefix: z.string(),
      count: z.number(),
      orphaned: z.number(),
    }),
  ),
})

const keyFilterSchema = z.object({
  queryKey: z
    .array(z.unknown())
    .optional()
    .describe('Query key prefix to match, e.g. ["todos"]. Omit to target all queries.'),
  exact: z.boolean().default(false).describe('Match the queryKey exactly instead of as a prefix.'),
})

const filterOutput = z.object({ ok: z.boolean(), matched: z.number() })

const queryListContract = defineAgentToolContract({
  name: 'query_list',
  title: 'List TanStack queries',
  description:
    'List all TanStack Query cache entries with status, staleness, fetchStatus, and observer counts. `churn` flags cache churn / orphaned keys (many near-duplicate entries with no observers, e.g. a query key built from a value re-created each render). Use a queryHash with query_get for the full state, or a queryKey with query_get_data for a light read.',
  group: 'query',
  input: z.object({
    staleOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  output: z.object({
    queries: z.array(querySummarySchema),
    total: z.number(),
    churn: churnSchema,
  }),
  annotations: { readOnlyHint: true },
})

const queryGetContract = defineAgentToolContract({
  name: 'query_get',
  title: 'Get a TanStack query',
  description:
    'Get the full state and depth-bounded data of one query by its queryHash or queryKey (from query_list). hasQueryFn tells you whether query_fetch / query_ensure can re-run it. fetchCount (total settled fetches) and recentFetches (fetches in the last 10s) together reveal a refetch storm (staleTime:0 / refetchInterval) in a single call.',
  group: 'query',
  input: z
    .object({
      ...queryIdentifierFields,
      path: z
        .array(z.union([z.string(), z.number()]))
        .optional()
        .describe('Drill into the data at this path before depth-bounding, e.g. ["items", 0].'),
      depth: z.number().int().min(1).max(6).default(3),
    })
    .refine((value) => hasQueryIdentifier(value), requireQueryIdentifier),
  output: z.object({
    queryHash: z.string(),
    queryKey: z.unknown(),
    status: z.string(),
    fetchStatus: z.string(),
    isStale: z.boolean(),
    isActive: z.boolean(),
    isInvalidated: z.boolean(),
    observerCount: z.number(),
    hasQueryFn: z.boolean(),
    gcTime: z.number().optional(),
    staleTime: z.number().optional(),
    dataUpdatedAt: z.number(),
    errorUpdatedAt: z.number(),
    dataUpdateCount: z.number(),
    errorUpdateCount: z.number(),
    fetchFailureCount: z.number(),
    fetchCount: z.number().describe('Total settled fetches (dataUpdateCount + errorUpdateCount).'),
    recentFetches: z.number().describe('Fetches recorded for this query in the last 10s.'),
    simulatedState: z
      .enum(['pending', 'error'])
      .optional()
      .describe('Present when query_simulate_state currently controls this cache entry.'),
    fetchMeta: z.unknown(),
    error: z.string().optional(),
    data: z.unknown(),
  }),
  annotations: { readOnlyHint: true },
})

const queryGetDataContract = defineAgentToolContract({
  name: 'query_get_data',
  title: 'Read query data by key',
  description:
    'Light, imperative read of one query by its queryKey or queryHash (TanStack getQueryData/getQueryState). Returns found=false when nothing is cached under that key. Prefer query_get when you need the full state.',
  group: 'query',
  input: z
    .object({
      ...queryIdentifierFields,
      path: z.array(z.union([z.string(), z.number()])).optional(),
      depth: z.number().int().min(1).max(6).default(3),
    })
    .refine((value) => hasQueryIdentifier(value), requireQueryIdentifier),
  output: z.object({
    found: z.boolean(),
    status: z.string().optional(),
    dataUpdatedAt: z.number().optional(),
    data: z.unknown(),
  }),
  annotations: { readOnlyHint: true },
})

const queryIsFetchingContract = defineAgentToolContract({
  name: 'query_is_fetching',
  title: 'Count in-flight queries/mutations',
  description:
    'Count queries currently fetching and mutations currently pending (TanStack isFetching/isMutating). Use to check whether the app is busy before reading or acting; optionally scope the fetching count to a queryKey.',
  group: 'query',
  input: z.object({
    queryKey: z
      .array(z.unknown())
      .optional()
      .describe('Limit the fetching count to queries matching this key prefix.'),
  }),
  output: z.object({ fetching: z.number(), mutating: z.number() }),
  annotations: { readOnlyHint: true },
})

const queryListMutationsContract = defineAgentToolContract({
  name: 'query_list_mutations',
  title: 'List TanStack mutations',
  description:
    'List the TanStack Query mutation cache entries with status and variables. Use a mutationId with mutation_get for full state or mutation_rerun to re-execute one.',
  group: 'query',
  input: z.object({}),
  output: z.object({
    mutations: z.array(
      z.object({
        mutationId: z.number(),
        status: z.string(),
        variables: z.unknown(),
        error: z.string().optional(),
        submittedAt: z.number().optional(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true },
})

const mutationGetContract = defineAgentToolContract({
  name: 'mutation_get',
  title: 'Get a TanStack mutation',
  description:
    'Get the full state of one mutation by its mutationId (from query_list_mutations). hasMutationFn tells you whether mutation_rerun can re-execute it.',
  group: 'query',
  input: z.object({
    mutationId: z.number().int(),
    depth: z.number().int().min(1).max(6).default(3),
  }),
  output: z.object({
    mutationId: z.number(),
    status: z.string(),
    mutationKey: z.unknown(),
    variables: z.unknown(),
    data: z.unknown(),
    isPaused: z.boolean(),
    failureCount: z.number(),
    failureReason: z.string().optional(),
    submittedAt: z.number(),
    gcTime: z.number().optional(),
    hasMutationFn: z.boolean(),
    error: z.string().optional(),
  }),
  annotations: { readOnlyHint: true },
})

const queryInvalidateContract = defineAgentToolContract({
  name: 'query_invalidate',
  title: 'Invalidate queries',
  description: 'Invalidate matching queries — marks them stale and refetches the active ones.',
  group: 'action',
  input: keyFilterSchema,
  output: filterOutput,
  annotations: { idempotentHint: true },
})

const queryRefetchContract = defineAgentToolContract({
  name: 'query_refetch',
  title: 'Refetch queries',
  description:
    'Refetch matching queries immediately. Operates on existing cache entries; use query_fetch when you also want the resolved data returned.',
  group: 'action',
  input: keyFilterSchema,
  output: filterOutput,
  annotations: { idempotentHint: true },
})

const queryCancelContract = defineAgentToolContract({
  name: 'query_cancel',
  title: 'Cancel queries',
  description:
    'Cancel in-flight fetches for matching queries (TanStack cancelQueries). The previous data/state is preserved.',
  group: 'action',
  input: keyFilterSchema,
  output: filterOutput,
  annotations: { idempotentHint: true },
})

const queryResetContract = defineAgentToolContract({
  name: 'query_reset',
  title: 'Reset queries',
  description: 'Reset matching queries to their initial state.',
  group: 'action',
  input: keyFilterSchema,
  output: filterOutput,
  annotations: { idempotentHint: true },
})

const queryRemoveContract = defineAgentToolContract({
  name: 'query_remove',
  title: 'Remove queries',
  description: 'Remove matching queries from the cache entirely.',
  group: 'action',
  input: keyFilterSchema,
  output: filterOutput,
  annotations: { destructiveHint: true },
})

const queryClearContract = defineAgentToolContract({
  name: 'query_clear',
  title: 'Clear all caches',
  description:
    'Clear the entire query cache AND mutation cache (TanStack queryClient.clear()). Destructive — removes every entry, not just matches. Use query_remove to target specific keys.',
  group: 'action',
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    queriesCleared: z.number(),
    mutationsCleared: z.number(),
  }),
  annotations: { destructiveHint: true },
})

const querySetDataContract = defineAgentToolContract({
  name: 'query_set_data',
  title: 'Set query data',
  description: 'Imperatively set the cached data for a query key (optimistic-style write).',
  group: 'action',
  input: z.object({ queryKey: z.array(z.unknown()), data: z.unknown() }),
  output: z.object({ ok: z.boolean() }),
  annotations: { destructiveHint: true },
})

const querySimulateStateContract = defineAgentToolContract({
  name: 'query_simulate_state',
  title: 'Simulate query pending or error state',
  description:
    'Hold one existing query in a synthetic pending/loading or error state so its mounted UI can be inspected without changing app code or the server. Cancels a real in-flight fetch first, captures the stable state once, and notifies normal TanStack observers. A later query action can supersede the visible simulation; query_restore_state still restores the captured state. Always restore when finished.',
  group: 'action',
  input: z
    .object({
      ...queryIdentifierFields,
      state: z.enum(['pending', 'error']),
      errorMessage: z
        .string()
        .min(1)
        .default('Simulated query error')
        .describe('Error message used when state=error; ignored for pending.'),
    })
    .refine((value) => hasQueryIdentifier(value), requireQueryIdentifier),
  output: z.object({
    ok: z.boolean(),
    queryHash: z.string(),
    simulatedState: z.enum(['pending', 'error']),
    originalStatus: z.string(),
  }),
  annotations: { destructiveHint: true },
})

const queryRestoreStateContract = defineAgentToolContract({
  name: 'query_restore_state',
  title: 'Restore simulated query state',
  description:
    'Restore the exact stable state captured by query_simulate_state. Target one query by queryHash/queryKey, or pass all=true to clean up every query simulation. Returns the number actually restored.',
  group: 'action',
  input: z
    .object({
      ...queryIdentifierFields,
      all: z.boolean().default(false),
    })
    .refine(
      (value) => (value.all ? !hasQueryIdentifier(value) : hasQueryIdentifier(value)),
      'Provide exactly one query identifier, or all=true without an identifier.',
    ),
  output: z.object({ ok: z.boolean(), restored: z.number().int().nonnegative() }),
  annotations: { idempotentHint: true },
})

const queryFetchContract = defineAgentToolContract({
  name: 'query_fetch',
  title: 'Fetch a query and return data',
  description:
    'Fetch a query by key and return the resolved data (TanStack fetchQuery). Only works for queries that already have a queryFn — i.e. one with a mounted observer (a live useQuery) or a registered query default; otherwise it errors. staleTime defaults to 0 to force a network fetch. Use query_ensure to avoid refetching fresh data.',
  group: 'action',
  input: z.object({
    queryKey: z.array(z.unknown()).describe('Exact query key, e.g. ["todos"].'),
    staleTime: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Treat cached data younger than this many ms as fresh and skip the fetch.'),
    depth: z.number().int().min(1).max(6).default(3),
  }),
  output: z.object({
    data: z.unknown(),
    status: z.string(),
    dataUpdatedAt: z.number(),
  }),
  annotations: { idempotentHint: true },
})

const queryEnsureContract = defineAgentToolContract({
  name: 'query_ensure',
  title: 'Ensure query data',
  description:
    "Return a query's cached data, fetching it only if absent (TanStack ensureQueryData). Errors only when there is no cached data AND no queryFn (no mounted observer / registered default) to produce it. Use query_fetch to always hit the network.",
  group: 'action',
  input: z.object({
    queryKey: z.array(z.unknown()).describe('Exact query key, e.g. ["todos"].'),
    revalidateIfStale: z
      .boolean()
      .default(false)
      .describe('Kick off a background refetch when the cached data is stale.'),
    depth: z.number().int().min(1).max(6).default(3),
  }),
  output: z.object({
    data: z.unknown(),
    status: z.string(),
    dataUpdatedAt: z.number(),
  }),
  annotations: { idempotentHint: true },
})

const mutationRerunContract = defineAgentToolContract({
  name: 'mutation_rerun',
  title: 'Re-run a mutation',
  description:
    "Re-execute a mutation by its mutationId (from query_list_mutations), running its mutationFn and onSuccess/onError side effects again and updating any bound UI. Re-uses the mutation's own last variables unless you supply new ones. Requires the mutation to still hold its mutationFn (hasMutationFn on mutation_get).",
  group: 'action',
  input: z.object({
    mutationId: z.number().int(),
    variables: z
      .unknown()
      .optional()
      .describe('Override the variables passed to the mutationFn; omit to reuse the last ones.'),
  }),
  output: z.object({
    ok: z.boolean(),
    mutationId: z.number(),
    status: z.string(),
    data: z.unknown(),
    error: z.string().optional(),
  }),
  annotations: { idempotentHint: false },
})

const FETCH_RING_CAP = 50
const FETCH_RETENTION_MS = 60_000
const RECENT_FETCH_WINDOW_MS = 10_000

interface FetchActivity {
  timestamps: number[]
  lastFetchStatus: string
  lastDataUpdatedAt: number
  awaitingSettle: boolean
}

type SimulatedState = 'pending' | 'error'

interface QuerySimulation {
  query: CachedQuery
  originalState: CachedQuery['state']
  simulatedState: SimulatedState
}

/** Drops a normalized family key for a queryKey: JSON of the key minus its last element. */
function familyKey(queryKey: unknown): string {
  if (!Array.isArray(queryKey) || queryKey.length === 0) return JSON.stringify(queryKey)
  if (queryKey.length === 1) return JSON.stringify(queryKey[0])
  return JSON.stringify(queryKey.slice(0, -1))
}

export function queryCollector(queryClient: QueryClient): GenieCollector {
  const queryCache = () => queryClient.getQueryCache()
  const mutationCache = () => queryClient.getMutationCache()

  const fetchActivity = new Map<string, FetchActivity>()
  const querySimulations = new Map<string, QuerySimulation>()

  const simulationFor = (query: CachedQuery): QuerySimulation | undefined => {
    const simulation = querySimulations.get(query.queryHash)
    return simulation?.query === query ? simulation : undefined
  }

  const restoreSimulation = (simulation: QuerySimulation): boolean => {
    if (queryCache().get(simulation.query.queryHash) !== simulation.query) return false
    simulation.query.setState({ ...simulation.originalState })
    querySimulations.delete(simulation.query.queryHash)
    return true
  }

  const restoreAllSimulations = (): number => {
    let restored = 0
    for (const simulation of [...querySimulations.values()]) {
      if (restoreSimulation(simulation)) restored += 1
      else querySimulations.delete(simulation.query.queryHash)
    }
    return restored
  }

  const recordFetchActivity = (query: CachedQuery): void => {
    const now = Date.now()
    let entry = fetchActivity.get(query.queryHash)
    if (!entry) {
      entry = {
        timestamps: [],
        lastFetchStatus: query.state.fetchStatus,
        lastDataUpdatedAt: query.state.dataUpdatedAt,
        awaitingSettle: false,
      }
      fetchActivity.set(query.queryHash, entry)
    }
    const startedFetching =
      query.state.fetchStatus === 'fetching' && entry.lastFetchStatus !== 'fetching'
    const dataAdvanced = query.state.dataUpdatedAt > entry.lastDataUpdatedAt
    // Count a fetch once: prefer the start transition; a data bump only counts when the start was never observed.
    let fetched = false
    if (startedFetching) {
      fetched = true
      entry.awaitingSettle = true
    } else if (dataAdvanced && !entry.awaitingSettle) {
      fetched = true
    }
    if (dataAdvanced) entry.awaitingSettle = false
    if (fetched) {
      const cutoff = now - FETCH_RETENTION_MS
      entry.timestamps = entry.timestamps.filter((t) => t >= cutoff)
      entry.timestamps.push(now)
      if (entry.timestamps.length > FETCH_RING_CAP) {
        entry.timestamps.splice(0, entry.timestamps.length - FETCH_RING_CAP)
      }
    }
    entry.lastFetchStatus = query.state.fetchStatus
    entry.lastDataUpdatedAt = query.state.dataUpdatedAt
  }

  const recentFetches = (queryHash: string): number => {
    const entry = fetchActivity.get(queryHash)
    if (!entry) return 0
    const cutoff = Date.now() - RECENT_FETCH_WINDOW_MS
    return entry.timestamps.reduce((count, t) => (t >= cutoff ? count + 1 : count), 0)
  }

  const computeChurn = (queries: CachedQuery[]) => {
    let orphaned = 0
    const families = new Map<string, { count: number; orphaned: number }>()
    for (const query of queries) {
      const isOrphan = query.getObserversCount() === 0
      if (isOrphan) orphaned += 1
      const key = familyKey(query.queryKey)
      const family = families.get(key) ?? { count: 0, orphaned: 0 }
      family.count += 1
      if (isOrphan) family.orphaned += 1
      families.set(key, family)
    }
    const flagged = [...families.entries()]
      .filter(([, family]) => family.count >= 2 && family.orphaned >= 2)
      .map(([keyPrefix, family]) => ({ keyPrefix, count: family.count, orphaned: family.orphaned }))
      .sort((a, b) => b.orphaned - a.orphaned)
      .slice(0, 10)
    return { orphaned, families: flagged }
  }

  const summarize = (query: CachedQuery) => ({
    queryHash: query.queryHash,
    queryKey: dehydrate(query.queryKey, { depth: 3 }),
    status: query.state.status,
    fetchStatus: query.state.fetchStatus,
    isStale: query.isStale(),
    isActive: query.isActive(),
    observerCount: query.getObserversCount(),
    dataUpdatedAt: query.state.dataUpdatedAt,
    recentFetches: recentFetches(query.queryHash),
    simulatedState: simulationFor(query)?.simulatedState,
    error: formatError(query.state.error),
  })

  const summarizeMutation = (mutation: CachedMutation) => ({
    mutationId: mutation.mutationId,
    status: mutation.state.status,
    variables: dehydrate(mutation.state.variables, { depth: 2 }),
    error: formatError(mutation.state.error),
    submittedAt: mutation.state.submittedAt,
  })

  const countMatched = (queryKey: unknown[] | undefined, exact: boolean) =>
    queryCache().findAll({ queryKey, exact }).length

  const findMutation = (mutationId: number): CachedMutation | undefined =>
    mutationCache()
      .getAll()
      .find((mutation) => mutation.mutationId === mutationId)

  const resolveQueryFn = (queryKey: readonly unknown[]): QueryFunction | undefined => {
    const query = queryCache().find({ queryKey, exact: true })
    if (typeof query?.options.queryFn === 'function') return query.options.queryFn
    const observed = query?.observers.find(
      (observer) => typeof observer.options.queryFn === 'function',
    )
    // The typeof check above proves a QueryFunction; the cast just drops the observer's own generic type.
    if (observed) return observed.options.queryFn as QueryFunction
    const fallback = queryClient.getQueryDefaults(queryKey).queryFn
    return typeof fallback === 'function' ? fallback : undefined
  }

  const observerStaleTime = (query: CachedQuery): number | undefined => {
    for (const observer of query.observers) {
      const { staleTime } = observer.options
      if (typeof staleTime === 'number') return staleTime
    }
    return undefined
  }

  return defineCollector({
    meta: { id: 'query', title: 'TanStack Query', description: 'Query + mutation cache' },
    capabilities: ['query'],
    start: (ctx) => {
      let scheduled = false
      const push = () => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          ctx.pushSnapshot('query', { queries: queryCache().getAll().length })
        })
      }
      const offQuery = queryCache().subscribe((event) => {
        if (event.type === 'removed') {
          fetchActivity.delete(event.query.queryHash)
          if (simulationFor(event.query)) querySimulations.delete(event.query.queryHash)
        } else if (!simulationFor(event.query)) {
          recordFetchActivity(event.query)
        }
        push()
      })
      const offMutation = mutationCache().subscribe(push)
      push()
      return () => {
        offQuery()
        offMutation()
        restoreAllSimulations()
      }
    },
    tools: [
      defineCollectorTool({
        contract: queryListContract,
        handler: ({ staleOnly, limit }) => {
          const everyQuery = queryCache().getAll()
          const all = everyQuery.filter((query) => !staleOnly || query.isStale())
          return {
            queries: all.slice(0, limit).map(summarize),
            total: all.length,
            churn: computeChurn(everyQuery),
          }
        },
      }),
      defineCollectorTool({
        contract: queryGetContract,
        handler: ({ queryHash, queryKey, path, depth }) => {
          const query = findQueryByIdentifier(queryCache(), { queryHash, queryKey })
          if (!query) {
            throw new Error(
              `Query not found for ${describeQueryIdentifier({ queryHash, queryKey })}.`,
            )
          }
          return {
            queryHash: query.queryHash,
            queryKey: dehydrate(query.queryKey, { depth: 3 }),
            status: query.state.status,
            fetchStatus: query.state.fetchStatus,
            isStale: query.isStale(),
            isActive: query.isActive(),
            isInvalidated: query.state.isInvalidated,
            observerCount: query.getObserversCount(),
            hasQueryFn: resolveQueryFn(query.queryKey) !== undefined,
            gcTime: query.gcTime,
            staleTime: observerStaleTime(query),
            dataUpdatedAt: query.state.dataUpdatedAt,
            errorUpdatedAt: query.state.errorUpdatedAt,
            dataUpdateCount: query.state.dataUpdateCount,
            errorUpdateCount: query.state.errorUpdateCount,
            fetchFailureCount: query.state.fetchFailureCount,
            fetchCount: query.state.dataUpdateCount + query.state.errorUpdateCount,
            recentFetches: recentFetches(query.queryHash),
            simulatedState: simulationFor(query)?.simulatedState,
            fetchMeta: dehydrate(query.state.fetchMeta, { depth: 2 }),
            error: formatError(query.state.error),
            data: dehydrate(query.state.data, { depth, path }),
          }
        },
      }),
      defineCollectorTool({
        contract: queryGetDataContract,
        handler: ({ queryHash, queryKey, path, depth }) => {
          const key = queryKey ?? findQueryByIdentifier(queryCache(), { queryHash })?.queryKey
          if (key === undefined) {
            return { found: false, status: undefined, dataUpdatedAt: undefined, data: undefined }
          }
          const state = queryClient.getQueryState(key)
          return {
            found: state !== undefined,
            status: state?.status,
            dataUpdatedAt: state?.dataUpdatedAt,
            data: dehydrate(queryClient.getQueryData(key), { depth, path }),
          }
        },
      }),
      defineCollectorTool({
        contract: queryIsFetchingContract,
        handler: ({ queryKey }) => ({
          fetching: queryClient.isFetching(queryKey ? { queryKey } : undefined),
          mutating: queryClient.isMutating(),
        }),
      }),
      defineCollectorTool({
        contract: queryListMutationsContract,
        handler: () => ({ mutations: mutationCache().getAll().map(summarizeMutation) }),
      }),
      defineCollectorTool({
        contract: mutationGetContract,
        handler: ({ mutationId, depth }) => {
          const mutation = findMutation(mutationId)
          if (!mutation) throw new Error(`Mutation ${mutationId} not found.`)
          const { state } = mutation
          return {
            mutationId: mutation.mutationId,
            status: state.status,
            mutationKey: dehydrate(mutation.options.mutationKey, { depth: 2 }),
            variables: dehydrate(state.variables, { depth }),
            data: dehydrate(state.data, { depth }),
            isPaused: state.isPaused,
            failureCount: state.failureCount,
            failureReason: formatError(state.failureReason),
            submittedAt: state.submittedAt,
            gcTime: mutation.gcTime,
            hasMutationFn: typeof mutation.options.mutationFn === 'function',
            error: formatError(state.error),
          }
        },
      }),
      defineCollectorTool({
        contract: queryInvalidateContract,
        handler: async ({ queryKey, exact }) => {
          const matched = countMatched(queryKey, exact)
          await queryClient.invalidateQueries({ queryKey, exact })
          return { ok: true, matched }
        },
      }),
      defineCollectorTool({
        contract: queryRefetchContract,
        handler: async ({ queryKey, exact }) => {
          const matched = countMatched(queryKey, exact)
          await queryClient.refetchQueries({ queryKey, exact })
          return { ok: true, matched }
        },
      }),
      defineCollectorTool({
        contract: queryCancelContract,
        handler: async ({ queryKey, exact }) => {
          const matched = countMatched(queryKey, exact)
          await queryClient.cancelQueries({ queryKey, exact })
          return { ok: true, matched }
        },
      }),
      defineCollectorTool({
        contract: queryResetContract,
        handler: async ({ queryKey, exact }) => {
          const matched = countMatched(queryKey, exact)
          await queryClient.resetQueries({ queryKey, exact })
          return { ok: true, matched }
        },
      }),
      defineCollectorTool({
        contract: queryRemoveContract,
        handler: ({ queryKey, exact }) => {
          for (const query of queryCache().findAll({ queryKey, exact })) {
            querySimulations.delete(query.queryHash)
          }
          const matched = countMatched(queryKey, exact)
          queryClient.removeQueries({ queryKey, exact })
          return { ok: true, matched }
        },
      }),
      defineCollectorTool({
        contract: queryClearContract,
        handler: () => {
          const queriesCleared = queryCache().getAll().length
          const mutationsCleared = mutationCache().getAll().length
          querySimulations.clear()
          queryClient.clear()
          return { ok: true, queriesCleared, mutationsCleared }
        },
      }),
      defineCollectorTool({
        contract: querySetDataContract,
        handler: ({ queryKey, data }) => {
          queryClient.setQueryData(queryKey, () => data)
          return { ok: true }
        },
      }),
      defineCollectorTool({
        contract: querySimulateStateContract,
        handler: async ({ queryHash, queryKey, state, errorMessage }) => {
          let query = findQueryByIdentifier(queryCache(), { queryHash, queryKey })
          if (!query) {
            throw new Error(
              `Query not found for ${describeQueryIdentifier({ queryHash, queryKey })}.`,
            )
          }

          await queryClient.cancelQueries({ queryKey: query.queryKey, exact: true })
          query = findQueryByIdentifier(queryCache(), { queryHash, queryKey })
          if (!query) throw new Error('Query was removed while its in-flight fetch was cancelled.')

          const existing = simulationFor(query)
          const simulation: QuerySimulation = existing ?? {
            query,
            originalState: { ...query.state },
            simulatedState: state,
          }
          simulation.simulatedState = state
          querySimulations.set(query.queryHash, simulation)

          if (state === 'pending') {
            query.setState({
              data: undefined,
              error: null,
              fetchFailureReason: null,
              fetchMeta: null,
              fetchStatus: 'fetching',
              status: 'pending',
            })
          } else {
            const error = new Error(errorMessage)
            query.setState({
              data: undefined,
              error,
              errorUpdatedAt: Date.now(),
              fetchFailureReason: error,
              fetchMeta: null,
              fetchStatus: 'idle',
              status: 'error',
            })
          }

          return {
            ok: true,
            queryHash: query.queryHash,
            simulatedState: state,
            originalStatus: simulation.originalState.status,
          }
        },
      }),
      defineCollectorTool({
        contract: queryRestoreStateContract,
        handler: ({ queryHash, queryKey, all }) => {
          if (all) return { ok: true, restored: restoreAllSimulations() }

          const query = findQueryByIdentifier(queryCache(), { queryHash, queryKey })
          const simulation = query && simulationFor(query)
          if (!simulation) {
            throw new Error(
              `No simulated state exists for ${describeQueryIdentifier({ queryHash, queryKey })}.`,
            )
          }
          return { ok: true, restored: restoreSimulation(simulation) ? 1 : 0 }
        },
      }),
      defineCollectorTool({
        contract: queryFetchContract,
        handler: async ({ queryKey, staleTime, depth }) => {
          const queryFn = resolveQueryFn(queryKey)
          if (!queryFn) {
            throw new Error(
              `No queryFn available for ${JSON.stringify(queryKey)}. query_fetch needs a mounted observer (a live useQuery) with a cache entry, or a registered query default — after query_remove the observer re-attaches only on its next render, so interact with the UI first. Use query_refetch or query_invalidate to refresh existing cache entries instead.`,
            )
          }
          const data = await queryClient.fetchQuery({
            queryKey,
            queryFn,
            staleTime,
          })
          const state = queryClient.getQueryState(queryKey)
          return {
            data: dehydrate(data, { depth }),
            status: state?.status ?? 'success',
            dataUpdatedAt: state?.dataUpdatedAt ?? 0,
          }
        },
      }),
      defineCollectorTool({
        contract: queryEnsureContract,
        handler: async ({ queryKey, revalidateIfStale, depth }) => {
          const queryFn = resolveQueryFn(queryKey)
          const hasData = queryClient.getQueryData(queryKey) !== undefined
          if (!hasData && !queryFn) {
            throw new Error(
              `Query ${JSON.stringify(queryKey)} has no cached data and no queryFn (no mounted observer or registered default) to fetch it.`,
            )
          }
          const data = await queryClient.ensureQueryData({
            queryKey,
            queryFn,
            revalidateIfStale,
          })
          const state = queryClient.getQueryState(queryKey)
          return {
            data: dehydrate(data, { depth }),
            status: state?.status ?? 'success',
            dataUpdatedAt: state?.dataUpdatedAt ?? 0,
          }
        },
      }),
      defineCollectorTool({
        contract: mutationRerunContract,
        handler: async ({ mutationId, variables }) => {
          const mutation = findMutation(mutationId)
          if (!mutation) throw new Error(`Mutation ${mutationId} not found.`)
          if (typeof mutation.options.mutationFn !== 'function') {
            throw new Error(
              `Mutation ${mutationId} has no mutationFn registered (likely dehydrated/restored without its function); it cannot be re-run.`,
            )
          }
          const nextVariables = variables === undefined ? mutation.state.variables : variables
          try {
            const data = await mutation.execute(nextVariables)
            return {
              ok: true,
              mutationId,
              status: mutation.state.status,
              data: dehydrate(data, { depth: 3 }),
            }
          } catch (error) {
            return {
              ok: false,
              mutationId,
              status: mutation.state.status,
              data: undefined,
              error: formatError(error),
            }
          }
        },
      }),
    ],
  })
}
