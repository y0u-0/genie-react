import type { Effect, Fiber, RenderPhase } from 'bippy'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearEffects, getEffectAuditReport, recordEffect } from './effect-tracker'
import { clearSourceCache } from './source'

const getEffectAudit = async (query: Parameters<typeof getEffectAuditReport>[0]) =>
  (await getEffectAuditReport(query)).components

// Fake fibers have no _debugStack: stub source lookup to null so everything classifies as app and survives appOnly; per-test getFiberHooks trees drive per-effect attribution.
const inspector = vi.hoisted(() => ({
  getSource: vi.fn<(fiber: unknown) => Promise<unknown>>(async () => null),
  getFiberHooks: vi.fn<(fiber: unknown) => unknown[]>(() => []),
  symbolicateStack: vi.fn<(frames: unknown[]) => Promise<unknown[]>>(async (frames) => frames),
}))
vi.mock('bippy/source', () => ({
  getSource: inspector.getSource,
  isSourceFile: (file: string) => !file.includes('/node_modules/'),
  normalizeFileName: (file: string) => file,
  getFiberHooks: inspector.getFiberHooks,
  symbolicateStack: inspector.symbolicateStack,
}))

/** A leaf hook node as bippy's inspector reports it, before symbolication. */
const hookNode = (
  name: string,
  fileName: string | null,
  line: number | null,
  subHooks: unknown[] = [],
) => ({
  name,
  subHooks,
  hookSource: fileName ? { fileName, lineNumber: line, columnNumber: 0, functionName: null } : null,
})

// React's hook effect tag bits.
const HAS_EFFECT = 0b0001
const LAYOUT = 0b0100
const PASSIVE = 0b1000

const asFiber = (shape: unknown): Fiber => shape as Fiber

interface EffectSpec {
  tag: number
  deps: unknown[] | null
  /** React 18.3+/19 store the cleanup at effect.inst.destroy. */
  cleanup?: boolean
  /** Legacy (<18.3) cleanup location: effect.destroy directly. */
  legacyDestroy?: boolean
}

/** Build a circular effect linked-list and return its `lastEffect` (whose `.next` is the first). */
function effectList(specs: EffectSpec[]): Effect | null {
  if (specs.length === 0) return null
  const nodes = specs.map(
    (spec) =>
      ({
        tag: spec.tag,
        deps: spec.deps,
        create: () => {},
        inst: { destroy: spec.cleanup ? () => {} : undefined },
        destroy: spec.legacyDestroy ? () => {} : null,
        next: null,
      }) as unknown as Effect,
  )
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node) node.next = nodes[(i + 1) % nodes.length] ?? null
  }
  return nodes[nodes.length - 1] ?? null
}

// One fiber whose identity (hence bippy id) is stable across commits; the effect list and alternate are mutated per commit, as React reuses fibers.
function makeComponent(name: string) {
  const type = (): null => null
  Object.assign(type, { displayName: name })
  const fiber = { tag: 0, type, updateQueue: { lastEffect: null }, alternate: null } as Record<
    string,
    unknown
  >
  return {
    commit(phase: RenderPhase, effects: EffectSpec[], prevEffects?: EffectSpec[]) {
      fiber.updateQueue = { lastEffect: effectList(effects) }
      fiber.alternate = prevEffects
        ? { updateQueue: { lastEffect: effectList(prevEffects) } }
        : null
      recordEffect(asFiber(fiber), phase)
    },
  }
}

const byName = async () => new Map((await getEffectAudit({ limit: 50 })).map((r) => [r.name, r]))

// Burn the falsy id 0 (bippy reassigns it) so every test fiber gets a stable id.
beforeAll(() => {
  makeComponent('__warmup__').commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: null }])
})

beforeEach(() => {
  clearEffects()
  clearSourceCache()
  inspector.getSource.mockReset().mockResolvedValue(null)
  // Default: the inspector throws → resolveEffectSources returns null → effects stay unattributed and unfiltered; per-effect tests override getFiberHooks.
  inspector.getFiberHooks.mockReset().mockImplementation(() => {
    throw new Error('inspector unavailable in test')
  })
  inspector.symbolicateStack.mockImplementation(async (frames) => frames)
  // No network in unit tests: inline-map lookup fails → per-effect source keeps served coordinates.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')))
})
afterEach(() => vi.unstubAllGlobals())

