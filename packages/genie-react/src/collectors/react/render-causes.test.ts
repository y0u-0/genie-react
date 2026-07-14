import type { Fiber } from 'bippy'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  recordQueryNotification,
  registerQueryObserver,
  resetExternalStoreRegistryForTests,
} from '../causal/external-store-registry'
import { createRenderEvidenceBudget, inputCoverage } from './render-budget'
import { countExternalStoreHooks, diffExternalStoreChanges } from './render-causes'

interface HookNode {
  memoizedState: unknown
  queue?: unknown
  next: HookNode | null
}

const asFiber = (shape: unknown): Fiber => shape as Fiber

function hookChain(hooks: Array<Omit<HookNode, 'next'>>): HookNode | null {
  let next: HookNode | null = null
  for (let index = hooks.length - 1; index >= 0; index -= 1) {
    const hook = hooks[index]
    if (hook) next = { ...hook, next }
  }
  return next
}

function externalStoreHook(snapshot: unknown): Omit<HookNode, 'next'> {
  return {
    memoizedState: snapshot,
    queue: { value: snapshot, getSnapshot: () => snapshot },
  }
}

function causalFiber(
  currentHooks: Array<Omit<HookNode, 'next'>>,
  previousHooks: Array<Omit<HookNode, 'next'>>,
): Fiber {
  const type = (): null => null
  Object.assign(type, { displayName: 'QueryConsumer' })
  return asFiber({
    tag: 0,
    type,
    memoizedProps: {},
    memoizedState: hookChain(currentHooks),
    alternate: { memoizedProps: {}, memoizedState: hookChain(previousHooks) },
  })
}

function queryResult(updatedAt: number): Record<string, unknown> {
  return { status: 'success', fetchStatus: 'idle', dataUpdatedAt: updatedAt }
}

function queryObserver(queryHash: string): object {
  return {
    options: { queryHash },
    getCurrentQuery: () => ({ queryHash, queryKey: [queryHash] }),
    getCurrentResult: () => queryResult(2),
    subscribe: () => () => {},
  }
}

beforeEach(() => resetExternalStoreRegistryForTests())

