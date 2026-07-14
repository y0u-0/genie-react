import { type Fiber, getFiberId, type RenderPhase } from 'bippy'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  querySubscriberFor,
  recordRouterNotification,
  registerQueryObserver,
  registerRouterStore,
} from '../causal/external-store-registry'
import { wasInstanceObserved } from './instance-identity'
import {
  childrenChanged,
  clearRenders,
  clearSnapshots,
  createCommitAnalysisBudget,
  diffContextChanges,
  diffExternalStoreChanges,
  diffProps,
  diffStateChanges,
  finalizeCommitAnalysisBudget,
  getAnalysisFailedFiberCount,
  getBudgetExhaustedCommitCount,
  getBudgetExhaustedSubsystems,
  getDroppedPendingUnmountFiberCount,
  getPropsNotEnumeratedFiberCount,
  getRenderCauseEventsReport,
  getRenderCauseMeasurement,
  getRenders,
  getRendersLeaderboardsMeasurement,
  getRendersMeasurement,
  getRenderTrackingCoverage,
  getSkippedCommitFiberCount,
  getTruncatedInputFiberCount,
  isTracking,
  queuePendingUnmount,
  recordCommitFiber,
  recordRender,
  rendersDiff,
  snapshotLabels,
  startRenderTracking,
  stateChanged,
  stopRenderTracking,
  takeSnapshot,
} from './render-tracker'

// Source-map helpers stay deterministic; individual fixtures provide _debugSource when app ownership matters.
vi.mock('bippy/source', () => ({
  getSource: async () => null,
  isSourceFile: (file: string) => !file.includes('/node_modules/'),
  normalizeFileName: (file: string) => file,
  getFiberHooks: () => [],
  symbolicateStack: async (frames: unknown[]) => frames,
}))

const asFiber = (shape: unknown): Fiber => shape as Fiber

function componentFiber(opts: {
  name: string
  props?: Record<string, unknown> | null
  prevProps?: Record<string, unknown> | null
  prevState?: unknown
  actualDuration?: number
}): Fiber {
  const type = (): null => null
  Object.assign(type, { displayName: opts.name })
  const hasAlternate = opts.prevProps !== undefined || opts.prevState !== undefined
  return asFiber({
    tag: 0,
    type,
    memoizedProps: opts.props ?? null,
    memoizedState: null,
    actualDuration: opts.actualDuration ?? 0,
    selfBaseDuration: opts.actualDuration ?? 0,
    child: null,
    alternate: hasAlternate
      ? { memoizedProps: opts.prevProps ?? null, memoizedState: opts.prevState ?? null }
      : null,
  })
}

const render = (fiber: Fiber, phase: RenderPhase) => recordRender(fiber, phase)

// bippy gives the very first fiber the falsy id 0 and reassigns it on the next lookup; burn it up front so every test fiber gets a stable, truthy id.
beforeAll(() => {
  recordRender(componentFiber({ name: '__warmup__', props: {} }), 'mount')
})

beforeEach(() => clearRenders())

describe('diffProps', () => {
  it('leaves children to the fixed-key comparison', () => {
    const fiber = asFiber({
      memoizedProps: { a: 1, children: {} },
      alternate: { memoizedProps: { a: 1, children: {} } },
    })
    expect(diffProps(fiber)).toEqual([])
  })

  it('does not guess arbitrary prop fields from an identity change', () => {
    const fiber = asFiber({
      memoizedProps: { n: 2 },
      alternate: { memoizedProps: { n: 1 } },
    })
    expect(diffProps(fiber)).toEqual([])
  })

  it('returns nothing on first render (no alternate props)', () => {
    expect(diffProps(asFiber({ memoizedProps: { a: 1 }, alternate: null }))).toEqual([])
  })
})

describe('childrenChanged', () => {
  const childA = { id: 'a' }
  const childB = { id: 'b' }

  it('detects a new children element', () => {
    const fiber = asFiber({
      memoizedProps: { children: childB },
      alternate: { memoizedProps: { children: childA } },
    })
    expect(childrenChanged(fiber)).toBe(true)
  })

  it('treats the same children reference as unchanged', () => {
    const fiber = asFiber({
      memoizedProps: { children: childA },
      alternate: { memoizedProps: { children: childA } },
    })
    expect(childrenChanged(fiber)).toBe(false)
  })

  it('is false on first render', () => {
    expect(childrenChanged(asFiber({ memoizedProps: { children: childA }, alternate: null }))).toBe(
      false,
    )
  })
})

describe('stateChanged', () => {
  type HookNode = { memoizedState: unknown; next: HookNode | null }
  const chain = (values: unknown[]): HookNode | null => {
    let head: HookNode | null = null
    for (let i = values.length - 1; i >= 0; i--) head = { memoizedState: values[i], next: head }
    return head
  }
  const stateFiber = (cur: unknown[], alt: unknown[]) =>
    asFiber({ memoizedState: chain(cur), alternate: { memoizedState: chain(alt) } })

  it('returns false for identical hook chains', () => {
    expect(stateChanged(stateFiber([1, 'two', true], [1, 'two', true]))).toBe(false)
  })

  it('walks the hook list and reports a changed hook', () => {
    expect(stateChanged(stateFiber([1, 2, 3], [1, 9, 3]))).toBe(true)
  })

  it('stops at the hook-walk guard and ignores differences beyond it', () => {
    const base = Array.from({ length: 1100 }, () => 0)
    const beyondGuard = base.slice()
    beyondGuard[1050] = 1
    expect(stateChanged(stateFiber(base, beyondGuard))).toBe(false)

    const withinGuard = base.slice()
    withinGuard[50] = 1
    expect(stateChanged(stateFiber(base, withinGuard))).toBe(true)
  })
})

describe('diffStateChanges safety bounds', () => {
  type HookNode = {
    memoizedState: unknown
    queue: { dispatch: () => void; lastRenderedReducer: () => void }
    next: HookNode | null
  }
  function basicStateReducer(): void {}
  const chain = (values: unknown[]): HookNode | null => {
    let head: HookNode | null = null
    for (let i = values.length - 1; i >= 0; i--) {
      head = {
        memoizedState: values[i],
        queue: { dispatch: () => {}, lastRenderedReducer: basicStateReducer },
        next: head,
      }
    }
    return head
  }
  const stateFiber = (cur: unknown[], alt: unknown[]) =>
    asFiber({ tag: 0, memoizedState: chain(cur), alternate: { memoizedState: chain(alt) } })

  it('stops collecting at the hook-walk limit', () => {
    const before = Array.from({ length: 1_100 }, () => 0)
    const afterLimit = before.slice()
    afterLimit[1_050] = 1
    expect(diffStateChanges(stateFiber(afterLimit, before))).toEqual([])

    const withinLimit = before.slice()
    withinLimit[50] = 1
    expect(diffStateChanges(stateFiber(withinLimit, before))).toMatchObject([
      { name: 'state[50]', hook: { index: 50, stateIndex: 50 } },
    ])
  })

  it('dehydrates circular and deep values before retaining them', () => {
    const before = { nested: { value: { count: 1 } } } as Record<string, unknown>
    before.self = before
    const after = { nested: { value: { count: 2 } } } as Record<string, unknown>
    after.self = after

    const [change] = diffStateChanges(stateFiber([after], [before]))
    expect(change?.before).not.toBe(before)
    expect(change?.after).not.toBe(after)
    expect(change?.before).toEqual({
      __genie_dehydrated__: true,
      kind: 'object',
      preview: '[object fields not inspected]',
      path: [],
    })
  })
})

