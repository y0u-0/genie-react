import type { Fiber, RenderPhase } from 'bippy'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  childrenChanged,
  clearRenders,
  diffProps,
  getRenders,
  recordRender,
  stateChanged,
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
  ;(type as { displayName?: string }).displayName = opts.name
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

describe('recordRender unnecessary accounting', () => {
  const byName = async () =>
    new Map((await getRenders({ sort: 'renders', limit: 50 })).map((r) => [r.name, r]))

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
    const type = (): null => null
    ;(type as { displayName?: string }).displayName = 'WithState'
    render(
      asFiber({
        tag: 0,
        type,
        memoizedProps: { onClick: () => {} },
        memoizedState: { memoizedState: 2, next: null },
        actualDuration: 0,
        selfBaseDuration: 0,
        child: null,
        alternate: {
          memoizedProps: { onClick: () => {} },
          memoizedState: { memoizedState: 1, next: null },
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