describe('recordEffect dependency-mode classification', () => {
  it('flags a no-deps effect that runs after every render', async () => {
    const c = makeComponent('NoDeps')
    c.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: null }])
    c.commit(
      'update',
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
    )
    c.commit(
      'update',
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
    )
    c.commit(
      'update',
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
    )

    const eff = (await byName()).get('NoDeps')?.effects[0]
    expect(eff?.depsMode).toBe('none')
    expect(eff?.fired).toBe(3)
    expect(eff?.updates).toBe(3)
    expect(eff?.firesEveryUpdate).toBe(true)
    expect(eff?.hotness).toMatchObject({
      label: 'hot',
      samples: 3,
      observedRate: 1,
      reason: 'meets-threshold',
    })
    expect(eff?.hotness.confidenceInterval).toMatchObject({ level: 0.95, upper: 1 })
    expect(eff?.note).toMatch(/no dependency array/)
  })

  it('keeps 1/1 as an observation but requires enough samples for a hot diagnosis', async () => {
    const c = makeComponent('OneOfOne')
    c.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: null }])
    c.commit(
      'update',
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
    )

    const defaultFinding = (await byName()).get('OneOfOne')?.effects[0]
    expect(defaultFinding?.firesEveryUpdate).toBe(true)
    expect(defaultFinding?.hotness).toMatchObject({
      label: 'insufficient-data',
      samples: 1,
      minUpdates: 3,
      reason: 'below-minimum-updates',
    })
    expect(defaultFinding?.note).toBeUndefined()
    expect(await getEffectAudit({ limit: 50, onlyHot: true })).toEqual([])

    const lowered = await getEffectAudit({ limit: 50, onlyHot: true, minUpdates: 1 })
    expect(lowered[0]?.effects[0]?.hotness.label).toBe('hot')
  })

  it('uses the requested fire-rate threshold and reports the observed rate', async () => {
    const c = makeComponent('TwoOfThree')
    c.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: [0] }])
    c.commit(
      'update',
      [{ tag: PASSIVE | HAS_EFFECT, deps: [1] }],
      [{ tag: PASSIVE | HAS_EFFECT, deps: [0] }],
    )
    c.commit('update', [{ tag: PASSIVE, deps: [1] }], [{ tag: PASSIVE, deps: [1] }])
    c.commit('update', [{ tag: PASSIVE | HAS_EFFECT, deps: [2] }], [{ tag: PASSIVE, deps: [1] }])

    const defaultFinding = (await byName()).get('TwoOfThree')?.effects[0]
    expect(defaultFinding?.hotness).toMatchObject({
      label: 'not-hot',
      observedRate: 0.6667,
      minFireRate: 1,
      reason: 'below-fire-rate',
    })

    const lowered = await getEffectAudit({
      limit: 50,
      onlyHot: true,
      minFireRate: 0.6,
    })
    expect(lowered[0]?.effects[0]?.hotness).toMatchObject({
      label: 'hot',
      minFireRate: 0.6,
    })
  })

  it('does not flag an empty-deps effect (mount only)', async () => {
    const c = makeComponent('Mounted')
    c.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: [] }])
    c.commit('update', [{ tag: PASSIVE, deps: [] }], [{ tag: PASSIVE, deps: [] }])

    const eff = (await byName()).get('Mounted')?.effects[0]
    expect(eff?.depsMode).toBe('empty')
    expect(eff?.fired).toBe(0)
    expect(eff?.firesEveryUpdate).toBe(false)
    expect(eff?.note).toBeUndefined()
  })
})

describe('recordEffect dependency-change attribution', () => {
  it('names the dependency slot that drives a re-run every update', async () => {
    const stable = { id: 'stable' }
    const a = {}
    const b = {}
    const c = {}
    const comp = makeComponent('Churn')
    comp.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: [stable, a] }])
    comp.commit(
      'update',
      [{ tag: PASSIVE | HAS_EFFECT, deps: [stable, b] }],
      [{ tag: PASSIVE | HAS_EFFECT, deps: [stable, a] }],
    )
    comp.commit(
      'update',
      [{ tag: PASSIVE | HAS_EFFECT, deps: [stable, c] }],
      [{ tag: PASSIVE | HAS_EFFECT, deps: [stable, b] }],
    )
    comp.commit(
      'update',
      [{ tag: PASSIVE | HAS_EFFECT, deps: [stable, {}] }],
      [{ tag: PASSIVE | HAS_EFFECT, deps: [stable, c] }],
    )

    const eff = (await byName()).get('Churn')?.effects[0]
    expect(eff?.fired).toBe(3)
    expect(eff?.firesEveryUpdate).toBe(true)
    expect(eff?.lastChangedDep).toBe(1)
    expect(eff?.note).toMatch(/dependency \[1\] changes/)
  })

  it('does not flag a list-deps effect whose deps stay stable (HasEffect cleared)', async () => {
    const stable = { id: 'stable' }
    const c = makeComponent('Calm')
    c.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: [stable] }])
    c.commit('update', [{ tag: PASSIVE, deps: [stable] }], [{ tag: PASSIVE, deps: [stable] }])

    const eff = (await byName()).get('Calm')?.effects[0]
    expect(eff?.fired).toBe(0)
    expect(eff?.firesEveryUpdate).toBe(false)
    expect(eff?.note).toBeUndefined()
  })
})

