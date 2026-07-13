import type { Fiber } from 'bippy'
import type { HooksNode } from 'bippy/source'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSource = vi.fn(async (fiber: { _debugSource?: unknown }) => fiber._debugSource ?? null)
const getFiberHooks = vi.fn<(fiber: unknown) => HooksNode[]>(() => [])
const formatOwnerStack = vi.fn((stack: string) => stack)
const parseStack = vi.fn<() => unknown[]>(() => [])
const symbolicateStack = vi.fn<(frames: unknown[]) => Promise<unknown[]>>(async (frames) => frames)
const getSourceMap = vi.fn<(url: string) => Promise<object | null>>(async () => null)
const getSourceFromSourceMap = vi.fn<
  (
    map: object,
    line: number,
    column: number,
  ) => { fileName: string; lineNumber: number; columnNumber: number } | null
>(() => null)
const normalize = (file: string) => file.replace(/\?.*$/, '').replace(/^https?:\/\/[^/]+/, '')
vi.mock('bippy/source', () => ({
  getSource: (fiber: { _debugSource?: unknown }) => getSource(fiber),
  formatOwnerStack: (stack: string) => formatOwnerStack(stack),
  parseStack: () => parseStack(),
  isSourceFile: (file: string) => !file.includes('/node_modules/') && !file.includes('/.next/'),
  normalizeFileName: normalize,
  getFiberHooks: (fiber: unknown) => getFiberHooks(fiber),
  symbolicateStack: (frames: unknown[]) => symbolicateStack(frames),
  getSourceMap: (url: string) => getSourceMap(url),
  getSourceFromSourceMap: (map: object, line: number, column: number) =>
    getSourceFromSourceMap(map, line, column),
}))

const {
  classifyFiber,
  classifyFibersWithinBudget,
  clearSourceCache,
  isLibraryFile,
  resolveEffectSourceResolution,
  resolveEffectSources,
  resolveExternalStoreSourceResolution,
  resolveSource,
  scheduleClassificationWarmup,
  sourceLabel,
} = await import('./source')

const asFiber = (shape: unknown): Fiber => shape as Fiber
const at = (fileName: string, lineNumber = 1) => ({
  fileName,
  lineNumber,
  columnNumber: 0,
  functionName: null,
})
const hookNode = (
  name: string,
  fileName: string | null,
  line: number | null,
  subHooks: HooksNode[] = [],
): HooksNode => ({
  id: null,
  isStateEditable: false,
  name,
  value: null,
  subHooks,
  hookSource: fileName ? { fileName, lineNumber: line, columnNumber: 0, functionName: null } : null,
})

beforeEach(() => {
  clearSourceCache()
  getSource.mockReset().mockImplementation(async (fiber) => fiber._debugSource ?? null)
  getFiberHooks.mockReset().mockReturnValue([])
  formatOwnerStack.mockReset().mockImplementation((stack) => stack)
  parseStack.mockReset().mockReturnValue([])
  symbolicateStack.mockReset().mockImplementation(async (frames) => frames)
  getSourceMap.mockReset().mockResolvedValue(null)
  getSourceFromSourceMap.mockReset().mockReturnValue(null)
  // No network in unit tests: inline-map lookup fails → resolveHookSource keeps served coordinates.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')))
})
afterEach(() => vi.unstubAllGlobals())

describe('isLibraryFile', () => {
  it('treats project sources as app and node_modules (incl. vite deps) as library', () => {
    expect(isLibraryFile('/src/App.tsx')).toBe(false)
    expect(isLibraryFile('/apps/demo/.next/dev/server/chunks/ssr/root.js')).toBe(false)
    expect(isLibraryFile('/node_modules/.vite/deps/cmdk.js')).toBe(true)
    expect(isLibraryFile('/node_modules/.pnpm/@base-ui+react/dist/index.js')).toBe(true)
  })
})

describe('sourceLabel', () => {
  it('formats a basename:line identity', () => {
    expect(
      sourceLabel({
        file: '/node_modules/.vite/deps/cmdk.js',
        line: 1998,
        column: 0,
        functionName: null,
      }),
    ).toBe('cmdk.js:1998')
    expect(sourceLabel(null)).toBeNull()
  })
})

