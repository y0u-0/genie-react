import type { Fiber } from 'bippy'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Honor a per-fiber _debugSource so a component can classify as library (node_modules) — the shape source.test.ts uses; getFiberHooks stays empty so per-effect attribution is a no-op and component-level filtering drives the counts.
const getSource = vi.fn(async (fiber: { _debugSource?: unknown }) => fiber._debugSource ?? null)
vi.mock('bippy/source', () => ({
  getSource: (fiber: { _debugSource?: unknown }) => getSource(fiber),
  isSourceFile: (file: string) => !file.includes('/node_modules/'),
  normalizeFileName: (file: string) => file,
  getFiberHooks: (fiber: { __hooks?: unknown }) => {
    if (fiber.__hooks) return fiber.__hooks
    throw new Error('no inspector in this test')
  },
  symbolicateStack: async (frames: unknown[]) => frames,
}))

const {
  clearRenders,
  clearSnapshots,
  getRenderCauseEventsReport,
  getRendersMeasurement,
  getRendersReport,
  recordRender,
  snapshotLabels,
  takeSnapshot,
} = await import('./render-tracker')
const { clearEffects, getEffectAuditReport, recordEffect } = await import('./effect-tracker')
const { buildTree } = await import('./fiber')
const { noteDocumentCommit } = await import('./observation')
const { clearSourceCache } = await import('./source')

const asFiber = (shape: unknown): Fiber => shape as Fiber
const at = (fileName: string) => ({ fileName, lineNumber: 1, columnNumber: 0 })

const renderFiber = (name: string, source: ReturnType<typeof at> | null): Fiber => {
  const type = (): null => null
  Object.assign(type, { displayName: name })
  return asFiber({
    tag: 0,
    type,
    memoizedProps: {},
    memoizedState: null,
    actualDuration: 1,
    selfBaseDuration: 1,
    child: null,
    alternate: null,
    _debugSource: source,
  })
}

const HAS_EFFECT = 0b0001
const PASSIVE = 0b1000

function effectFiber(
  name: string,
  source: ReturnType<typeof at> | null,
  effectCount: number,
): Fiber {
  const nodes = Array.from({ length: effectCount }, () => ({
    tag: PASSIVE | HAS_EFFECT,
    deps: null,
    create: () => {},
    inst: {},
    destroy: null,
    next: null as unknown,
  }))
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node) node.next = nodes[(i + 1) % nodes.length] ?? null
  }
  const type = (): null => null
  Object.assign(type, { displayName: name })
  return asFiber({
    tag: 0,
    type,
    updateQueue: { lastEffect: nodes[nodes.length - 1] },
    alternate: null,
    _debugSource: source,
  })
}

// Burn bippy's falsy id 0 so every fixture gets a stable truthy id.
beforeAll(() => {
  recordRender(renderFiber('__warm__', null), 'mount')
  recordEffect(effectFiber('__warmE__', null, 1), 'mount')
})