describe('causal render attribution', () => {
  type HookNode = {
    memoizedState: unknown
    queue?: unknown
    next: HookNode | null
  }

  const hookChain = (hooks: Array<Omit<HookNode, 'next'>>): HookNode | null => {
    let next: HookNode | null = null
    for (let index = hooks.length - 1; index >= 0; index -= 1) {
      const hook = hooks[index]
      if (hook) next = { ...hook, next }
    }
    return next
  }

  const externalStoreHook = (snapshot: unknown): Omit<HookNode, 'next'> => ({
    memoizedState: snapshot,
    queue: { value: snapshot, getSnapshot: () => snapshot },
  })

  const causalFiber = (
    name: string,
    currentHooks: Array<Omit<HookNode, 'next'>>,
    previousHooks: Array<Omit<HookNode, 'next'>>,
    extra: Record<string, unknown> = {},
  ): Fiber => {
    const type = (): null => null
    Object.assign(type, { displayName: name })
    return asFiber({
      tag: 0,
      type,
      memoizedProps: {},
      memoizedState: hookChain(currentHooks),
      actualDuration: 0,
      selfBaseDuration: 0,
      child: null,
      ...extra,
      alternate: {
        memoizedProps: {},
        memoizedState: hookChain(previousHooks),
      },
    })
  }

  it('attributes a changed useSyncExternalStore selection without claiming exact delivery', async () => {
    const fiber = causalFiber('SelectedRow', [externalStoreHook(true)], [externalStoreHook(false)])
    expect(diffExternalStoreChanges(fiber)).toMatchObject([
      {
        kind: 'external-store',
        evidence: 'inferred',
        hookIndex: 0,
        before: false,
        after: true,
        changedFields: ['$value'],
      },
    ])

    render(fiber, 'update')
    const report = (await getRenders({ sort: 'renders', limit: 10 }))[0]
    expect(report).toMatchObject({
      unnecessary: 0,
      necessity: 'necessary',
      causes: [{ kind: 'external-store', evidence: 'inferred' }],
      causeCounts: { 'external-store': 1 },
    })
  })

  it('keeps Query shape fallback inferred without guessing a nearby hash', () => {
    const observer = (queryHash: string): Omit<HookNode, 'next'> => ({
      memoizedState: { options: { queryHash } },
    })
    const before = {
      status: 'success',
      fetchStatus: 'idle',
      dataUpdatedAt: 1,
      data: { count: 1 },
    }
    const after = { ...before, fetchStatus: 'fetching', dataUpdatedAt: 2 }
    const causes = diffExternalStoreChanges(
      causalFiber(
        'QueryConsumer',
        [observer('["todos"]'), externalStoreHook(after)],
        [observer('["todos"]'), externalStoreHook(before)],
      ),
    )
    expect(causes).toMatchObject([
      {
        kind: 'query',
        evidence: 'inferred',
        hookIndex: 1,
        changedFields: ['dataUpdatedAt', 'fetchStatus'],
      },
    ])
  })

  it('joins each useQuery snapshot to the exact public observer result', () => {
    const beforeA = { status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1, data: 'a1' }
    const afterA = { ...beforeA, dataUpdatedAt: 2, data: 'a2' }
    const beforeB = { status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1, data: 'b1' }
    const afterB = { ...beforeB, dataUpdatedAt: 2, data: 'b2' }
    const observer = (queryHash: string, queryKey: unknown[], result: unknown) => ({
      options: { queryHash, queryKey },
      getCurrentQuery: () => ({ queryHash, queryKey }),
      getCurrentResult: () => result,
      subscribe: () => () => {},
    })
    const observerA = observer('["a"]', ['a'], afterA)
    const observerB = observer('["b"]', ['b'], afterB)
    registerQueryObserver(observerA)
    registerQueryObserver(observerB)

    const causes = diffExternalStoreChanges(
      causalFiber(
        'TwoQueries',
        [
          { memoizedState: observerA },
          externalStoreHook(afterA),
          { memoizedState: observerB },
          externalStoreHook(afterB),
        ],
        [
          { memoizedState: observerA },
          externalStoreHook(beforeA),
          { memoizedState: observerB },
          externalStoreHook(beforeB),
        ],
      ),
    )

    expect(causes).toMatchObject([
      {
        kind: 'query',
        evidence: 'inferred',
        reason: 'query-observer-result-identity',
        queryHash: '["a"]',
        identityStatus: 'current',
      },
      {
        kind: 'query',
        evidence: 'inferred',
        reason: 'query-observer-result-identity',
        queryHash: '["b"]',
        identityStatus: 'current',
      },
    ])
  })

  it('keeps Query identity inferred and omits a stale hash during a key transition', () => {
    const before = { status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1 }
    const after = { ...before, dataUpdatedAt: 2 }
    const observer = {
      options: { queryHash: '["item",1]' },
      getCurrentQuery: () => ({ queryHash: '["item",2]', queryKey: ['item', 2] }),
      getCurrentResult: () => after,
      subscribe: () => () => {},
    }
    registerQueryObserver(observer)
    const [cause] = diffExternalStoreChanges(
      causalFiber(
        'ChangingQuery',
        [{ memoizedState: observer }, externalStoreHook(after)],
        [{ memoizedState: observer }, externalStoreHook(before)],
      ),
    )
    expect(cause).toMatchObject({
      kind: 'query',
      evidence: 'inferred',
      identityStatus: 'transitioning',
    })
    expect(cause).not.toHaveProperty('queryHash')
  })

  it('joins the Query subscriber to the exact retained render event and commits', async () => {
    const before = { status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1 }
    const after = { ...before, dataUpdatedAt: 2 }
    const observer = {
      options: { queryHash: '["joined"]', queryKey: ['joined'] },
      getCurrentQuery: () => ({ queryHash: '["joined"]', queryKey: ['joined'] }),
      getCurrentResult: () => after,
      subscribe: () => () => {},
    }
    registerQueryObserver(observer)
    render(
      causalFiber(
        'JoinedQuery',
        [{ memoizedState: observer }, externalStoreHook(after)],
        [{ memoizedState: observer }, externalStoreHook(before)],
      ),
      'update',
    )

    const [event] = (await getRenderCauseEventsReport({ component: 'JoinedQuery', limit: 1 }))
      .events
    expect(querySubscriberFor(observer)).toMatchObject({
      renderEventId: event?.renderEventId,
      commitId: event?.commitId,
      documentCommitId: event?.documentCommitId,
      observationId: event?.observationId,
    })
  })

  it('does not publish a Query subscriber when the render event fails to prepare', async () => {
    const before = { status: 'success', fetchStatus: 'idle', dataUpdatedAt: 1 }
    const after = { ...before, dataUpdatedAt: 2 }
    const observer = {
      options: { queryHash: '["atomic"]', queryKey: ['atomic'] },
      getCurrentQuery: () => ({ queryHash: '["atomic"]', queryKey: ['atomic'] }),
      getCurrentResult: () => after,
      subscribe: () => () => {},
    }
    registerQueryObserver(observer)
    const fiber = causalFiber(
      'AtomicQuery',
      [{ memoizedState: observer }, externalStoreHook(after)],
      [{ memoizedState: observer }, externalStoreHook(before)],
    )
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementationOnce(() => {
      throw new Error('clone failed')
    })

    expect(() => render(fiber, 'update')).toThrow('clone failed')
    clone.mockRestore()
    expect(querySubscriberFor(observer)).toBeNull()
    expect(
      (await getRenderCauseEventsReport({ component: 'AtomicQuery', limit: 1 })).events,
    ).toEqual([])
  })

  it('labels Router-shaped snapshots without guessing at scalar selectors', () => {
    const before = { location: { pathname: '/' }, matches: [{ id: '/' }] }
    const after = { location: { pathname: '/settings' }, matches: [{ id: '/settings' }] }
    expect(
      diffExternalStoreChanges(
        causalFiber('RouterConsumer', [externalStoreHook(after)], [externalStoreHook(before)]),
      ),
    ).toMatchObject([{ kind: 'router', evidence: 'inferred' }])
    expect(
      diffExternalStoreChanges(
        causalFiber(
          'RouterLocationConsumer',
          [externalStoreHook({ href: '/settings', pathname: '/settings', searchStr: '' })],
          [externalStoreHook({ href: '/', pathname: '/', searchStr: '' })],
        ),
      ),
    ).toMatchObject([{ kind: 'router', evidence: 'inferred' }])
    expect(
      diffExternalStoreChanges(
        causalFiber('ScalarStore', [externalStoreHook('b')], [externalStoreHook('a')]),
      ),
    ).toMatchObject([{ kind: 'external-store', evidence: 'inferred' }])
  })

  it('keeps a scalar selection inferred even when a registered Router store is nearby', () => {
    const store = {}
    const { routerId } = registerRouterStore(store)
    const cause = diffExternalStoreChanges(
      causalFiber(
        'PathnameConsumer',
        [{ memoizedState: { deps: [store] } }, externalStoreHook('/settings')],
        [{ memoizedState: { deps: [store] } }, externalStoreHook('/')],
      ),
    )
    expect(cause).toMatchObject([
      {
        kind: 'router',
        evidence: 'inferred',
        reason: 'registered-router-store-nearby',
        routerId,
        before: '/',
        after: '/settings',
      },
    ])
  })

  it('uses exact Router attribution only with a matching delivered notification', () => {
    const before = { location: { pathname: '/' }, matches: [] }
    const after = { location: { pathname: '/settings' }, matches: [] }
    const store = {}
    const { routerId } = registerRouterStore(store, () => after)

    expect(
      diffExternalStoreChanges(
        causalFiber(
          'RouterStateConsumer',
          [{ memoizedState: { deps: [store] } }, externalStoreHook(after)],
          [{ memoizedState: { deps: [store] } }, externalStoreHook(before)],
        ),
      ),
    ).toMatchObject([
      {
        kind: 'router',
        evidence: 'inferred',
        reason: 'registered-router-store',
        routerId,
        notificationId: null,
      },
    ])

    const notification = recordRouterNotification(store, after)
    expect(
      diffExternalStoreChanges(
        causalFiber(
          'RouterStateConsumer',
          [{ memoizedState: { deps: [store] } }, externalStoreHook(after)],
          [{ memoizedState: { deps: [store] } }, externalStoreHook(before)],
        ),
      ),
    ).toMatchObject([
      {
        kind: 'router',
        evidence: 'exact',
        reason: 'router-notification-delivered',
        routerId,
        notificationId: notification.notificationId,
      },
    ])
  })

  it('retains exact Context before/after evidence and its display name', () => {
    const context = { displayName: 'Theme' }
    const fiber = asFiber({
      dependencies: {
        firstContext: { context, memoizedValue: 'dark', next: null },
      },
      alternate: {
        dependencies: {
          firstContext: { context, memoizedValue: 'light', next: null },
        },
      },
    })
    expect(diffContextChanges(fiber)).toEqual([
      {
        kind: 'context',
        evidence: 'exact',
        contextIndex: 0,
        name: 'Theme',
        before: 'light',
        after: 'dark',
        deepDiff: {
          changes: [{ kind: 'value', path: '', before: 'light', after: 'dark' }],
          visited: 1,
          truncated: false,
        },
      },
    ])
  })

  it('does not zip different Context dependencies into a false exact cause', () => {
    const fiber = asFiber({
      dependencies: {
        firstContext: {
          context: { displayName: 'CurrentTheme' },
          memoizedValue: 'dark',
          next: null,
        },
      },
      alternate: {
        dependencies: {
          firstContext: {
            context: { displayName: 'PreviousLocale' },
            memoizedValue: 'en',
            next: null,
          },
        },
      },
    })
    expect(diffContextChanges(fiber)).toEqual([])
  })

  it('distinguishes nearest-parent propagation from an explicit unknown cause', async () => {
    const parentProps = {}
    const parent = componentFiber({ name: 'Parent', props: parentProps, prevProps: parentProps })
    Object.assign(parent, { flags: 1 })
    const childProps = {}
    const child = componentFiber({ name: 'Child', props: childProps, prevProps: childProps })
    Object.assign(child, { return: parent })
    const budget = createCommitAnalysisBudget()
    budget.currentCommitEvidence.renderedFibers.add(parent)
    recordRender(child, 'update', undefined, budget.work, budget.currentCommitEvidence)
    const unknownProps = {}
    const unknown = componentFiber({
      name: 'Unknown',
      props: unknownProps,
      prevProps: unknownProps,
    })
    render(unknown, 'update')

    const reports = new Map(
      (await getRenders({ sort: 'renders', limit: 10 })).map((report) => [report.name, report]),
    )
    expect(reports.get('Child')).toMatchObject({
      necessity: 'unknown',
      causes: [{ kind: 'parent', parentName: 'Parent', evidence: 'inferred' }],
    })
    expect(reports.get('Unknown')).toMatchObject({
      necessity: 'unnecessary',
      causes: [{ kind: 'unknown', evidence: 'unknown' }],
      assessment: {
        inputEvidence: 'none-observed',
        optimizationSafety: 'not-proven-safe',
      },
    })
  })

  it('uses current traversal membership without reading stale parent flags', async () => {
    const parentProps = {}
    const parent = new Proxy(
      componentFiber({ name: 'BrokenParent', props: parentProps, prevProps: parentProps }),
      {
        get(target, key, receiver) {
          if (key === 'flags') throw new Error('unreadable parent flags')
          return Reflect.get(target, key, receiver)
        },
      },
    )
    const childProps = {}
    const child = componentFiber({
      name: 'GuardedChild',
      props: childProps,
      prevProps: childProps,
    })
    Object.assign(child, { return: parent })
    const budget = createCommitAnalysisBudget()
    budget.currentCommitEvidence.renderedFibers.add(parent)

    recordRender(child, 'update', undefined, budget.work, budget.currentCommitEvidence)

    expect((await getRenders({ sort: 'renders', limit: 10 }))[0]).toMatchObject({
      necessity: 'unknown',
      causes: [{ kind: 'parent', reason: 'nearest-rendered-ancestor' }],
    })
    expect(getAnalysisFailedFiberCount()).toBe(0)
  })

  it('does not reuse a parent render from an earlier commit', async () => {
    const parentProps = {}
    const childProps = {}
    const parent = componentFiber({
      name: 'EarlierParent',
      props: parentProps,
      prevProps: parentProps,
    })
    const child = componentFiber({ name: 'LaterChild', props: childProps, prevProps: childProps })
    Object.assign(child, { return: parent })

    const firstCommit = createCommitAnalysisBudget()
    firstCommit.currentCommitEvidence.renderedFibers.add(parent)
    recordRender(child, 'update', undefined, firstCommit.work, firstCommit.currentCommitEvidence)
    expect((await getRenders({ sort: 'renders', limit: 10 }))[0]?.causes[0]).toMatchObject({
      kind: 'parent',
      parentName: 'EarlierParent',
    })

    const secondCommit = createCommitAnalysisBudget()
    recordRender(child, 'update', undefined, secondCommit.work, secondCommit.currentCommitEvidence)
    expect((await getRenders({ sort: 'renders', limit: 10 }))[0]?.causes[0]).toMatchObject({
      kind: 'unknown',
      reason: 'no-observable-fiber-input-change',
    })
  })

  it('returns bounded recent cause events newest first and filters by component', async () => {
    render(causalFiber('FirstRow', [externalStoreHook(2)], [externalStoreHook(1)]), 'update')
    render(causalFiber('SecondRow', [externalStoreHook(3)], [externalStoreHook(2)]), 'update')
    const result = await getRenderCauseEventsReport({ component: 'second', limit: 1 })
    expect(result.libraryHidden).toBe(0)
    expect(result.omittedByLimit).toBe(0)
    expect(result.events).toMatchObject([
      {
        componentName: 'SecondRow',
        causes: [{ kind: 'external-store' }],
      },
    ])

    const bounded = await getRenderCauseEventsReport({ limit: 1 })
    expect(bounded.events).toHaveLength(1)
    expect(bounded.omittedByLimit).toBe(1)
  })

  it('keeps cause rows and metadata on the same call-start state', async () => {
    render(causalFiber('BeforeRead', [externalStoreHook(2)], [externalStoreHook(1)]), 'update')
    const pending = getRenderCauseMeasurement({ limit: 10 })
    render(causalFiber('AfterRead', [externalStoreHook(3)], [externalStoreHook(2)]), 'update')

    const report = await pending
    expect(report.events).toHaveLength(1)
    expect(report.events[0]?.componentName).toBe('BeforeRead')
  })

  it('makes retained-history eviction explicit even when a filtered read is empty', async () => {
    const fiber = causalFiber('RetainedRow', [externalStoreHook(2)], [externalStoreHook(1)])
    for (let index = 0; index < 1_001; index += 1) render(fiber, 'update')

    const report = await getRenderCauseMeasurement({
      component: 'MissingRow',
      limit: 1,
      appOnly: false,
    })
    expect(report.events).toEqual([])
    expect(report.renderEventRetention).toEqual({
      evictedEvents: 1,
      earliestDocumentCommitId: 0,
      latestDocumentCommitId: 0,
    })
  })
})