describe('recordEffect kind + cleanup', () => {
  it('labels a layout effect and detects a cleanup at inst.destroy (React 18.3+/19)', async () => {
    makeComponent('Layout').commit('mount', [{ tag: LAYOUT | HAS_EFFECT, deps: [], cleanup: true }])
    const eff = (await byName()).get('Layout')?.effects[0]
    expect(eff?.kind).toBe('layout')
    expect(eff?.hasCleanup).toBe(true)
  })

  it('detects a cleanup at effect.destroy (legacy React < 18.3)', async () => {
    makeComponent('Legacy').commit('mount', [
      { tag: PASSIVE | HAS_EFFECT, deps: [], legacyDestroy: true },
    ])
    expect((await byName()).get('Legacy')?.effects[0]?.hasCleanup).toBe(true)
  })

  it('reports no cleanup when the effect returns nothing', async () => {
    makeComponent('NoClean').commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: [] }])
    expect((await byName()).get('NoClean')?.effects[0]?.hasCleanup).toBe(false)
  })
})

describe('recordEffect tracking lifecycle', () => {
  it('ignores non-function-component fibers and evicts on unmount', async () => {
    recordEffect(
      asFiber({ tag: 5, updateQueue: { lastEffect: effectList([{ tag: PASSIVE, deps: null }]) } }),
      'update',
    )
    const gone = makeComponent('Gone')
    gone.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: null }])
    expect((await byName()).get('Gone')).toBeDefined()
    gone.commit('unmount', [{ tag: PASSIVE | HAS_EFFECT, deps: null }])
    expect(await getEffectAudit({ limit: 50 })).toEqual([])
  })

  it('onlyHot returns only components with a smell', async () => {
    const stable = { id: 'stable' }
    const calm = makeComponent('Calm')
    calm.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: [stable] }])
    calm.commit('update', [{ tag: PASSIVE, deps: [stable] }], [{ tag: PASSIVE, deps: [stable] }])

    const loopy = makeComponent('Loopy')
    loopy.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: null }])
    loopy.commit(
      'update',
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
    )
    loopy.commit(
      'update',
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
    )
    loopy.commit(
      'update',
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
      [{ tag: PASSIVE | HAS_EFFECT, deps: null }],
    )

    expect((await getEffectAudit({ limit: 50, onlyHot: true })).map((r) => r.name)).toEqual([
      'Loopy',
    ])
  })
})