beforeEach(() => {
  clearRenders()
  clearSnapshots()
  clearEffects()
  clearSourceCache()
  getSource.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

const NODE_MODULES = '/node_modules/.vite/deps/dep.js'

describe('getRendersReport filteredNote count', () => {
  it('does not attribute unresolved ownership to the app', async () => {
    recordRender(renderFiber('UnknownOwner', null), 'mount')

    const appOnly = await getRendersReport({ sort: 'renders', limit: 50, appOnly: true })
    const unfiltered = await getRendersReport({ sort: 'renders', limit: 50, appOnly: false })

    expect(appOnly.components).toEqual([])
    expect(appOnly.libraryHidden).toBe(1)
    expect(unfiltered.components).toMatchObject([
      { name: 'UnknownOwner', sourceOwnership: 'unknown' },
    ])
  })

  it('counts library components hidden by appOnly, and 0 when appOnly is off', async () => {
    recordRender(renderFiber('AppThing', at('/src/App.tsx')), 'mount')
    recordRender(renderFiber('LibThing', at(NODE_MODULES)), 'mount')

    const filtered = await getRendersReport({ sort: 'renders', limit: 50, appOnly: true })
    expect(filtered.libraryHidden).toBe(1)
    expect(filtered.components.map((c) => c.name)).toEqual(['AppThing'])

    const unfiltered = await getRendersReport({ sort: 'renders', limit: 50, appOnly: false })
    expect(unfiltered.libraryHidden).toBe(0)
    expect(unfiltered.components.map((c) => c.name).sort()).toEqual(['AppThing', 'LibThing'])
  })

  it('does not infer app ownership by re-running a framework-wrapped component', async () => {
    const currentSnapshot = { status: 'success', dataUpdatedAt: 2, fetchStatus: 'idle' }
    const previousSnapshot = { status: 'success', dataUpdatedAt: 1, fetchStatus: 'idle' }
    const hookNode = (snapshot: unknown) => ({
      memoizedState: snapshot,
      queue: { value: snapshot, getSnapshot: () => snapshot },
      next: null,
    })
    const inspectedHooks = [
      {
        name: 'SyncExternalStore',
        hookSource: at('/src/routes/dashboard.tsx'),
        subHooks: [],
      },
    ]
    const fiber = renderFiber('WrappedDashboard', at(NODE_MODULES)) as Fiber & {
      __hooks?: unknown
    }
    Object.assign(fiber, {
      memoizedState: hookNode(currentSnapshot),
      __hooks: inspectedHooks,
      alternate: {
        memoizedProps: {},
        memoizedState: hookNode(previousSnapshot),
        __hooks: inspectedHooks,
      },
    })
    recordRender(fiber, 'update')

    const appOnly = await getRendersMeasurement({ sort: 'renders', limit: 50, appOnly: true })
    expect(appOnly.summary.trackedComponents).toBe(0)
    expect(appOnly.libraryHidden).toBe(1)
    expect(appOnly.components).toEqual([])

    const allComponents = await getRendersMeasurement({
      sort: 'renders',
      limit: 50,
      appOnly: false,
    })
    expect(allComponents.components).toMatchObject([
      {
        name: 'WrappedDashboard',
        isLibrary: true,
        source: { file: NODE_MODULES },
        causes: [
          {
            kind: 'query',
            evidence: 'inferred',
            hookProvenance: {
              status: 'unavailable',
              evidence: 'unknown',
              reason: 'shadow-render-disabled',
            },
          },
        ],
      },
    ])
  })

  it('downgrades live source and hook evidence when the document advances during attribution', async () => {
    let releaseSource: ((value: { ok: boolean; text: () => Promise<string> }) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            releaseSource = resolve
          }),
      ),
    )
    const currentSnapshot = { status: 'success', dataUpdatedAt: 2, fetchStatus: 'idle' }
    const previousSnapshot = { status: 'success', dataUpdatedAt: 1, fetchStatus: 'idle' }
    const hookNode = (snapshot: unknown) => ({
      memoizedState: snapshot,
      queue: { value: snapshot, getSnapshot: () => snapshot },
      next: null,
    })
    const inspectedHooks = [
      { name: 'SyncExternalStore', hookSource: at('/src/use-dashboard.ts'), subHooks: [] },
    ]
    const fiber = renderFiber('AtomicDashboard', at(NODE_MODULES)) as Fiber & {
      __hooks?: unknown
    }
    Object.assign(fiber, {
      memoizedState: hookNode(currentSnapshot),
      __hooks: inspectedHooks,
      alternate: {
        memoizedProps: {},
        memoizedState: hookNode(previousSnapshot),
        __hooks: inspectedHooks,
      },
    })
    recordRender(fiber, 'update')

    const pending = getRendersMeasurement({ sort: 'renders', limit: 50, appOnly: true })
    await vi.waitFor(() => expect(releaseSource).toBeTypeOf('function'))
    noteDocumentCommit()
    releaseSource?.({ ok: false, text: async () => '' })
    const measurement = await pending

    expect(measurement.attribution).toMatchObject({ status: 'stale' })
    expect(measurement.libraryHidden).toBe(1)
    expect(measurement.components).toEqual([])
  })

  it('marks an in-flight report stale when counters are cleared without a commit', async () => {
    let releaseSource: ((value: { ok: boolean; text: () => Promise<string> }) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            releaseSource = resolve
          }),
      ),
    )
    recordRender(renderFiber('ClearedDuringRead', at('/src/App.tsx')), 'mount')

    const pending = getRendersMeasurement({ sort: 'renders', limit: 50, appOnly: true })
    await vi.waitFor(() => expect(releaseSource).toBeTypeOf('function'))
    clearRenders()
    releaseSource?.({ ok: false, text: async () => '' })
    const measurement = await pending

    expect(measurement.attribution.status).toBe('stale')
    expect(measurement.attribution.completedAtDocumentCommitId).toBe(
      measurement.attribution.startedAtDocumentCommitId,
    )
    expect(measurement.attribution.completedAtAnalysisGeneration).toBeGreaterThan(
      measurement.attribution.startedAtAnalysisGeneration,
    )
    expect(measurement.libraryHidden).toBe(1)
    expect(measurement.components).toEqual([])
  })

  it('does not store a mixed-state verification snapshot', async () => {
    let releaseSource: ((value: { ok: boolean; text: () => Promise<string> }) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            releaseSource = resolve
          }),
      ),
    )
    recordRender(renderFiber('SnapshotTarget', at('/src/App.tsx')), 'mount')

    const pending = takeSnapshot('before-fix')
    await vi.waitFor(() => expect(releaseSource).toBeTypeOf('function'))
    noteDocumentCommit()
    releaseSource?.({ ok: false, text: async () => '' })

    await expect(pending).rejects.toThrow('Retry after commits, clears, or refreshes settle')
    expect(snapshotLabels()).not.toContain('before-fix')
  })

  it('filters library events before applying the page limit', async () => {
    recordRender(renderFiber('OlderAppEvent', at('/src/App.tsx')), 'mount')
    recordRender(renderFiber('NewestLibraryEvent', at(NODE_MODULES)), 'mount')

    const report = await getRenderCauseEventsReport({ limit: 1, appOnly: true })
    expect(report.events.map((event) => event.componentName)).toEqual(['OlderAppEvent'])
    expect(report.libraryHidden).toBe(1)
    expect(report.omittedByLimit).toBe(0)
  })

  it('keeps historical instance identity and withholds current hook proof from old events', async () => {
    const hookNode = (snapshot: unknown) => ({
      memoizedState: snapshot,
      queue: { value: snapshot, getSnapshot: () => snapshot },
      next: null,
    })
    const hooks = [
      {
        name: 'SyncExternalStore',
        hookSource: at('/src/use-store.ts'),
        subHooks: [],
      },
    ]
    const fiber = renderFiber('ChangingSubscriber', at('/src/App.tsx')) as Fiber & {
      __hooks?: unknown
    }
    Object.assign(fiber, {
      key: 'before',
      memoizedState: hookNode(1),
      __hooks: hooks,
      alternate: { memoizedProps: {}, memoizedState: hookNode(0), __hooks: hooks },
    })
    recordRender(fiber, 'update')
    Object.assign(fiber, {
      key: 'after',
      memoizedState: hookNode(2),
      alternate: { memoizedProps: {}, memoizedState: hookNode(1), __hooks: hooks },
    })
    recordRender(fiber, 'update')

    const report = await getRenderCauseEventsReport({ limit: 2, appOnly: false })
    expect(report.events[0]).toMatchObject({
      instance: { key: 'after' },
      causes: [
        {
          hookProvenance: {
            status: 'unavailable',
            evidence: 'unknown',
            reason: 'shadow-render-disabled',
          },
        },
      ],
    })
    expect(report.events[1]).toMatchObject({
      instance: { key: 'before' },
      source: null,
      sourceOwnership: 'unknown',
      sourceAttribution: { role: 'unavailable', evidence: 'unknown' },
      causes: [
        {
          hookProvenance: {
            status: 'unavailable',
            evidence: 'unknown',
            reason: 'event-not-latest',
          },
        },
      ],
    })
  })
})

