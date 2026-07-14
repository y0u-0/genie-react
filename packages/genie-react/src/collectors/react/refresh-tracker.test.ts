import type { Fiber, ReactRenderer, RendererRefreshUpdate } from 'bippy'
import type { ReactRefreshHandler, ReactRefreshUpdate } from 'bippy/react-refresh'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  renderers: new Map<number, ReactRenderer>(),
  refreshHandler: null as ReactRefreshHandler | null,
  injectedListener: null as ((renderer: ReactRenderer) => void) | null,
  clearSourceCache: vi.fn(),
  registerFiber: vi.fn((fiber: { id?: number }) => (fiber.id ?? 0) as never),
  nameOf: vi.fn((fiber: { name?: string }) => fiber.name ?? 'Anonymous'),
  probeViteClient: false,
}))

const unsubscribe = (dispose: () => void) => Object.assign(dispose, { [Symbol.dispose]: dispose })

vi.mock('bippy', () => ({
  getDisplayName: (type: { displayName?: string; name?: string }) =>
    type?.displayName ?? type?.name ?? null,
  getRDTHook: () => ({ renderers: mocks.renderers }),
  onRendererInject: (listener: (renderer: ReactRenderer) => void) => {
    mocks.injectedListener = listener
    return unsubscribe(() => {
      if (mocks.injectedListener === listener) mocks.injectedListener = null
    })
  },
  toUnsubscribe: unsubscribe,
}))

vi.mock('bippy/react-refresh', () => ({
  instrumentReactRefresh: ({ onRefresh }: { onRefresh?: ReactRefreshHandler }) => {
    if (mocks.probeViteClient) void fetch('/@vite/client')
    mocks.refreshHandler = onRefresh ?? null
    return unsubscribe(() => {
      if (mocks.refreshHandler === onRefresh) mocks.refreshHandler = null
    })
  },
}))

vi.mock('./fiber', () => ({
  registerFiber: mocks.registerFiber,
  nameOf: mocks.nameOf,
}))

vi.mock('./source', () => ({
  clearSourceCache: mocks.clearSourceCache,
  classifyFibersWithinBudget: async (fibers: Array<{ source?: string }>) => ({
    classes: fibers.map((fiber) => ({
      source: fiber.source ? { file: fiber.source, line: 1, column: 0, functionName: null } : null,
      isLibrary: fiber.source?.includes('node_modules') ?? false,
    })),
    partial: false,
  }),
}))

const tracker = await import('./refresh-tracker')

function fiber(id: number, name: string, source: string): Fiber {
  return { id, name, source } as unknown as Fiber
}

function refreshUpdate(updated: Fiber[], stale: Fiber[]): ReactRefreshUpdate {
  const Updated = Object.assign(() => null, { displayName: 'Updated' })
  const Stale = Object.assign(() => null, { displayName: 'Stale' })
  return {
    filePaths: ['/src/App.tsx', '/src/App.tsx'],
    root: {} as ReactRefreshUpdate['root'],
    updatedComponents: [Updated],
    staleComponents: [Stale],
    updatedFibers: updated,
    staleFibers: stale,
  }
}

beforeEach(() => {
  tracker.disposeRefreshTracking()
  tracker.clearRefreshEvents()
  mocks.renderers.clear()
  mocks.refreshHandler = null
  mocks.injectedListener = null
  mocks.clearSourceCache.mockClear()
  mocks.registerFiber.mockClear()
  mocks.nameOf.mockClear()
  mocks.probeViteClient = false
})

afterEach(() => {
  tracker.disposeRefreshTracking()
  vi.unstubAllGlobals()
})