describe('component naming through memo/forwardRef wrappers', () => {
  const record = async (fiber: Fiber) => {
    render(fiber, 'mount')
    return (await getRenders({ sort: 'renders', limit: 50 })).map((report) => report.name)
  }

  it('prefers the memo wrapper displayName over a react-refresh `_c` inner name', async () => {
    const inner = (): null => null
    Object.defineProperty(inner, 'name', { value: '_c' })
    const memoWrapper = { type: inner, displayName: 'LockButton' }
    const names = await record(
      asFiber({
        tag: 0,
        type: inner,
        elementType: memoWrapper,
        memoizedProps: {},
        memoizedState: null,
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: null,
      }),
    )
    expect(names).toContain('LockButton')
    expect(names).not.toContain('_c')
  })

  it('falls through to the unwrapped inner function name when the wrapper has no displayName', async () => {
    const inner = function ZoomActions(): null {
      return null
    }
    const anonymousOuter = (): null => null
    Object.defineProperty(anonymousOuter, 'name', { value: '_c2' })
    const names = await record(
      asFiber({
        tag: 0,
        type: anonymousOuter,
        elementType: { type: inner },
        memoizedProps: {},
        memoizedState: null,
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: null,
      }),
    )
    expect(names).toContain('ZoomActions')
  })

  it('keeps `_c` as a last resort when nothing better exists', async () => {
    const inner = (): null => null
    Object.defineProperty(inner, 'name', { value: '_c3' })
    const names = await record(
      asFiber({
        tag: 0,
        type: inner,
        elementType: inner,
        memoizedProps: {},
        memoizedState: null,
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: null,
      }),
    )
    expect(names).toContain('_c3')
  })

  it('reports recursive wrapper ancestry instead of collapsing nested wrappers', async () => {
    const inner = function SaveButton(): null {
      return null
    }
    const forwardRef = { $$typeof: Symbol.for('react.forward_ref'), render: inner }
    const memo = {
      $$typeof: Symbol.for('react.memo'),
      type: forwardRef,
      displayName: 'MemoSaveButton',
    }
    render(
      asFiber({
        tag: 0,
        type: inner,
        elementType: memo,
        memoizedProps: {},
        memoizedState: null,
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: null,
      }),
      'mount',
    )

    const report = (await getRenders({ sort: 'renders', limit: 50 })).find(
      (entry) => entry.name === 'MemoSaveButton',
    )
    expect(report?.wrapperAncestry).toEqual([
      { kind: 'memo', name: 'MemoSaveButton' },
      { kind: 'forward-ref', name: 'SaveButton' },
    ])
  })
})