describe('getEffectAuditReport filteredNote count', () => {
  it('does not attribute unresolved effect provenance to the app', async () => {
    recordEffect(effectFiber('UnknownEffectOwner', null, 1), 'mount')

    const appOnly = await getEffectAuditReport({ limit: 50, appOnly: true })
    const unfiltered = await getEffectAuditReport({ limit: 50, appOnly: false })

    expect(appOnly.components).toEqual([])
    expect(unfiltered.components[0]).toMatchObject({
      name: 'UnknownEffectOwner',
      componentProvenance: { ownership: 'unknown' },
      effects: [{ provenance: { ownership: 'unknown' } }],
    })
  })

  it('counts library-origin effects hidden by appOnly, and 0 when off', async () => {
    recordEffect(effectFiber('AppEffects', at('/src/App.tsx'), 1), 'mount')
    recordEffect(effectFiber('LibEffects', at(NODE_MODULES), 2), 'mount')

    const filtered = await getEffectAuditReport({ limit: 50, appOnly: true })
    expect(filtered.libraryEffectsHidden).toBe(3)
    expect(filtered.components).toEqual([])

    const unfiltered = await getEffectAuditReport({ limit: 50, appOnly: false })
    expect(unfiltered.libraryEffectsHidden).toBe(0)
    expect(unfiltered.components.map((c) => c.name).sort()).toEqual(['AppEffects', 'LibEffects'])
  })

  it('marks effect provenance unknown when its report snapshot is stale', async () => {
    recordEffect(effectFiber('StaleEffects', at('/src/App.tsx'), 1), 'mount')

    const report = await getEffectAuditReport({
      limit: 50,
      appOnly: false,
      isAttributionCurrent: () => false,
    })
    expect(report.components).toMatchObject([
      {
        componentProvenance: { ownership: 'unknown', evidence: 'unknown' },
        effects: [
          {
            provenance: {
              ownership: 'unknown',
              evidence: 'unknown',
              reason: 'report-state-advanced',
            },
          },
        ],
      },
    ])
  })
})