describe('refresh tracking', () => {
  it("blocks bippy's false Vite probe inside a Turbopack client without replacing fetch", () => {
    const networkFetch = vi.fn<typeof fetch>()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('TURBOPACK_CHUNK_LISTS', [])
    vi.stubGlobal('fetch', networkFetch)
    mocks.probeViteClient = true

    expect(tracker.startRefreshTracking()).toBe(true)

    expect(networkFetch).not.toHaveBeenCalled()
    expect(globalThis.fetch).toBe(networkFetch)
  })

  it('recognizes a streamed Next document before Turbopack globals initialize', () => {
    const networkFetch = vi.fn<typeof fetch>()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) =>
        selector.includes('/_next/') ? { href: '/_next/static/app.css' } : null,
      ),
    })
    vi.stubGlobal('fetch', networkFetch)
    mocks.probeViteClient = true

    expect(tracker.startRefreshTracking()).toBe(true)

    expect(networkFetch).not.toHaveBeenCalled()
    expect(globalThis.fetch).toBe(networkFetch)
  })

  it("blocks bippy's false Vite probe in a plain browser document", () => {
    const networkFetch = vi.fn<typeof fetch>()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('document', { querySelector: vi.fn(() => null) })
    vi.stubGlobal('fetch', networkFetch)
    mocks.probeViteClient = true

    expect(tracker.startRefreshTracking()).toBe(true)

    expect(networkFetch).not.toHaveBeenCalled()
    expect(globalThis.fetch).toBe(networkFetch)
  })

  it("leaves bippy's Vite probe enabled when the document loads Vite's client", () => {
    const networkFetch = vi.fn<typeof fetch>()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) =>
        selector.includes('@vite/client') ? { src: '/@vite/client' } : null,
      ),
    })
    vi.stubGlobal('fetch', networkFetch)
    mocks.probeViteClient = true

    expect(tracker.startRefreshTracking()).toBe(true)

    expect(networkFetch).toHaveBeenCalledOnce()
    expect(networkFetch).toHaveBeenCalledWith('/@vite/client')
  })

  it('captures files, preserved/remounted fibers, invalidates sources, and counts excluded commits', async () => {
    const updated = fiber(1, 'Counter', '/src/Counter.tsx')
    const remounted = fiber(2, 'Form', '/src/Form.tsx')
    const update = refreshUpdate([updated], [remounted])
    let suppressedDuringCommit = false
    const renderer = {
      scheduleRefresh(root: ReactRefreshUpdate['root'], rendererUpdate: RendererRefreshUpdate) {
        suppressedDuringCommit = tracker.isRefreshCommit()
        tracker.noteExcludedRefreshCommit()
        mocks.refreshHandler?.({ ...update, root })
        return rendererUpdate
      },
    } as unknown as ReactRenderer
    mocks.renderers.set(1, renderer)

    expect(tracker.startRefreshTracking()).toBe(true)
    renderer.scheduleRefresh?.(update.root, {} as RendererRefreshUpdate)

    const report = await tracker.getRefreshEvents({ limit: 10, includeSource: true })
    expect(suppressedDuringCommit).toBe(true)
    expect(mocks.clearSourceCache).toHaveBeenCalledOnce()
    expect(report.events).toHaveLength(1)
    expect(report.events[0]).toMatchObject({
      filePaths: ['/src/App.tsx'],
      updatedComponents: ['Updated'],
      remountedComponents: ['Stale'],
      profileCommitsExcluded: 1,
      preservedState: [{ id: 1, name: 'Counter', source: { file: '/src/Counter.tsx' } }],
      remounted: [{ id: 2, name: 'Form', source: { file: '/src/Form.tsx' } }],
    })
  })

  it('is idempotent, wraps later renderers, and disposes without leaving suppression active', () => {
    expect(tracker.startRefreshTracking()).toBe(true)
    expect(tracker.startRefreshTracking()).toBe(true)

    let observed = true
    const lateRenderer = {
      scheduleRefresh() {
        observed = tracker.isRefreshCommit()
      },
    } as unknown as ReactRenderer
    mocks.injectedListener?.(lateRenderer)
    lateRenderer.scheduleRefresh?.({} as never, {} as never)
    expect(observed).toBe(true)

    tracker.disposeRefreshTracking()
    observed = true
    lateRenderer.scheduleRefresh?.({} as never, {} as never)
    expect(observed).toBe(false)
    expect(mocks.refreshHandler).toBeNull()
    expect(mocks.injectedListener).toBeNull()
  })

  it('supports incremental reads and omits source work when requested', async () => {
    const update = refreshUpdate([fiber(1, 'One', '/src/One.tsx')], [])
    const renderer = {
      scheduleRefresh() {
        mocks.refreshHandler?.(update)
      },
    } as unknown as ReactRenderer
    mocks.renderers.set(1, renderer)
    tracker.startRefreshTracking()
    renderer.scheduleRefresh?.({} as never, {} as never)
    const first = await tracker.getRefreshEvents({ limit: 10, includeSource: false })

    expect(first.events[0]?.preservedState[0]?.source).toBeNull()
    expect(
      await tracker.getRefreshEvents({
        afterSequence: first.latestSequence,
        limit: 10,
        includeSource: true,
      }),
    ).toMatchObject({ events: [] })
  })

  it('keeps the refresh transaction open for queued follow-up commits, then promptly closes it', async () => {
    const update = refreshUpdate([], [])
    const renderer = {
      scheduleRefresh() {
        mocks.refreshHandler?.(update)
      },
    } as unknown as ReactRenderer
    mocks.renderers.set(1, renderer)
    tracker.startRefreshTracking()

    renderer.scheduleRefresh?.({} as never, {} as never)
    await Promise.resolve()

    expect(tracker.isRefreshCommit()).toBe(true)
    tracker.noteExcludedRefreshCommit()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(tracker.isRefreshCommit()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1_010))
    expect(tracker.isRefreshCommit()).toBe(false)
    const report = await tracker.getRefreshEvents({ limit: 1, includeSource: false })
    expect(report.events[0]?.profileCommitsExcluded).toBe(1)
  })

  it('attributes commits before scheduleRefresh when the bundler brackets the update', async () => {
    const update = refreshUpdate([], [])
    const renderer = {
      scheduleRefresh() {
        mocks.refreshHandler?.(update)
      },
    } as unknown as ReactRenderer
    mocks.renderers.set(1, renderer)
    tracker.startRefreshTracking()

    tracker.beginBundlerUpdate()
    expect(tracker.isRefreshCommit()).toBe(true)
    tracker.noteExcludedRefreshCommit()
    // Duplicate lifecycle notifications within one open transaction must not erase attribution.
    tracker.beginBundlerUpdate()
    renderer.scheduleRefresh?.({} as never, {} as never)
    tracker.completeBundlerUpdate()

    const report = await tracker.getRefreshEvents({ limit: 1, includeSource: false })
    expect(report.events[0]?.profileCommitsExcluded).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(tracker.isRefreshCommit()).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1_010))
    expect(tracker.isRefreshCommit()).toBe(false)
  })
})