describe('classifyFiber', () => {
  it('classifies an app component by its source', async () => {
    const { source, isLibrary } = await classifyFiber(
      asFiber({ _debugSource: at('/src/App.tsx', 10) }),
    )
    expect(source?.file).toBe('/src/App.tsx')
    expect(isLibrary).toBe(false)
  })

  it('classifies a library component, normalizing the dev-server URL + ?v= query', async () => {
    const fiber = asFiber({
      _debugSource: at('http://localhost:3100/node_modules/.vite/deps/cmdk.js?v=abc', 1998),
    })
    const { source, isLibrary } = await classifyFiber(fiber)
    expect(source?.file).toBe('/node_modules/.vite/deps/cmdk.js')
    expect(isLibrary).toBe(true)
  })

  it('classifies a Next/Turbopack chunk by its mapped app source', async () => {
    getSourceMap.mockResolvedValue({ version: 3 })
    getSourceFromSourceMap.mockReturnValue({
      fileName: '/apps/demo/app/components/counter.tsx',
      lineNumber: 12,
      columnNumber: 4,
    })
    const fiber = asFiber({
      _debugSource: at('/apps/demo/.next/dev/server/chunks/ssr/root.js', 190),
    })

    const { source, isLibrary } = await classifyFiber(fiber)

    expect(source).toMatchObject({
      file: '/apps/demo/app/components/counter.tsx',
      line: 12,
      column: 4,
    })
    expect(isLibrary).toBe(false)
  })

  it('inherits the nearest composite ancestor when a fiber has no source of its own', async () => {
    const parent = asFiber({ _debugSource: at('/node_modules/.vite/deps/cmdk.js', 200) })
    const child = asFiber({ return: parent })
    const { isLibrary } = await classifyFiber(child)
    expect(isLibrary).toBe(true)
  })

  it('leaves an unresolved fiber as app (never silently hidden)', async () => {
    const { source, isLibrary } = await classifyFiber(asFiber({}))
    expect(source).toBeNull()
    expect(isLibrary).toBe(false)
  })
})

describe('resolveSource caching', () => {
  it('uses captured debug stacks without calling the component or bippy fallback', async () => {
    const component = vi.fn(() => null)
    const debugStack = new Error('captured')
    Object.defineProperty(debugStack, 'stack', {
      value: 'at App (/src/App.tsx:12:4)\nat react-stack-bottom-frame',
    })
    parseStack.mockReturnValue([
      { fileName: '/src/App.tsx', lineNumber: 12, columnNumber: 4, functionName: 'App' },
    ])

    await expect(
      resolveSource(asFiber({ tag: 0, type: component, _debugStack: debugStack })),
    ).resolves.toMatchObject({ file: '/src/App.tsx', line: 12, column: 4 })
    expect(component).not.toHaveBeenCalled()
    expect(getSource).not.toHaveBeenCalled()
  })

  it('caches successes but retries nulls', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('no source map')))
    vi.stubGlobal('fetch', fetchMock)
    const resolved = asFiber({ _debugSource: at('/src/A.tsx') })
    await resolveSource(resolved)
    await resolveSource(resolved)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const missing = asFiber({}) as Fiber & { _debugSource?: ReturnType<typeof at> }
    await expect(resolveSource(missing)).resolves.toBeNull()
    missing._debugSource = at('/src/Recovered.tsx')
    await expect(resolveSource(missing)).resolves.toMatchObject({ file: '/src/Recovered.tsx' })
  })

  it('dedupes concurrent source lookups for the same fiber', async () => {
    let resolveLookup:
      | ((response: { ok: boolean; text: () => Promise<string> }) => void)
      | undefined
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const fiber = asFiber({ _debugSource: at('/assets/Concurrent.js') })
    const first = resolveSource(fiber)
    const second = resolveSource(fiber)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    resolveLookup?.({ ok: false, text: async () => '' })
    await expect(first).resolves.toMatchObject({ file: '/assets/Concurrent.js' })
    await expect(second).resolves.toMatchObject({ file: '/assets/Concurrent.js' })
  })

  it('does not let a pre-clear lookup overwrite or delete the current generation', async () => {
    type FetchResponse = { ok: boolean; text: () => Promise<string> }
    let resolveCurrent: ((response: FetchResponse) => void) | undefined
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCurrent = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const fiber = asFiber({ _debugSource: at('/assets/Generation.js') })
    const staleLookup = resolveSource(fiber)
    clearSourceCache()
    const currentLookup = resolveSource(fiber)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    await expect(staleLookup).resolves.toBeNull()

    const dedupedCurrentLookup = resolveSource(fiber)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveCurrent?.({ ok: false, text: async () => '' })
    await expect(currentLookup).resolves.toMatchObject({ file: '/assets/Generation.js' })
    await expect(dedupedCurrentLookup).resolves.toMatchObject({ file: '/assets/Generation.js' })
    await expect(resolveSource(fiber)).resolves.toMatchObject({ file: '/assets/Generation.js' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops a cleared background warmup before it starts another chunk', async () => {
    vi.useFakeTimers()
    try {
      type FetchResponse = { ok: boolean; text: () => Promise<string> }
      const pending: Array<(value: FetchResponse) => void> = []
      const fetchMock = vi.fn(
        () =>
          new Promise((resolve) => {
            pending.push(resolve)
          }),
      )
      vi.stubGlobal('fetch', fetchMock)
      const fibers = Array.from({ length: 30 }, (_, index) =>
        asFiber({ _debugSource: at(`/assets/Warm${index}.js`) }),
      )

      scheduleClassificationWarmup(fibers)
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(24))
      clearSourceCache()
      for (const resolve of pending) resolve({ ok: false, text: async () => '' })
      await vi.runAllTimersAsync()

      expect(fetchMock).toHaveBeenCalledTimes(24)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not repopulate the source-map cache from a cleared fetch', async () => {
    interface FakeResponse {
      ok: boolean
      text: () => Promise<string>
    }
    let resolveOldFetch: ((response: FakeResponse) => void) | undefined
    let resolveCurrentFetch: ((response: FakeResponse) => void) | undefined
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldFetch = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCurrentFetch = resolve
          }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const source = at('/assets/shared.js', 10)

    const fiber = asFiber({ _debugSource: source })
    const staleLookup = resolveSource(fiber)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    clearSourceCache()
    const inlineMap = Buffer.from(
      JSON.stringify({ version: 3, sources: ['/src/Old.tsx'], names: [], mappings: 'AAAA' }),
    ).toString('base64')
    resolveOldFetch?.({
      ok: true,
      text: async () => `//# sourceMappingURL=data:application/json;base64,${inlineMap}`,
    })
    await expect(staleLookup).resolves.toBeNull()

    const currentLookup = resolveSource(fiber)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    resolveCurrentFetch?.({ ok: false, text: async () => '' })
    await expect(currentLookup).resolves.toMatchObject({ file: '/assets/shared.js', line: 10 })
  })
})