describe('per-effect source attribution', () => {
  // One app effect, one effect created inside a library hook (nested subHook), plus an unrelated useState the inspector also reports — the realistic shape.
  const tree = () => [
    hookNode('State', '/src/tree-search.tsx', 30),
    hookNode('Effect', '/src/tree-search.tsx', 99),
    hookNode('Translation', '/src/tree-search.tsx', 24, [
      hookNode('Effect', '/node_modules/@tanstack/react-query/build/index.js', 42),
    ]),
  ]

  it('attributes each effect to its own call-site when the inspector and effect list line up', async () => {
    inspector.getFiberHooks.mockReturnValue(tree())
    const c = makeComponent('TreeSearch')
    c.commit('mount', [
      { tag: PASSIVE | HAS_EFFECT, deps: null },
      { tag: PASSIVE | HAS_EFFECT, deps: [] },
    ])

    const rec = (await getEffectAudit({ limit: 50, appOnly: false })).find(
      (r) => r.name === 'TreeSearch',
    )
    expect(rec?.effects[0]?.source?.line).toBe(99)
    expect(rec?.effects[0]?.isLibrary).toBe(false)
    expect(rec?.effects[0]?.provenance).toMatchObject({
      ownership: 'app',
      confidence: 'high',
      reason: 'exact-hook-order',
      packageName: null,
    })
    expect(rec?.effects[1]?.source?.file).toContain('@tanstack/react-query')
    expect(rec?.effects[1]?.isLibrary).toBe(true)
    expect(rec?.effects[1]?.provenance).toMatchObject({
      ownership: 'library',
      confidence: 'high',
      packageName: '@tanstack/react-query',
    })
  })

  it('drops library-origin effects under appOnly (default), keeping the app effect', async () => {
    inspector.getFiberHooks.mockReturnValue(tree())
    const c = makeComponent('TreeSearchApp')
    c.commit('mount', [
      { tag: PASSIVE | HAS_EFFECT, deps: null },
      { tag: PASSIVE | HAS_EFFECT, deps: [] },
    ])

    const rec = (await getEffectAudit({ limit: 50 })).find((r) => r.name === 'TreeSearchApp')
    expect(rec?.effects).toHaveLength(1)
    expect(rec?.effects[0]?.source?.line).toBe(99)
  })

  it('keeps an exact app effect when the component source only resolves to a library chunk', async () => {
    inspector.getSource.mockResolvedValue({
      fileName: '/node_modules/opaque-server-chunk.js',
      lineNumber: 10,
      columnNumber: 0,
      functionName: 'EffectDemo',
    })
    inspector.getFiberHooks.mockReturnValue([hookNode('Effect', '/src/effect-demo.tsx', 11)])
    const component = makeComponent('MappedEffectDemo')
    component.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: [] }])

    const record = (await getEffectAudit({ limit: 50 })).find(
      (item) => item.name === 'MappedEffectDemo',
    )

    expect(record?.componentProvenance.ownership).toBe('library')
    expect(record?.effects[0]?.provenance).toMatchObject({
      ownership: 'app',
      confidence: 'high',
      hookSource: { file: '/src/effect-demo.tsx', line: 11 },
    })
  })

  it('omits per-effect source when the effect list carries effects the inspector cannot see', async () => {
    // Inspector sees one user effect but the commit list has two (an internal hook like useSyncExternalStore pushed one) — must not mis-attribute.
    inspector.getFiberHooks.mockReturnValue([hookNode('Effect', '/src/a.tsx', 10)])
    const c = makeComponent('Mixed')
    c.commit('mount', [
      { tag: PASSIVE | HAS_EFFECT, deps: [] },
      { tag: PASSIVE | HAS_EFFECT, deps: [] },
    ])

    const rec = (await getEffectAudit({ limit: 50 })).find((r) => r.name === 'Mixed')
    expect(rec?.effects).toHaveLength(2)
    expect(rec?.effects.every((e) => e.source === null)).toBe(true)
    expect(rec?.effects.every((e) => e.isLibrary === false)).toBe(true)
    expect(rec?.effects.every((e) => e.provenance.ownership === 'unknown')).toBe(true)
    expect(rec?.effects.every((e) => e.provenance.reason === 'hook-count-mismatch')).toBe(true)
  })

  it('falls back to no per-effect source when the inspector throws', async () => {
    inspector.getFiberHooks.mockImplementation(() => {
      throw new Error('ReactDebugToolsRenderError')
    })
    const c = makeComponent('Throws')
    c.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: null }])

    const rec = (await getEffectAudit({ limit: 50, appOnly: false })).find(
      (r) => r.name === 'Throws',
    )
    expect(rec?.effects[0]?.source).toBeNull()
    expect(rec?.effects[0]?.isLibrary).toBe(false)
    expect(rec?.effects[0]?.provenance).toMatchObject({
      ownership: 'unknown',
      confidence: 'none',
      reason: 'hook-inspection-unavailable',
    })
  })

  it('marks every effect as library when no effect call-site is app code (data-only component)', async () => {
    // Every inspected call-site is library and the commit list has extra internal effects: the component wrote no useEffect, so the whole list is library noise.
    inspector.getFiberHooks.mockReturnValue([
      hookNode('Effect', '/node_modules/.vite/deps/modern-DdZwUPV5.js', 100),
      hookNode('Effect', '/node_modules/.vite/deps/modern-DdZwUPV5.js', 120),
    ])
    const c = makeComponent('DataOnly')
    c.commit('mount', [
      { tag: PASSIVE | HAS_EFFECT, deps: null },
      { tag: PASSIVE | HAS_EFFECT, deps: [{}] },
      { tag: PASSIVE | HAS_EFFECT, deps: [{}] },
      { tag: PASSIVE | HAS_EFFECT, deps: [{}] },
    ])

    const all = (await getEffectAudit({ limit: 50, appOnly: false })).find(
      (r) => r.name === 'DataOnly',
    )
    expect(all?.effects).toHaveLength(4)
    expect(all?.effects.every((e) => e.isLibrary === true)).toBe(true)
    expect(all?.effects[0]?.provenance).toMatchObject({
      ownership: 'library',
      confidence: 'medium',
      reason: 'library-only-hook-tree',
      packageName: null,
    })
    // appOnly drops a component once all its effects are library-origin.
    expect((await getEffectAudit({ limit: 50 })).find((r) => r.name === 'DataOnly')).toBeUndefined()
  })

  it('does not mark effects library when there is no app effect AND no inspection (failure ≠ all-internal)', async () => {
    inspector.getFiberHooks.mockImplementation(() => {
      throw new Error('unsupported')
    })
    const c = makeComponent('Unknown')
    c.commit('mount', [{ tag: PASSIVE | HAS_EFFECT, deps: null }])
    const rec = (await getEffectAudit({ limit: 50, appOnly: false })).find(
      (r) => r.name === 'Unknown',
    )
    expect(rec?.effects[0]?.isLibrary).toBe(false)
    expect(rec?.effects[0]?.provenance.ownership).toBe('unknown')
  })
})
