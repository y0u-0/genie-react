import type { Fiber, RenderPhase } from 'bippy'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  childrenChanged,
  clearRenders,
  clearSnapshots,
  createCommitAnalysisBudget,
  diffProps,
  diffStateChanges,
  getRenders,
  getSkippedCommitFiberCount,
  isTracking,
  recordCommitFiber,
  recordRender,
  rendersDiff,
  snapshotLabels,
  startRenderTracking,
  stateChanged,
  stopRenderTracking,
  takeSnapshot,
} from './render-tracker'

// Fake fibers have no _debugStack: stub source lookup to null so every fiber classifies as app (isLibrary:false) and survives appOnly.
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
  it('ignores the children key', () => {
    const fiber = asFiber({
      memoizedProps: { a: 1, children: {} },
      alternate: { memoizedProps: { a: 1, children: {} } },
    })
    expect(diffProps(fiber)).toEqual([])
  })

  it('flags a non-primitive prop whose reference changed as unstable', () => {
    const fiber = asFiber({
      memoizedProps: { data: {} },
      alternate: { memoizedProps: { data: {} } },
    })
    expect(diffProps(fiber)).toEqual([{ name: 'data', kind: 'props', unstable: true }])
  })

  it('does not flag a changed primitive as unstable', () => {
    const fiber = asFiber({
      memoizedProps: { n: 2 },
      alternate: { memoizedProps: { n: 1 } },
    })
    expect(diffProps(fiber)).toEqual([{ name: 'n', kind: 'props', unstable: false }])
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
    expect(change?.before).toMatchObject({
      nested: { value: { __genie_dehydrated__: true, preview: '{…}' } },
      self: { __genie_dehydrated__: true, preview: '[Circular]' },
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
        memoizedState: hook({ count: 2 }),
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: { memoizedProps: {}, memoizedState: hook({ count: 1 }) },
      }),
      'update',
    )

    expect((await byName()).get('Counter')?.changes).toEqual([
      {
        name: 'state[0]',
        kind: 'state',
        unstable: false,
        hook: { index: 0, stateIndex: 0, kind: 'state' },
        before: { count: 1 },
        after: { count: 2 },
      },
    ])
  })

  it('reports changed class state without pretending it is a hook', async () => {
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
        before: { count: 1 },
        after: { count: 2 },
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
          stateHook({ items: 2 }, cartReducer),
        ]),
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: {
          memoizedProps: {},
          memoizedState: chain([
            stateHook(false, basicStateReducer),
            memoHook({ derived: 1 }),
            stateHook({ items: 1 }, cartReducer),
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
        before: { items: 1 },
        after: { items: 2 },
      },
    ])
  })

  it('does not misreport a changed memo value as the cause of a render', async () => {
    const memoHook = (value: unknown) => ({ memoizedState: [value, []], next: null })
    const type = (): null => null
    Object.assign(type, { displayName: 'DerivedOnly' })

    render(
      asFiber({
        tag: 0,
        type,
        memoizedProps: {},
        memoizedState: memoHook({ derived: 2 }),
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: { memoizedProps: {}, memoizedState: memoHook({ derived: 1 }) },
      }),
      'update',
    )

    expect((await byName()).get('DerivedOnly')).toMatchObject({ changes: [], unnecessary: 1 })
  })

  it('counts an update unnecessary only when nothing changed and children held', async () => {
    const shared = { node: true }
    render(
      componentFiber({
        name: 'Pure',
        props: { a: 1, children: shared },
        prevProps: { a: 1, children: shared },
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
    expect(records.get('Changed')?.changes.map((c) => c.name)).toContain('a')

    expect(records.get('ChildOnly')?.unnecessary).toBe(0)
    expect(records.get('ChildOnly')?.changes).toEqual([])
  })

  it('ignores non-composite and unmounting fibers', async () => {
    render(asFiber({ tag: 5, type: 'div' }), 'update')
    render(componentFiber({ name: 'Gone', props: {} }), 'unmount')
    expect(await getRenders({ sort: 'renders', limit: 50 })).toEqual([])
  })
})

describe('commit analysis budget', () => {
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
})

describe('recordRender unstable-render accounting', () => {
  const byName = async () =>
    new Map((await getRenders({ sort: 'renders', limit: 50 })).map((r) => [r.name, r]))

  it('flags an update whose only changes are unstable-reference props', async () => {
    const shared = { node: true }
    render(
      componentFiber({
        name: 'UnstableOnly',
        props: { onClick: () => {}, children: shared },
        prevProps: { onClick: () => {}, children: shared },
      }),
      'update',
    )
    const record = (await byName()).get('UnstableOnly')
    expect(record?.unstableRenders).toBe(1)
    expect(record?.unnecessary).toBe(0)
  })

  it('does not flag when a stable (primitive) prop also changed', async () => {
    render(
      componentFiber({
        name: 'MixedProps',
        props: { onClick: () => {}, count: 2 },
        prevProps: { onClick: () => {}, count: 1 },
      }),
      'update',
    )
    expect((await byName()).get('MixedProps')?.unstableRenders).toBe(0)
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

  it('sorts by unstable-render count when requested', async () => {
    clearRenders()
    const stableHandler = () => {}
    const calm = componentFiber({
      name: 'Calm',
      props: { onClick: stableHandler },
      prevProps: { onClick: stableHandler },
    })
    render(calm, 'mount')
    render(calm, 'update')

    const churny = componentFiber({
      name: 'Churny',
      props: { onClick: () => {} },
      prevProps: { onClick: () => {} },
    })
    render(churny, 'mount')
    render(churny, 'update')
    render(churny, 'update')

    const ranked = await getRenders({ sort: 'unstable', limit: 10 })
    expect(ranked[0]?.name).toBe('Churny')
    expect(ranked[0]?.unstableRenders).toBe(2)
    expect(ranked.find((r) => r.name === 'Calm')?.unstableRenders).toBe(0)
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

  // A fiber with a STABLE identity (hence stable bippy id) whose selfTime can be re-measured; recordRender takes a running max, so drive it low→snapshot→high for regressions, or clearRenders between for improvements.
  const makeMeasured = (name: string) => {
    const type = (): null => null
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

  it('flags a component that got slower past the threshold as regressed', async () => {
    const slow = makeMeasured('Slowpoke')
    slow(1, 'mount')
    await takeSnapshot('base')
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
    base(15, 'update')
    const withBase = await rendersDiff('nonzero', 0.5)
    expect(withBase.selfTimeMs.before).toBe(10)
    expect(withBase.selfTimeMs.delta).toBe(5)
    expect(withBase.selfTimeMs.pct).toBe(50)
  })

  it('overwrites a snapshot re-used under the same label', async () => {
    makeMeasured('X')(5, 'mount')
    await takeSnapshot('base')
    const second = await takeSnapshot('base')
    expect(second.label).toBe('base')
    expect(snapshotLabels()).toEqual(['base'])
  })
})