describe('recordRender unnecessary accounting', () => {
  const byName = async () =>
    new Map((await getRenders({ sort: 'renders', limit: 50 })).map((r) => [r.name, r]))

  it('reports the exact state hook slot and bounded before/after values that changed', async () => {
    function basicStateReducer(): void {}
    const hook = (value: unknown) => ({
      memoizedState: value,
      queue: { dispatch: () => {}, lastRenderedReducer: basicStateReducer },
      next: null,
    })
    const type = (): null => null
    Object.assign(type, { displayName: 'Counter' })

    render(
      asFiber({
        tag: 0,
        type,
        memoizedProps: {},
        memoizedState: hook([2]),
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: { memoizedProps: {}, memoizedState: hook([1]) },
      }),
      'update',
    )

    expect((await byName()).get('Counter')?.changes).toEqual([
      {
        name: 'state[0]',
        kind: 'state',
        unstable: false,
        hook: { index: 0, stateIndex: 0, kind: 'state' },
        before: [1],
        after: [2],
        deepDiff: {
          changes: [{ kind: 'value', path: '/0', before: 1, after: 2 }],
          visited: 2,
          truncated: false,
        },
      },
    ])
  })

  it('reports changed class state without claiming unsafe deep paths', async () => {
    const type = function Counter(): null {
      return null
    }
    render(
      asFiber({
        tag: 1,
        type,
        memoizedProps: {},
        memoizedState: { count: 2 },
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: { memoizedProps: {}, memoizedState: { count: 1 } },
      }),
      'update',
    )

    expect((await byName()).get('Counter')?.changes).toEqual([
      {
        name: 'class state',
        kind: 'state',
        unstable: false,
        before: {
          __genie_dehydrated__: true,
          kind: 'object',
          preview: '[object fields not inspected]',
          path: [],
        },
        after: {
          __genie_dehydrated__: true,
          kind: 'object',
          preview: '[object fields not inspected]',
          path: [],
        },
        deepDiff: {
          changes: [{ kind: 'reference-only', path: '' }],
          visited: 1,
          truncated: true,
        },
      },
    ])
  })

  it('numbers reducer slots independently from non-state hooks and ignores derived memo changes', async () => {
    function basicStateReducer(): void {}
    function cartReducer(): void {}
    const stateHook = (value: unknown, reducer: () => void) => ({
      memoizedState: value,
      queue: { dispatch: () => {}, lastRenderedReducer: reducer },
      next: null as unknown,
    })
    const memoHook = (value: unknown) => ({
      memoizedState: [value, []],
      next: null as unknown,
    })
    const chain = (nodes: Array<{ next: unknown }>) => {
      nodes.forEach((node, index) => {
        node.next = nodes[index + 1] ?? null
      })
      return nodes[0]
    }
    const type = (): null => null
    Object.assign(type, { displayName: 'Cart' })

    render(
      asFiber({
        tag: 0,
        type,
        memoizedProps: {},
        memoizedState: chain([
          stateHook(false, basicStateReducer),
          memoHook({ derived: 2 }),
          stateHook([2], cartReducer),
        ]),
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: {
          memoizedProps: {},
          memoizedState: chain([
            stateHook(false, basicStateReducer),
            memoHook({ derived: 1 }),
            stateHook([1], cartReducer),
          ]),
        },
      }),
      'update',
    )

    expect((await byName()).get('Cart')?.changes).toEqual([
      {
        name: 'reducer[1]',
        kind: 'state',
        unstable: false,
        hook: { index: 2, stateIndex: 1, kind: 'reducer' },
        before: [1],
        after: [2],
        deepDiff: {
          changes: [{ kind: 'value', path: '/0', before: 1, after: 2 }],
          visited: 2,
          truncated: false,
        },
      },
    ])
  })

  it('does not misreport a changed memo value as the cause of a render', async () => {
    const memoHook = (value: unknown) => ({ memoizedState: [value, []], next: null })
    const type = (): null => null
    const props = {}
    Object.assign(type, { displayName: 'DerivedOnly' })

    render(
      asFiber({
        tag: 0,
        type,
        memoizedProps: props,
        memoizedState: memoHook({ derived: 2 }),
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: { memoizedProps: props, memoizedState: memoHook({ derived: 1 }) },
      }),
      'update',
    )

    expect((await byName()).get('DerivedOnly')).toMatchObject({ changes: [], unnecessary: 1 })
  })

  it('claims no observed input change only when the props container is stable', async () => {
    const shared = { node: true }
    const pureProps = { a: 1, children: shared }
    render(
      componentFiber({
        name: 'Pure',
        props: pureProps,
        prevProps: pureProps,
      }),
      'update',
    )
    render(
      componentFiber({
        name: 'Changed',
        props: { a: 2, children: shared },
        prevProps: { a: 1, children: shared },
      }),
      'update',
    )
    render(
      componentFiber({
        name: 'ChildOnly',
        props: { children: { id: 'next' } },
        prevProps: { children: { id: 'prev' } },
      }),
      'update',
    )

    const records = await byName()
    expect(records.get('Pure')?.unnecessary).toBe(1)
    expect(records.get('Pure')?.changes).toEqual([])

    expect(records.get('Changed')?.unnecessary).toBe(0)
    expect(records.get('Changed')).toMatchObject({
      changes: [],
      inputCoverage: {
        complete: false,
        scanTruncated: false,
        propsNotEnumerated: true,
      },
      assessment: { inputEvidence: 'incomplete' },
    })

    expect(records.get('ChildOnly')?.unnecessary).toBe(0)
    expect(records.get('ChildOnly')?.changes).toEqual([])
  })

  it('ignores non-composite and unmounting fibers', async () => {
    render(asFiber({ tag: 5, type: 'div' }), 'update')
    render(componentFiber({ name: 'Gone', props: {} }), 'unmount')
    expect(await getRenders({ sort: 'renders', limit: 50 })).toEqual([])
  })

  it('does not delete a mounted record for a traversal-only unmount phase', async () => {
    const fiber = componentFiber({ name: 'SuspendedRow', props: {} })
    render(fiber, 'mount')
    render(fiber, 'unmount')

    expect(await getRenders({ sort: 'renders', limit: 10 })).toMatchObject([
      { name: 'SuspendedRow', mounts: 1, renders: 1 },
    ])
  })
})

