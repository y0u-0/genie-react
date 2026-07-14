import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CollectorContext, GenieCollector } from '../../client'
import {
  isRegisteredQueryObserver,
  registerQuerySubscriber,
  resetExternalStoreRegistryForTests,
  setExternalStoreObservation,
} from '../causal/external-store-registry'
import { queryCollector } from './query'

const ctx: CollectorContext = {
  pushSnapshot() {},
  pushEvent() {},
  refreshTools() {},
  markActivity() {},
}

function call<T = unknown>(collector: GenieCollector, name: string, args: unknown): Promise<T> | T {
  const tool = collector.tools?.find((t) => t.contract.name === name)
  if (!tool) throw new Error(`tool not found: ${name}`)
  return tool.handler(args as never, ctx) as Promise<T> | T
}

beforeEach(() => resetExternalStoreRegistryForTests())

describe('queryCollector', () => {
  it('registers existing and newly subscribed observers when the collector starts', () => {
    const client = new QueryClient()
    client.setQueryData(['existing'], 'ready')
    const existing = new QueryObserver(client, { queryKey: ['existing'] })
    const unsubscribeExisting = existing.subscribe(() => {})
    const collector = queryCollector(client)

    expect(isRegisteredQueryObserver(existing)).toBe(false)
    const stop = collector.start?.(ctx)
    expect(isRegisteredQueryObserver(existing)).toBe(true)

    client.setQueryData(['late'], 'ready')
    const late = new QueryObserver(client, { queryKey: ['late'] })
    expect(isRegisteredQueryObserver(late)).toBe(false)
    const unsubscribeLate = late.subscribe(() => {})
    expect(isRegisteredQueryObserver(late)).toBe(true)

    unsubscribeLate()
    unsubscribeExisting()
    stop?.()
  })

  it('query_list reports every cache entry with status and counts', async () => {
    const client = new QueryClient()
    client.setQueryData(['todos'], [{ id: 1 }])
    client.setQueryData(['users'], [{ id: 2 }])
    const collector = queryCollector(client)

    const result = (await call(collector, 'query_list', { staleOnly: false, limit: 100 })) as {
      queries: Array<{ queryHash: string; queryKey: unknown; status: string; fetchStatus: string }>
      total: number
    }

    expect(result.total).toBe(2)
    expect(result.queries).toHaveLength(2)
    const todos = result.queries.find((q) => JSON.stringify(q.queryKey) === '["todos"]')
    expect(todos?.status).toBe('success')
    expect(todos?.fetchStatus).toBe('idle')
    expect(typeof todos?.queryHash).toBe('string')
  })

  it('query_get returns depth-bounded data for a queryHash', async () => {
    const client = new QueryClient()
    client.setQueryData(['profile'], { name: 'Ada', roles: ['admin'] })
    const collector = queryCollector(client)
    const queryHash = client.getQueryCache().getAll()[0]?.queryHash as string

    const result = (await call(collector, 'query_get', { queryHash, depth: 3 })) as {
      queryHash: string
      status: string
      data: unknown
    }

    expect(result.queryHash).toBe(queryHash)
    expect(result.status).toBe('success')
    expect(result.data).toEqual({ name: 'Ada', roles: ['admin'] })
  })

  it('query_get exposes observer policy and temporal component subscriber evidence', async () => {
    const client = new QueryClient()
    client.setQueryData(['todos'], [{ id: 1 }])
    const observer = new QueryObserver(client, {
      queryKey: ['todos'],
      queryFn: async () => [{ id: 1 }],
      notifyOnChangeProps: ['data'],
      select: (rows) => rows.length,
    })
    const unsubscribe = observer.subscribe(() => {})
    setExternalStoreObservation({ id: 'observation:1' })
    registerQuerySubscriber(observer, {
      subscriberId: 'subscriber:mount:1:0',
      componentId: 7,
      componentName: 'TodoCount',
      mountId: 'mount:1',
      hookIndex: 3,
      externalStoreIndex: 0,
      observationId: 'observation:1',
      documentCommitId: 7,
      renderEventId: 'render:7:3',
      commitId: 3,
    })
    const collector = queryCollector(client)
    const queryHash = client.getQueryCache().getAll()[0]?.queryHash as string

    const result = (await call(collector, 'query_get', { queryHash, depth: 3 })) as {
      observers: Array<Record<string, unknown>>
    }
    expect(result.observers).toMatchObject([
      {
        notificationPolicy: {
          mode: 'fields',
          fields: ['data'],
          trackedFieldsAvailable: true,
        },
        deliveryEvidence: 'policy-explicit',
        hasSelect: true,
        subscriberObservationStatus: 'current-observation',
        subscriber: {
          subscriberId: 'subscriber:mount:1:0',
          componentId: 7,
          componentName: 'TodoCount',
          observationId: 'observation:1',
          documentCommitId: 7,
          renderEventId: 'render:7:3',
          commitId: 3,
        },
      },
    ])

    setExternalStoreObservation({ id: 'observation:2' })
    const afterClear = (await call(collector, 'query_get', { queryHash, depth: 3 })) as {
      observers: Array<Record<string, unknown>>
    }
    expect(afterClear.observers).toMatchObject([
      {
        subscriberObservationStatus: 'previous-observation',
        subscriber: {
          observationId: 'observation:1',
          documentCommitId: 7,
        },
      },
    ])
    unsubscribe()
  })

  it('query_notifications records exact tracked-field delivery and structural sharing', async () => {
    const client = new QueryClient()
    const sharedItems = [{ id: 1 }]
    client.setQueryData(['tracked'], { items: sharedItems, label: 'before' })
    const observer = new QueryObserver(client, {
      queryKey: ['tracked'],
      queryFn: async () => ({ items: sharedItems, label: 'before' }),
    })
    const unsubscribe = observer.subscribe(() => {})
    const collector = queryCollector(client)
    const stop = collector.start?.(ctx)
    setExternalStoreObservation({ id: 'observation:notification' })

    observer.trackProp('data')
    client.setQueryData(['tracked'], { items: sharedItems, label: 'after' })
    await Promise.resolve()

    const result = (await call(collector, 'query_notifications', { limit: 10 })) as {
      events: Array<{
        notificationId: string
        observationId: string | null
        trackedFields: string[]
        trackedFieldsCoverage: string
        changedResultFields: string[]
        deliveryReason: string
        fanout: number
        structuralSharing: { reusedFields: string[]; changedFields: string[] }
        renderEventIds: string[]
      }>
      omittedByLimit: number
    }
    expect(result.omittedByLimit).toBe(0)
    expect(result.events[0]).toMatchObject({
      notificationId: expect.stringMatching(/^query-notification:/),
      observationId: 'observation:notification',
      trackedFields: ['data'],
      trackedFieldsCoverage: 'exact',
      deliveryReason: 'tracked-field-changed:data',
      fanout: 1,
      renderEventIds: [],
    })
    expect(result.events[0]?.changedResultFields).toContain('data')
    expect(result.events[0]?.structuralSharing.changedFields).toContain('data')
    expect(result.events[0]?.structuralSharing.reusedFields).toContain('status')

    const queryHash = client.getQueryCache().getAll()[0]?.queryHash as string
    const detail = (await call(collector, 'query_get', { queryHash, depth: 2 })) as {
      observers: Array<Record<string, unknown>>
    }
    expect(detail.observers[0]).toMatchObject({
      notificationPolicy: {
        mode: 'auto-tracked',
        fields: ['data'],
        trackedFieldsAvailable: true,
      },
      deliveryEvidence: 'public-track-prop-observed',
    })

    stop?.()
    unsubscribe()
  })

  it('query_get bounds observer detail and reports omissions', async () => {
    const client = new QueryClient()
    client.setQueryData(['shared'], 'ready')
    const observers = Array.from(
      { length: 103 },
      () =>
        new QueryObserver(client, {
          queryKey: ['shared'],
          queryFn: async () => 'ready',
        }),
    )
    const unsubscribes = observers.map((observer) => observer.subscribe(() => {}))
    const collector = queryCollector(client)
    const queryHash = client.getQueryCache().getAll()[0]?.queryHash as string

    const result = (await call(collector, 'query_get', { queryHash, depth: 3 })) as {
      observerCount: number
      observersOmitted: number
      observers: unknown[]
    }

    expect(result.observerCount).toBe(103)
    expect(result.observers).toHaveLength(100)
    expect(result.observersOmitted).toBe(3)
    for (const unsubscribe of unsubscribes) unsubscribe()
  })

  it('query_get throws for an unknown queryHash', () => {
    const collector = queryCollector(new QueryClient())
    expect(() => call(collector, 'query_get', { queryHash: 'missing', depth: 3 })).toThrow(
      /not found/,
    )
  })

  it('query_get resolves a query by queryKey, not only queryHash', async () => {
    const client = new QueryClient()
    client.setQueryData(['profile'], { name: 'Ada' })
    const collector = queryCollector(client)

    const result = (await call(collector, 'query_get', { queryKey: ['profile'], depth: 3 })) as {
      queryKey: unknown
      data: unknown
    }

    expect(result.queryKey).toEqual(['profile'])
    expect(result.data).toEqual({ name: 'Ada' })
  })

  it('query_get_data resolves a query by queryHash, not only queryKey', async () => {
    const client = new QueryClient()
    client.setQueryData(['profile'], { name: 'Ada' })
    const collector = queryCollector(client)
    const queryHash = client.getQueryCache().getAll()[0]?.queryHash as string

    const result = (await call(collector, 'query_get_data', { queryHash, depth: 3 })) as {
      found: boolean
      data: unknown
    }

    expect(result.found).toBe(true)
    expect(result.data).toEqual({ name: 'Ada' })
  })

  it('query_get / query_get_data require at least one identifier', () => {
    const collector = queryCollector(new QueryClient())
    for (const name of ['query_get', 'query_get_data'] as const) {
      const input = collector.tools?.find((t) => t.contract.name === name)?.contract.input
      expect(input?.safeParse({}).success).toBe(false)
      expect(input?.safeParse({ queryKey: ['x'] }).success).toBe(true)
      expect(input?.safeParse({ queryHash: '["x"]' }).success).toBe(true)
    }
  })

  it('query_invalidate reports how many cache entries it matched', async () => {
    const client = new QueryClient()
    client.setQueryData(['todos'], [])
    client.setQueryData(['todos', 'done'], [])
    client.setQueryData(['users'], [])
    const collector = queryCollector(client)

    const prefix = (await call(collector, 'query_invalidate', {
      queryKey: ['todos'],
      exact: false,
    })) as { ok: boolean; matched: number }
    expect(prefix).toEqual({ ok: true, matched: 2 })

    const exact = (await call(collector, 'query_invalidate', {
      queryKey: ['todos'],
      exact: true,
    })) as { ok: boolean; matched: number }
    expect(exact).toEqual({ ok: true, matched: 1 })
  })

  it('query_set_data writes data that round-trips through query_get', async () => {
    const client = new QueryClient()
    const collector = queryCollector(client)

    const written = await call(collector, 'query_set_data', {
      queryKey: ['settings'],
      data: { theme: 'dark', count: 3 },
    })
    expect(written).toEqual({ ok: true })

    const queryHash = client.getQueryCache().getAll()[0]?.queryHash as string
    const read = (await call(collector, 'query_get', { queryHash, depth: 3 })) as { data: unknown }
    expect(read.data).toEqual({ theme: 'dark', count: 3 })
  })

  it('query_simulate_state exposes pending and error states, then restores the original', async () => {
    const client = new QueryClient()
    client.setQueryData(['greeting'], { message: 'hello' })
    const collector = queryCollector(client)
    const queryHash = client.getQueryCache().getAll()[0]?.queryHash as string

    const pending = await call(collector, 'query_simulate_state', {
      queryHash,
      state: 'pending',
      errorMessage: 'ignored',
    })
    expect(pending).toEqual({
      ok: true,
      queryHash,
      simulatedState: 'pending',
      originalStatus: 'success',
    })
    expect(client.getQueryState(['greeting'])).toMatchObject({
      data: undefined,
      error: null,
      status: 'pending',
      fetchStatus: 'fetching',
    })

    await call(collector, 'query_simulate_state', {
      queryKey: ['greeting'],
      state: 'error',
      errorMessage: 'Demo failed',
    })
    const forced = client.getQueryState(['greeting'])
    expect(forced).toMatchObject({
      data: undefined,
      status: 'error',
      fetchStatus: 'idle',
    })
    expect(forced?.error).toEqual(new Error('Demo failed'))

    const read = (await call(collector, 'query_get', { queryHash, depth: 3 })) as {
      status: string
      simulatedState?: string
      error?: string
    }
    expect(read).toMatchObject({
      status: 'error',
      simulatedState: 'error',
      error: 'Demo failed',
    })

    const restored = await call(collector, 'query_restore_state', { queryHash, all: false })
    expect(restored).toEqual({ ok: true, restored: 1 })
    expect(client.getQueryState(['greeting'])).toMatchObject({
      data: { message: 'hello' },
      error: null,
      status: 'success',
      fetchStatus: 'idle',
    })
  })

  it('query_restore_state restores every simulated query and rejects missing targets', async () => {
    const client = new QueryClient()
    client.setQueryData(['one'], 1)
    client.setQueryData(['two'], 2)
    const collector = queryCollector(client)

    await call(collector, 'query_simulate_state', { queryKey: ['one'], state: 'pending' })
    await call(collector, 'query_simulate_state', { queryKey: ['two'], state: 'error' })

    expect(await call(collector, 'query_restore_state', { all: true })).toEqual({
      ok: true,
      restored: 2,
    })
    expect(client.getQueryData(['one'])).toBe(1)
    expect(client.getQueryData(['two'])).toBe(2)
    expect(() =>
      call(collector, 'query_restore_state', { queryKey: ['missing'], all: false }),
    ).toThrow(/No simulated state/)
  })

  it('restores simulations when collector instrumentation is disposed', async () => {
    const client = new QueryClient()
    client.setQueryData(['greeting'], 'hello')
    const collector = queryCollector(client)
    const stop = collector.start?.(ctx)

    await call(collector, 'query_simulate_state', {
      queryKey: ['greeting'],
      state: 'pending',
    })
    expect(client.getQueryState(['greeting'])?.status).toBe('pending')

    stop?.()
    expect(client.getQueryState(['greeting'])).toMatchObject({
      data: 'hello',
      status: 'success',
      fetchStatus: 'idle',
    })
  })

  it('query simulation contracts require an exact target and restoration target or all=true', () => {
    const collector = queryCollector(new QueryClient())
    const simulate = collector.tools?.find((tool) => tool.contract.name === 'query_simulate_state')
      ?.contract.input
    const restore = collector.tools?.find((tool) => tool.contract.name === 'query_restore_state')
      ?.contract.input

    expect(simulate?.safeParse({ state: 'pending' }).success).toBe(false)
    expect(simulate?.safeParse({ queryKey: ['x'], state: 'pending' }).success).toBe(true)
    expect(restore?.safeParse({ all: false }).success).toBe(false)
    expect(restore?.safeParse({ all: true }).success).toBe(true)
    expect(restore?.safeParse({ all: true, queryKey: ['x'] }).success).toBe(false)
  })

  it('query_list_mutations is empty for a fresh client', async () => {
    const collector = queryCollector(new QueryClient())
    const result = (await call(collector, 'query_list_mutations', {})) as { mutations: unknown[] }
    expect(result.mutations).toEqual([])
  })

  it('query_list churn flags orphaned cache families', async () => {
    const client = new QueryClient()
    client.setQueryData(['metrics', 'alpha'], 1)
    client.setQueryData(['metrics', 'beta'], 2)
    client.setQueryData(['metrics', 'gamma'], 3)
    client.setQueryData(['settings'], { theme: 'dark' })
    const collector = queryCollector(client)

    const result = (await call(collector, 'query_list', { staleOnly: false, limit: 100 })) as {
      total: number
      churn: {
        orphaned: number
        families: Array<{ keyPrefix: string; count: number; orphaned: number }>
      }
    }

    expect(result.churn.orphaned).toBeGreaterThanOrEqual(3)
    const metrics = result.churn.families.find((f) => f.keyPrefix === JSON.stringify(['metrics']))
    expect(metrics).toBeDefined()
    expect(metrics?.count).toBe(3)
    expect(metrics?.orphaned).toBe(3)
    expect(result.churn.families.some((f) => f.keyPrefix === JSON.stringify('settings'))).toBe(
      false,
    )
  })

  it('query_list churn ignores families below the threshold', async () => {
    const client = new QueryClient()
    client.setQueryData(['solo', 'one'], 1)
    const collector = queryCollector(client)

    const result = (await call(collector, 'query_list', { staleOnly: false, limit: 100 })) as {
      churn: { orphaned: number; families: unknown[] }
    }

    expect(result.churn.orphaned).toBe(1)
    expect(result.churn.families).toEqual([])
  })

  it('query_get exposes fetchCount and recentFetches', async () => {
    const client = new QueryClient()
    client.setQueryData(['profile'], { name: 'Ada' })
    const collector = queryCollector(client)
    const queryHash = client.getQueryCache().getAll()[0]?.queryHash as string

    const result = (await call(collector, 'query_get', { queryHash, depth: 3 })) as {
      fetchCount: number
      recentFetches: number
    }

    expect(typeof result.fetchCount).toBe('number')
    expect(typeof result.recentFetches).toBe('number')
    expect(result.fetchCount).toBe(1)
    expect(result.recentFetches).toBe(0)
  })

  it('query_list per-entry summary carries recentFetches', async () => {
    const client = new QueryClient()
    client.setQueryData(['profile'], { name: 'Ada' })
    const collector = queryCollector(client)

    const result = (await call(collector, 'query_list', { staleOnly: false, limit: 100 })) as {
      queries: Array<{ recentFetches: number }>
    }

    expect(result.queries[0]?.recentFetches).toBe(0)
  })
})