describe('classifyFibersWithinBudget', () => {
  it('stops at the classification limit and marks the result partial', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('no source map')))
    vi.stubGlobal('fetch', fetchMock)
    const fibers = Array.from({ length: 130 }, (_, index) =>
      asFiber({ _debugSource: at(`/src/C${index}.tsx`) }),
    )

    const result = await classifyFibersWithinBudget(fibers, { limit: 120, budgetMs: 500 })

    expect(result.partial).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(120)
    expect(result.classes[0]?.source?.file).toBe('/src/C0.tsx')
    expect(result.classes[129]?.source).toBeNull()
  })
})

describe('resolveEffectSources', () => {
  it('resolves each leaf effect call-site in hook-call order, nested library hooks included', async () => {
    const hooks = [
      hookNode('State', '/src/x.tsx', 30),
      hookNode('Effect', '/src/x.tsx', 99),
      hookNode('Translation', '/src/x.tsx', 24, [
        hookNode(
          'Effect',
          'http://localhost:3100/node_modules/.vite/deps/react-i18next.js?v=a',
          42,
        ),
      ]),
    ]

    const sources = (await resolveEffectSources(asFiber({}), hooks)) ?? []
    expect(sources).toHaveLength(2)
    expect(sources[0]).toMatchObject({ file: '/src/x.tsx', line: 99 })
    expect(sources[1]?.file).toBe('/node_modules/.vite/deps/react-i18next.js')
    expect(isLibraryFile(sources[1]?.file ?? '')).toBe(true)
  })

  it('maps a base-path esbuild asset entry back to the app hook source', async () => {
    getSourceMap.mockResolvedValue({ version: 3 })
    getSourceFromSourceMap.mockReturnValue({
      fileName: '/src/lab.tsx',
      lineNumber: 39,
      columnNumber: 4,
    })
    const hooks = [hookNode('Effect', '/demo/assets/main.js', 12)]

    const resolution = await resolveEffectSourceResolution(asFiber({}), hooks)

    expect(resolution.callsites?.[0]?.source).toMatchObject({
      file: '/src/lab.tsx',
      line: 39,
      column: 4,
    })
  })

  it('keeps served coordinates when a library source-map target is rejected', async () => {
    getSourceMap.mockResolvedValue({ version: 3 })
    getSourceFromSourceMap.mockReturnValue({
      fileName: '/node_modules/dependency/index.js',
      lineNumber: 999,
      columnNumber: 8,
    })
    const hooks = [hookNode('Effect', '/assets/main.js', 12)]

    const resolution = await resolveEffectSourceResolution(asFiber({}), hooks)

    expect(resolution.callsites?.[0]?.source).toMatchObject({
      file: '/assets/main.js',
      line: 12,
      column: 0,
    })
  })

  it('keeps bounded custom-hook ancestry beside the aligned effect callsite', async () => {
    const hooks = [
      hookNode('SearchMetrics', '/src/Search.tsx', 18, [
        hookNode('QueryBridge', '/src/use-query-bridge.ts', 11, [
          hookNode('Effect', '/node_modules/@tanstack/react-query/index.js', 42),
        ]),
      ]),
    ]

    const resolution = await resolveEffectSourceResolution(asFiber({}), hooks)
    expect(resolution.callsites?.[0]).toMatchObject({
      source: { file: '/node_modules/@tanstack/react-query/index.js', line: 42 },
      hookAncestry: [
        { name: 'SearchMetrics', source: { file: '/src/Search.tsx', line: 18 } },
        { name: 'QueryBridge', source: { file: '/src/use-query-bridge.ts', line: 11 } },
      ],
    })
  })

  it('returns [] when the inspector succeeds but finds no user effects', async () => {
    const hooks = [hookNode('State', '/src/x.tsx', 1)]
    expect(await resolveEffectSources(asFiber({}), hooks)).toEqual([])
  })

  it('reports an explicit failure for a supplied inspection that was unavailable', async () => {
    expect(await resolveEffectSourceResolution(asFiber({}), null)).toEqual({
      status: 'inspection-unavailable',
      sources: null,
      callsites: null,
    })
  })

  it('does not shadow-render a component during automatic reports', async () => {
    let componentCalls = 0
    const type = () => {
      componentCalls += 1
      return null
    }
    const fiber = asFiber({ type })

    expect(await resolveEffectSourceResolution(fiber)).toEqual({
      status: 'shadow-render-disabled',
      sources: null,
      callsites: null,
    })
    expect(await resolveExternalStoreSourceResolution(fiber)).toEqual({
      status: 'shadow-render-disabled',
      hooks: null,
    })
    expect(componentCalls).toBe(0)
    expect(getFiberHooks).not.toHaveBeenCalled()
  })

  it('returns inspection-truncated instead of recursively walking an oversized tree', async () => {
    let hooks = [hookNode('Effect', '/src/deep.tsx', 1)]
    for (let depth = 0; depth < 1_100; depth += 1) {
      hooks = [hookNode(`Wrapper${depth}`, null, null, hooks)]
    }

    expect(await resolveEffectSourceResolution(asFiber({}), hooks)).toEqual({
      status: 'inspection-truncated',
      sources: null,
      callsites: null,
    })
  })

  it('marks a supplied tree truncated when primitive callsites exceed the hard cap', async () => {
    const hooks = Array.from({ length: 101 }, (_, index) =>
      hookNode('Effect', `/src/effect-${index}.tsx`, index + 1),
    )

    expect(await resolveEffectSourceResolution(asFiber({}), hooks)).toEqual({
      status: 'inspection-truncated',
      sources: null,
      callsites: null,
    })
  })

  it('bounds retained custom-hook ancestry on a supplied tree', async () => {
    let hooks = [hookNode('Effect', '/src/effect.tsx', 1)]
    for (let depth = 0; depth < 20; depth += 1) {
      hooks = [hookNode(`Wrapper${depth}`, `/src/wrapper-${depth}.ts`, depth + 1, hooks)]
    }

    const resolution = await resolveEffectSourceResolution(asFiber({}), hooks)

    expect(resolution.status).toBe('resolved')
    expect(resolution.callsites?.[0]?.hookAncestry).toHaveLength(12)
  })
})