describe('commit analysis budget', () => {
  it('keeps named targets in a reserved lane after the general fiber budget is exhausted', async () => {
    clearRenders({ components: ['CriticalRow'] })
    const budget = createCommitAnalysisBudget(
      0,
      { operationLimit: 1, timeLimitMs: 100, now: () => 0 },
      { operationLimit: 1_000, timeLimitMs: 100, now: () => 0 },
    )

    recordCommitFiber(componentFiber({ name: 'BackgroundRow', props: {} }), 'mount', budget)
    recordCommitFiber(componentFiber({ name: 'CriticalRow', props: {} }), 'mount', budget)

    expect(budget.processed).toBe(0)
    expect(budget.targetProcessed).toBe(1)
    expect((await getRenders({ sort: 'renders', limit: 10 })).map(({ name }) => name)).toEqual([
      'CriticalRow',
    ])
    expect(getRenderTrackingCoverage('measurement').targeted).toMatchObject({
      components: ['criticalrow'],
      processedFibers: 1,
      skippedFibers: 0,
      complete: true,
    })
  })

  it('bounds expensive per-fiber commit analysis and records skipped candidates', async () => {
    const budget = createCommitAnalysisBudget(2)
    for (let i = 0; i < 5; i++) {
      recordCommitFiber(componentFiber({ name: `Busy${i}`, props: {} }), 'mount', budget)
    }

    expect(budget.processed).toBe(2)
    expect(budget.skipped).toBe(3)
    expect(getSkippedCommitFiberCount()).toBe(3)
    expect(await getRenders({ sort: 'renders', limit: 10 })).toHaveLength(2)
  })

  it('does not spend commit budget on host fibers', () => {
    const budget = createCommitAnalysisBudget(1)
    recordCommitFiber(asFiber({ tag: 5, type: 'View', flags: 0 }), 'update', budget)
    recordCommitFiber(componentFiber({ name: 'Kept', props: {} }), 'mount', budget)

    expect(budget.processed).toBe(1)
    expect(budget.skipped).toBe(0)
  })

  it('contains a per-fiber analyzer failure without publishing a partial update', async () => {
    const throwingHook = new Proxy(
      { memoizedState: 1, queue: { dispatch: () => {} }, next: null },
      {
        get(target, key, receiver) {
          if (key === 'next') throw new Error('broken hook chain')
          return Reflect.get(target, key, receiver)
        },
      },
    )
    const fiber = componentFiber({ name: 'BrokenAnalysis', props: {} })
    recordRender(fiber, 'mount')
    Object.assign(fiber, {
      memoizedState: throwingHook,
      alternate: { memoizedProps: {}, memoizedState: throwingHook },
    })
    const budget = createCommitAnalysisBudget()

    expect(recordCommitFiber(fiber, 'update', budget)).toBe(false)
    expect(budget.failed).toBe(1)
    expect(getAnalysisFailedFiberCount()).toBe(1)
    expect((await getRenders({ sort: 'renders', limit: 10 }))[0]).toMatchObject({
      name: 'BrokenAnalysis',
      renders: 1,
      mounts: 1,
      updates: 0,
    })
  })

  it('does not publish instance identity when render preparation fails', () => {
    const fiber = new Proxy(componentFiber({ name: 'BrokenBeforePublish', props: {} }), {
      get(target, key, receiver) {
        if (key === 'updateQueue') throw new Error('memo cache unavailable')
        return Reflect.get(target, key, receiver)
      },
    })
    const fiberId = getFiberId(fiber)

    expect(() => recordRender(fiber, 'mount')).toThrow('memo cache unavailable')
    expect(wasInstanceObserved(fiberId)).toBe(false)
  })

  it('shares one operation guard across analyzers and discloses exhausted subsystems', async () => {
    const budget = createCommitAnalysisBudget(250, {
      operationLimit: 2,
      timeLimitMs: 100,
      now: () => 0,
    })
    recordCommitFiber(
      componentFiber({ name: 'GloballyBounded', props: { value: 2 }, prevProps: { value: 1 } }),
      'update',
      budget,
    )
    finalizeCommitAnalysisBudget(budget)

    expect(getBudgetExhaustedCommitCount()).toBe(1)
    expect(getBudgetExhaustedSubsystems().map(({ subsystem }) => subsystem)).toContain(
      'instance-ancestry',
    )
    expect((await getRenders({ sort: 'renders', limit: 10 }))[0]?.inputCoverage.complete).toBe(
      false,
    )
  })
})

