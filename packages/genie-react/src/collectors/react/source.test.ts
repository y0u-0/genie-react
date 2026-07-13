import type { Fiber } from 'bippy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSource = vi.fn(async (fiber: { __source?: unknown }) => fiber.__source ?? null)
const getFiberHooks = vi.fn<(fiber: unknown) => unknown[]>(() => [])
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
  getSource: (fiber: { __source?: unknown }) => getSource(fiber),
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
  resolveEffectSources,
  resolveSource,
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
  subHooks: unknown[] = [],
) => ({
  name,
  subHooks,
  hookSource: fileName ? { fileName, lineNumber: line, columnNumber: 0, functionName: null } : null,
})

beforeEach(() => {
  clearSourceCache()
  getSource.mockClear()
  getFiberHooks.mockReset().mockReturnValue([])
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
    const { source, isLibrary } = await classifyFiber(asFiber({ __source: at('/src/App.tsx', 10) }))
    expect(source?.file).toBe('/src/App.tsx')
    expect(isLibrary).toBe(false)
  })

  it('classifies a library component, normalizing the dev-server URL + ?v= query', async () => {
    const fiber = asFiber({
      __source: at('http://localhost:3100/node_modules/.vite/deps/cmdk.js?v=abc', 1998),
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
      __source: at('/apps/demo/.next/dev/server/chunks/ssr/root.js', 190),
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
    const parent = asFiber({ __source: at('/node_modules/.vite/deps/cmdk.js', 200) })
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
  it('caches successes but retries nulls', async () => {
    const resolved = asFiber({ __source: at('/src/A.tsx') })
    await resolveSource(resolved)
    await resolveSource(resolved)
    const resolvedCalls = getSource.mock.calls.length
    expect(resolvedCalls).toBe(1) // second call served from cache

    getSource.mockClear()
    const missing = asFiber({})
    await resolveSource(missing)
    await resolveSource(missing)
    expect(getSource.mock.calls.length).toBe(2) // null is not cached → retried
  })

  it('dedupes concurrent source lookups for the same fiber', async () => {
    let resolveLookup: ((source: ReturnType<typeof at>) => void) | undefined
    getSource.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve
        }),
    )

    const fiber = asFiber({})
    const first = resolveSource(fiber)
    const second = resolveSource(fiber)

    expect(getSource).toHaveBeenCalledTimes(1)
    resolveLookup?.(at('/src/Concurrent.tsx'))
    await expect(first).resolves.toMatchObject({ file: '/src/Concurrent.tsx' })
    await expect(second).resolves.toMatchObject({ file: '/src/Concurrent.tsx' })
  })
})

describe('classifyFibersWithinBudget', () => {
  it('stops at the classification limit and marks the result partial', async () => {
    const fibers = Array.from({ length: 130 }, (_, index) =>
      asFiber({ __source: at(`/src/C${index}.tsx`) }),
    )

    const result = await classifyFibersWithinBudget(fibers, { limit: 120, budgetMs: 500 })

    expect(result.partial).toBe(true)
    expect(getSource).toHaveBeenCalledTimes(120)
    expect(result.classes[0]?.source?.file).toBe('/src/C0.tsx')
    expect(result.classes[129]?.source).toBeNull()
  })
})

describe('resolveEffectSources', () => {
  it('resolves each leaf effect call-site in hook-call order, nested library hooks included', async () => {
    getFiberHooks.mockReturnValue([
      hookNode('State', '/src/x.tsx', 30),
      hookNode('Effect', '/src/x.tsx', 99),
      hookNode('Translation', '/src/x.tsx', 24, [
        hookNode(
          'Effect',
          'http://localhost:3100/node_modules/.vite/deps/react-i18next.js?v=a',
          42,
        ),
      ]),
    ])

    const sources = (await resolveEffectSources(asFiber({}))) ?? []
    expect(sources).toHaveLength(2)
    expect(sources[0]).toMatchObject({ file: '/src/x.tsx', line: 99 })
    expect(sources[1]?.file).toBe('/node_modules/.vite/deps/react-i18next.js')
    expect(isLibraryFile(sources[1]?.file ?? '')).toBe(true)
  })

  it('returns [] when the inspector succeeds but finds no user effects', async () => {
    getFiberHooks.mockReturnValue([hookNode('State', '/src/x.tsx', 1)])
    expect(await resolveEffectSources(asFiber({}))).toEqual([])
  })

  it('returns null when the inspector cannot replay the component', async () => {
    getFiberHooks.mockImplementation(() => {
      throw new Error('unsupported hook')
    })
    expect(await resolveEffectSources(asFiber({}))).toBeNull()
  })

  it('caches a resolved array by fiber id', async () => {
    getFiberHooks.mockReturnValue([hookNode('Effect', '/src/x.tsx', 5)])
    const fiber = asFiber({})
    await resolveEffectSources(fiber)
    await resolveEffectSources(fiber)
    expect(getFiberHooks.mock.calls.length).toBe(1) // second call served from cache
  })
})