describe('buildTree filteredNote', () => {
  const treeType = (name: string) => {
    const type = (): null => null
    Object.assign(type, { displayName: name })
    return type
  }
  // root → App(/src) → LibRoot(node_modules) → LibChild(node_modules): the library subtree folds to its top node.
  const treeFiber = (name: string, source: string, over: Record<string, unknown> = {}): Fiber =>
    asFiber({
      tag: 0,
      type: treeType(name),
      key: null,
      child: null,
      sibling: null,
      _debugSource: at(source),
      ...over,
    })

  it('adds a filteredNote naming the folded library components when appOnly hides some', async () => {
    const libChild = treeFiber('LibChild', NODE_MODULES)
    const libRoot = treeFiber('LibRoot', NODE_MODULES, { child: libChild })
    const app = treeFiber('App', '/src/App.tsx', { child: libRoot })
    const root = asFiber({ tag: 3, type: null, child: app, _debugSource: null })

    const result = await buildTree(root, {
      depth: 30,
      includeHost: false,
      maxNodes: 400,
      appOnly: true,
    })
    expect(result.filteredNote).toMatch(
      /library\/unknown components hidden — set appOnly:false to include/,
    )
    expect(result.nodes.map((n) => n.name)).not.toContain('LibChild')
  })

  it('omits filteredNote when nothing is hidden', async () => {
    const app = treeFiber('App', '/src/App.tsx', { child: treeFiber('Panel', '/src/Panel.tsx') })
    const root = asFiber({ tag: 3, type: null, child: app, _debugSource: null })
    const result = await buildTree(root, {
      depth: 30,
      includeHost: false,
      maxNodes: 400,
      appOnly: true,
    })
    expect(result.filteredNote).toBeUndefined()
  })

  it('bounds in-call source classification so large trees still return, then warms the rest off-call', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('no source map')))
    vi.stubGlobal('fetch', fetchMock)
    const children = Array.from({ length: 130 }, (_, index) =>
      treeFiber(`Lib${index}`, `${NODE_MODULES}?instance=${index}`),
    )
    children.forEach((child, index) => {
      child.sibling = children[index + 1] ?? null
    })
    const app = treeFiber('App', '/src/App.tsx', { child: children[0] ?? null })
    const root = asFiber({ tag: 3, type: null, child: app, _debugSource: null })

    const result = await buildTree(root, {
      depth: 30,
      includeHost: false,
      maxNodes: 400,
      appOnly: true,
    })

    // The partial note proves the call itself stopped at the 120 budget; the off-call warmup then finishes the remaining fibers.
    expect(result.filteredNote).toContain('source classification budget reached')
    expect(result.nodes.length).toBeGreaterThan(0)
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(131)
    })
  })
})