describe('pending component unmount coverage', () => {
  it('evicts background lifecycle entries before the named target reservation', () => {
    clearRenders({
      components: ['CriticalRow'],
      lifecycle: { bufferLimit: 2, targetReserve: 1 },
    })
    queuePendingUnmount(1, componentFiber({ name: 'CriticalRow', props: {} }))
    queuePendingUnmount(1, componentFiber({ name: 'BackgroundA', props: {} }))
    queuePendingUnmount(1, componentFiber({ name: 'BackgroundB', props: {} }))

    expect(getDroppedPendingUnmountFiberCount()).toBe(1)
    expect(getRenderTrackingCoverage('measurement').targeted?.complete).toBe(true)

    queuePendingUnmount(1, componentFiber({ name: 'CriticalRow', props: {} }))
    queuePendingUnmount(1, componentFiber({ name: 'CriticalRow', props: {} }))
    expect(getRenderTrackingCoverage('measurement').targeted?.complete).toBe(false)
  })

  it('does not silently protect targeted lifecycle entries when the reservation is zero', () => {
    clearRenders({
      components: ['CriticalRow'],
      lifecycle: { bufferLimit: 1, targetReserve: 0 },
    })
    queuePendingUnmount(1, componentFiber({ name: 'CriticalRow', props: {} }))
    queuePendingUnmount(1, componentFiber({ name: 'Background', props: {} }))

    expect(getDroppedPendingUnmountFiberCount()).toBe(1)
    expect(getRenderTrackingCoverage('measurement').targeted?.complete).toBe(false)
  })

  it('ignores host unmounts and reports bounded component overflow', () => {
    const host = asFiber({ tag: 5, type: 'div' })
    for (let index = 0; index < 1_100; index += 1) queuePendingUnmount(1, host)
    expect(getDroppedPendingUnmountFiberCount()).toBe(0)

    const row = componentFiber({ name: 'UnmountedRow', props: {} })
    for (let index = 0; index < 1_001; index += 1) queuePendingUnmount(1, row)
    expect(getDroppedPendingUnmountFiberCount()).toBe(1)
  })
})

describe('recordRender reference-only prop accounting', () => {
  const byName = async () =>
    new Map((await getRenders({ sort: 'renders', limit: 50 })).map((r) => [r.name, r]))

  it('does not claim an allocation from opaque prop containers', async () => {
    const shared = { node: true }
    render(
      componentFiber({
        name: 'UnstableOnly',
        props: { items: [1, 2], children: shared },
        prevProps: { items: [1, 2], children: shared },
      }),
      'update',
    )
    const record = (await byName()).get('UnstableOnly')
    expect(record?.referenceOnlyPropRenders).toBe(0)
    expect(record?.unstableRenders).toBe(0)
    expect(record?.unnecessary).toBe(0)
    expect(record?.changes).toEqual([])
    expect(record?.inputCoverage).toEqual({
      complete: false,
      omittedInputs: 0,
      scanTruncated: false,
      propsNotEnumerated: true,
    })
  })

  it('does not flag when state also changed', async () => {
    function basicStateReducer(): void {}
    const stateHook = (value: unknown) => ({
      memoizedState: value,
      queue: { dispatch: () => {}, lastRenderedReducer: basicStateReducer },
      next: null,
    })
    const type = (): null => null
    Object.assign(type, { displayName: 'WithState' })
    render(
      asFiber({
        tag: 0,
        type,
        memoizedProps: { onClick: () => {} },
        memoizedState: stateHook(2),
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: {
          memoizedProps: { onClick: () => {} },
          memoizedState: stateHook(1),
        },
      }),
      'update',
    )
    expect((await byName()).get('WithState')?.unstableRenders).toBe(0)
  })

  it('does not flag when children changed alongside the unstable prop', async () => {
    render(
      componentFiber({
        name: 'WithChildren',
        props: { onClick: () => {}, children: { id: 'next' } },
        prevProps: { onClick: () => {}, children: { id: 'prev' } },
      }),
      'update',
    )
    expect((await byName()).get('WithChildren')?.unstableRenders).toBe(0)
  })
})