describe('resolveExternalStoreSourceResolution', () => {
  it('resolves the app callsite, primitive source, and custom-hook ancestry in call order', async () => {
    const hooks = [
      hookNode('Consumer', '/node_modules/bippy/source.js', 1, [
        hookNode('Query', '/src/Search.tsx', 20, [
          hookNode('BaseQuery', '/node_modules/@tanstack/react-query/base.js', 30, [
            hookNode('SyncExternalStore', '/node_modules/react/index.js', 40),
          ]),
        ]),
        hookNode('Store', '/src/use-store.ts', 50, [
          hookNode('SyncExternalStore', '/node_modules/react/index.js', 60),
        ]),
      ]),
    ]

    const type = (): null => null
    Object.assign(type, { displayName: 'Consumer' })
    const resolution = await resolveExternalStoreSourceResolution(asFiber({ type }), hooks)
    expect(resolution).toMatchObject({
      status: 'resolved',
      hooks: [
        {
          callsite: { file: '/src/Search.tsx', line: 20 },
          primitiveSource: { file: '/node_modules/react/index.js', line: 40 },
          hookAncestry: [
            { name: 'Query', source: { file: '/src/Search.tsx', line: 20 } },
            {
              name: 'BaseQuery',
              source: { file: '/node_modules/@tanstack/react-query/base.js', line: 30 },
            },
          ],
        },
        {
          callsite: { file: '/src/use-store.ts', line: 50 },
          primitiveSource: { file: '/node_modules/react/index.js', line: 60 },
        },
      ],
    })
  })

  it('reports an unavailable supplied inspection without a plausible hook source', async () => {
    expect(await resolveExternalStoreSourceResolution(asFiber({}), null)).toEqual({
      status: 'inspection-unavailable',
      hooks: null,
    })
  })
})