describe('bounded causal inspection', () => {
  it('counts a normal terminal hook link exactly', () => {
    expect(
      countExternalStoreHooks(
        asFiber({ memoizedState: { ...externalStoreHook('value'), next: null } }),
      ),
    ).toBe(1)
  })

  it('returns an incomplete sentinel when a hostile hook chain cannot be counted', () => {
    const hook = externalStoreHook('value') as Record<string, unknown>
    Object.defineProperty(hook, 'next', {
      get: () => {
        throw new Error('must not run')
      },
    })

    expect(countExternalStoreHooks(asFiber({ memoizedState: hook }))).toBe(-1)
  })

  it('does not grant exact QueriesObserver evidence to unregistered lookalikes', () => {
    const before = queryResult(1)
    const after = queryResult(2)
    const group = {
      getCurrentResult: () => after,
      getObservers: () => [queryObserver('fake')],
    }

    expect(
      diffExternalStoreChanges(
        causalFiber(
          [{ memoizedState: group }, externalStoreHook(after)],
          [{ memoizedState: group }, externalStoreHook(before)],
        ),
      ),
    ).toMatchObject([{ kind: 'query', evidence: 'inferred', reason: 'query-result-shape' }])
  })

  it('does not grant exact QueryObserver evidence to an unregistered structural match', () => {
    const before = queryResult(1)
    const after = queryResult(2)
    const observer = {
      options: { queryHash: 'fake' },
      getCurrentQuery: () => ({ queryHash: 'fake', queryKey: ['fake'] }),
      getCurrentResult: () => after,
      subscribe: () => () => {},
    }

    expect(
      diffExternalStoreChanges(
        causalFiber(
          [{ memoizedState: observer }, externalStoreHook(after)],
          [{ memoizedState: observer }, externalStoreHook(before)],
        ),
      ),
    ).toMatchObject([{ kind: 'query', evidence: 'inferred', reason: 'query-result-shape' }])
  })

  it('requires a matching notification ID before calling a Query cause exact', () => {
    const before = queryResult(1)
    const after = queryResult(2)
    const observer = queryObserver('registered') as ReturnType<typeof queryObserver>
    Object.assign(observer, { getCurrentResult: () => after })
    registerQueryObserver(observer)

    const withoutDelivery = diffExternalStoreChanges(
      causalFiber(
        [{ memoizedState: observer }, externalStoreHook(after)],
        [{ memoizedState: observer }, externalStoreHook(before)],
      ),
    )
    expect(withoutDelivery).toMatchObject([
      {
        kind: 'query',
        evidence: 'inferred',
        reason: 'query-observer-result-identity',
        notificationId: null,
      },
    ])

    const notification = recordQueryNotification(observer, before, after, {
      trackedFields: ['dataUpdatedAt'],
      trackedFieldsCoverage: 'exact',
      fanout: 1,
    })
    const withDelivery = diffExternalStoreChanges(
      causalFiber(
        [{ memoizedState: observer }, externalStoreHook(after)],
        [{ memoizedState: observer }, externalStoreHook(before)],
      ),
    )
    expect(withDelivery).toMatchObject([
      {
        kind: 'query',
        evidence: 'exact',
        reason: 'query-notification-delivered',
        notificationId: notification.notificationId,
      },
    ])
  })

  it('keeps QueriesObserver identity inferred without a group delivery notification', () => {
    const before = queryResult(1)
    const after = queryResult(2)
    const child = queryObserver('registered')
    registerQueryObserver(child)
    const group = {
      getCurrentResult: () => after,
      getObservers: () => [child],
    }

    expect(
      diffExternalStoreChanges(
        causalFiber(
          [{ memoizedState: group }, externalStoreHook(after)],
          [{ memoizedState: group }, externalStoreHook(before)],
        ),
      ),
    ).toMatchObject([
      {
        kind: 'query',
        evidence: 'inferred',
        reason: 'queries-observer-result-identity',
        queries: [{ observerId: 'query-observer:1' }],
      },
    ])
  })

  it('caps a huge observer array before filtering sparse entries', () => {
    const before = queryResult(1)
    const after = queryResult(2)
    const child = queryObserver('late')
    registerQueryObserver(child)
    const children = new Array<unknown>(1_000_000)
    children[999_999] = child
    const group = {
      getCurrentResult: () => after,
      getObservers: () => children,
    }
    const evidence = createRenderEvidenceBudget()

    expect(
      diffExternalStoreChanges(
        causalFiber(
          [{ memoizedState: group }, externalStoreHook(after)],
          [{ memoizedState: group }, externalStoreHook(before)],
        ),
        evidence,
      ),
    ).toMatchObject([{ kind: 'query', evidence: 'inferred' }])
    expect(inputCoverage(evidence)).toMatchObject({ complete: false, scanTruncated: true })
  })

  it('never invokes accessor fields while diffing external-store snapshots', () => {
    let reads = 0
    const snapshot = (updatedAt: number): Record<string, unknown> => {
      const value = queryResult(updatedAt)
      Object.defineProperty(value, 'computed', {
        enumerable: true,
        get: () => {
          reads += 1
          return updatedAt
        },
      })
      return value
    }
    const before = snapshot(1)
    const after = snapshot(2)
    const evidence = createRenderEvidenceBudget()

    expect(
      diffExternalStoreChanges(
        causalFiber([externalStoreHook(after)], [externalStoreHook(before)]),
        evidence,
      ),
    ).toMatchObject([
      { kind: 'query', changedFields: ['dataUpdatedAt'], deepDiff: { truncated: true } },
    ])
    expect(reads).toBe(0)
    expect(inputCoverage(evidence)).toMatchObject({ complete: true, scanTruncated: false })
  })
})