describe('bounded render input evidence', () => {
  it('marks arbitrary prop-field discovery incomplete without retaining guesses', async () => {
    const before = Object.fromEntries(Array.from({ length: 55 }, (_, index) => [`p${index}`, 0]))
    const after = Object.fromEntries(Array.from({ length: 55 }, (_, index) => [`p${index}`, 1]))
    render(componentFiber({ name: 'ManyInputs', props: after, prevProps: before }), 'update')

    const report = (await getRenders({ sort: 'renders', limit: 10 }))[0]
    expect(report?.causes).toMatchObject([
      { kind: 'unknown', reason: 'causal-analysis-incomplete' },
    ])
    expect(report?.inputCoverage).toEqual({
      complete: false,
      omittedInputs: 0,
      scanTruncated: false,
      propsNotEnumerated: true,
    })
    expect(report?.assessment.inputEvidence).toBe('incomplete')
    expect(report?.unnecessary).toBe(0)
    expect(getTruncatedInputFiberCount()).toBe(0)
    expect(getPropsNotEnumeratedFiberCount()).toBe(1)
  })
})

describe('getRenders', () => {
  beforeEach(() => {
    const alpha = componentFiber({
      name: 'Alpha',
      props: { a: 1 },
      prevProps: { a: 1 },
      actualDuration: 1,
    })
    render(alpha, 'mount')
    render(alpha, 'update')
    render(alpha, 'update')

    render(componentFiber({ name: 'Beta', props: {}, actualDuration: 50 }), 'mount')

    const gamma = componentFiber({
      name: 'Gamma',
      props: { x: 1 },
      prevProps: { x: 1 },
      actualDuration: 5,
    })
    render(gamma, 'mount')
    render(gamma, 'update')
  })

  it('sorts by render count by default', async () => {
    expect((await getRenders({ sort: 'renders', limit: 10 })).map((r) => r.name)).toEqual([
      'Alpha',
      'Gamma',
      'Beta',
    ])
  })

  it('limits the result set', async () => {
    expect((await getRenders({ sort: 'renders', limit: 1 })).map((r) => r.name)).toEqual(['Alpha'])
  })

  it('filters by a case-insensitive component substring', async () => {
    expect(
      (await getRenders({ sort: 'renders', component: 'ETA', limit: 10 })).map((r) => r.name),
    ).toEqual(['Beta'])
  })

  it('sorts by self time when requested', async () => {
    expect((await getRenders({ sort: 'selfTime', limit: 10 }))[0]?.name).toBe('Beta')
  })

  it('does not manufacture unstable candidates for the legacy sort', async () => {
    clearRenders()
    const stableItems = [1]
    const calm = componentFiber({
      name: 'Calm',
      props: { items: stableItems },
      prevProps: { items: stableItems },
    })
    render(calm, 'mount')
    render(calm, 'update')

    const churny = componentFiber({
      name: 'Churny',
      props: { items: [1] },
      prevProps: { items: [1] },
    })
    render(churny, 'mount')
    render(churny, 'update')
    render(churny, 'update')

    const ranked = await getRenders({ sort: 'unstable', limit: 10 })
    expect(ranked.map((record) => record.name)).toEqual(['Calm', 'Churny'])
    expect(ranked.every((record) => record.unstableRenders === 0)).toBe(true)
  })
})

describe('render measurement snapshot', () => {
  it('keeps summary and component rows on the same call-start state', async () => {
    const fiber = componentFiber({
      name: 'ConcurrentRow',
      props: { value: 1 },
      prevProps: { value: 0 },
    })
    render(fiber, 'update')

    const pending = getRendersMeasurement({ sort: 'renders', limit: 10, appOnly: false })
    Object.assign(fiber, {
      memoizedProps: { value: 2 },
      alternate: { memoizedProps: { value: 1 }, memoizedState: null },
    })
    render(fiber, 'update')

    const report = await pending
    expect(report.summary.totalRenders).toBe(1)
    expect(report.components).toHaveLength(1)
    expect(report.components[0]).toMatchObject({ name: 'ConcurrentRow', renders: 1 })
  })
})

describe('start / stop tracking', () => {
  afterAll(() => startRenderTracking())

  it('stop makes isTracking() false; start resumes it', () => {
    startRenderTracking()
    expect(isTracking()).toBe(true)
    stopRenderTracking()
    expect(isTracking()).toBe(false)
    startRenderTracking()
    expect(isTracking()).toBe(true)
  })
})

describe('snapshot + rendersDiff', () => {
  beforeEach(() => {
    clearRenders()
    clearSnapshots()
  })

  // A Fiber with stable physical identity whose peak and cumulative timing can be re-measured.
  const makeMeasured = (
    name: string,
    source: { fileName: string; lineNumber: number; columnNumber: number } = {
      fileName: '/src/profile-test.tsx',
      lineNumber: 1,
      columnNumber: 1,
    },
    sharedType?: () => null,
  ) => {
    const type = sharedType ?? ((): null => null)
    Object.assign(type, { displayName: name })
    const fiber = asFiber({
      tag: 0,
      type,
      memoizedProps: {},
      memoizedState: null,
      actualDuration: 0,
      selfBaseDuration: 0,
      child: null,
      alternate: null,
      _debugSource: source,
    })
    return (selfTime: number, phase: RenderPhase) => {
      Object.assign(fiber, { actualDuration: selfTime, selfBaseDuration: selfTime })
      render(fiber, phase)
    }
  }

  it('errors on an unknown baseline label, listing stored labels', async () => {
    await takeSnapshot('before')
    await expect(rendersDiff('nope', 0.5)).rejects.toThrow(/Stored labels: before/)
  })

  it('keeps incomplete analysis visible in profile reports and both sides of a diff', async () => {
    const budget = createCommitAnalysisBudget(0)
    recordCommitFiber(componentFiber({ name: 'Skipped', props: {} }), 'mount', budget)

    const report = await getRendersLeaderboardsMeasurement(10)
    expect(report.coverage).toMatchObject({ complete: false, skippedCommitFibers: 1 })

    const baseline = await takeSnapshot('partial')
    expect(baseline.coverage).toMatchObject({ complete: false, skippedCommitFibers: 1 })

    clearRenders()
    render(componentFiber({ name: 'Current', props: {} }), 'mount')
    const diff = await rendersDiff('partial', 0.5)
    expect(diff.coverage.baseline).toMatchObject({ complete: false, skippedCommitFibers: 1 })
    expect(diff.coverage.current).toMatchObject({ complete: true, skippedCommitFibers: 0 })
  })

  it('keeps exact timing coverage complete when only prop attribution is opaque', async () => {
    render(componentFiber({ name: 'Row', props: { value: 2 }, prevProps: { value: 1 } }), 'update')

    const snapshot = await takeSnapshot('opaque-props')
    expect(snapshot.coverage).toMatchObject({
      complete: true,
      inputAttributionComplete: false,
      truncatedInputFibers: 0,
      propsNotEnumeratedFibers: 1,
    })

    const diff = await rendersDiff('opaque-props', 0.5)
    expect(diff.coverage.current).toMatchObject({
      complete: true,
      inputAttributionComplete: false,
      propsNotEnumeratedFibers: 1,
    })
  })

  it('flags a component that got slower past the threshold as regressed', async () => {
    const slow = makeMeasured('Slowpoke')
    slow(1, 'mount')
    await takeSnapshot('base')
    clearRenders()
    slow(11, 'update')

    const diff = await rendersDiff('base', 0.5)
    const hit = diff.regressed.find((r) => r.name === 'Slowpoke')
    expect(hit?.deltaMs).toBe(10)
    expect(hit?.before.selfTime).toBe(1)
    expect(hit?.after.selfTime).toBe(11)
    expect(diff.improved).toEqual([])
  })

  it('flags a component that got faster as improved and respects the threshold', async () => {
    const opt = makeMeasured('Optimized')
    opt(10, 'mount')
    await takeSnapshot('base')
    // A real before/after: clear, then the same component re-renders cheaper.
    clearRenders()
    opt(2, 'mount')

    const diff = await rendersDiff('base', 0.5)
    expect(diff.improved.map((r) => r.name)).toContain('Optimized')
    expect(diff.improved.find((r) => r.name === 'Optimized')?.deltaMs).toBe(-8)
    expect(diff.regressed).toEqual([])
  })

  it('discloses counter clears since the baseline so a session-vs-session compare is identifiable', async () => {
    const comp = makeMeasured('Steady')
    comp(1, 'mount')
    await takeSnapshot('base')
    expect((await rendersDiff('base', 0.5)).clearsSinceBaseline).toBe(0)
    clearRenders()
    clearRenders()
    expect((await rendersDiff('base', 0.5)).clearsSinceBaseline).toBe(2)
  })

  it('ignores a change smaller than the threshold', async () => {
    const calm = makeMeasured('Calm')
    calm(10, 'mount')
    await takeSnapshot('base')
    clearRenders()
    calm(10.2, 'mount')
    const diff = await rendersDiff('base', 0.5)
    expect(diff.regressed).toEqual([])
    expect(diff.improved).toEqual([])
  })

  it('reports added and removed components and sorts by |delta| desc', async () => {
    const gone = makeMeasured('Gone')
    const shrinks = makeMeasured('Shrinks')
    const nudged = makeMeasured('Nudged')
    gone(5, 'mount')
    shrinks(9, 'mount')
    nudged(5, 'mount')
    await takeSnapshot('base')
    clearRenders()
    shrinks(1, 'mount')
    nudged(3, 'mount')
    // Shrinks −8, Nudged −2; Fresh is new; Gone never re-rendered so it is removed.
    makeMeasured('Fresh')(4, 'mount')

    const diff = await rendersDiff('base', 0.5)
    expect(diff.added.map((r) => r.name)).toEqual(['Fresh'])
    expect(diff.removed.map((r) => r.name)).toEqual(['Gone'])
    expect(diff.improved.map((r) => r.name)).toEqual(['Shrinks', 'Nudged'])
  })

  it('computes total self-time pct, and returns null pct when the baseline was 0', async () => {
    await takeSnapshot('empty') // nothing recorded → beforeSelf 0
    makeMeasured('New')(3, 'mount')
    const zeroBase = await rendersDiff('empty', 0.5)
    expect(zeroBase.selfTimeMs.before).toBe(0)
    expect(zeroBase.selfTimeMs.pct).toBeNull()

    clearRenders()
    clearSnapshots()
    const base = makeMeasured('Base')
    base(10, 'mount')
    await takeSnapshot('nonzero')
    clearRenders()
    base(15, 'update')
    const withBase = await rendersDiff('nonzero', 0.5)
    expect(withBase.selfTimeMs.before).toBe(10)
    expect(withBase.selfTimeMs.delta).toBe(5)
    expect(withBase.selfTimeMs.pct).toBe(50)
  })

  it('compares cumulative work when render count changes but peak time does not', async () => {
    const row = makeMeasured('RepeatedWork')
    for (let index = 0; index < 100; index += 1) row(2, index === 0 ? 'mount' : 'update')
    await takeSnapshot('base')

    clearRenders()
    row(2, 'mount')
    const diff = await rendersDiff('base', 0.5)
    const improvement = diff.improved.find((entry) => entry.name === 'RepeatedWork')
    expect(improvement).toMatchObject({
      deltaMs: -198,
      before: { renders: 100, selfTime: 200 },
      after: { renders: 1, selfTime: 2 },
    })
  })

  it('aggregates repeated instances by full component definition', async () => {
    const source = { fileName: '/src/rows.tsx', lineNumber: 10, columnNumber: 2 }
    const rowType = (): null => null
    for (let index = 0; index < 100; index += 1) {
      makeMeasured('Row', source, rowType)(1, 'mount')
    }

    const snapshot = await takeSnapshot('rows')
    const diff = await rendersDiff('rows', 0.5)
    expect(snapshot.components).toBe(1)
    expect(diff.selfTimeMs).toMatchObject({ before: 100, after: 100, delta: 0 })
  })

  it('keeps distinct component definitions at the same source separate', async () => {
    makeMeasured('Row')(1, 'mount')
    makeMeasured('Row')(2, 'mount')

    const snapshot = await takeSnapshot('source-less-rows')
    expect(snapshot.components).toBe(2)
  })

  it('keeps same basename and line from different directories distinct', async () => {
    makeMeasured('Panel', {
      fileName: '/src/admin/index.tsx',
      lineNumber: 10,
      columnNumber: 1,
    })(1, 'mount')
    makeMeasured('Panel', {
      fileName: '/src/customer/index.tsx',
      lineNumber: 10,
      columnNumber: 1,
    })(1, 'mount')

    expect((await takeSnapshot('collisions')).components).toBe(2)
  })

  it('overwrites a snapshot re-used under the same label', async () => {
    makeMeasured('X')(5, 'mount')
    await takeSnapshot('base')
    const second = await takeSnapshot('base')
    expect(second.label).toBe('base')
    expect(snapshotLabels()).toEqual(['base'])
  })
})
