import { type Fiber, FunctionComponentTag } from 'bippy'
import { describe, expect, it, vi } from 'vitest'

// Per-fiber __source so matches classify app vs library, mirroring source.test.ts.
const getSource = vi.fn(async (fiber: { __source?: unknown }) => fiber.__source ?? null)
vi.mock('bippy/source', () => ({
  getSource: (fiber: { __source?: unknown }) => getSource(fiber),
  isSourceFile: (file: string) => !file.includes('/node_modules/'),
  normalizeFileName: (file: string) => file,
  getFiberHooks: () => [],
  symbolicateStack: async (frames: unknown[]) => frames,
}))

const { findByName, matchDetail } = await import('./fiber')
const { classifyFiber } = await import('./source')

const asFiber = (shape: unknown): Fiber => shape as Fiber
const at = (fileName: string) => ({ fileName, lineNumber: 12, columnNumber: 0 })

const component = (name: string, over: Record<string, unknown> = {}): Fiber => {
  const type = (): null => null
  Object.assign(type, { displayName: name })
  return asFiber({
    tag: FunctionComponentTag,
    type,
    key: null,
    child: null,
    sibling: null,
    memoizedProps: {},
    ...over,
  })
}

describe('matchDetail', () => {
  it('reports the fiber kind and a depth-1 props preview', () => {
    const fiber = component('Card', {
      memoizedProps: { title: 'Hi', nested: { deep: { deeper: 1 } } },
    })
    const detail = matchDetail(fiber, 1)
    expect(detail.kind).toBe('function')
    const props = detail.props as { title: unknown; nested: unknown }
    expect(props.title).toBe('Hi')
    // depth-1: the nested object is not fully hydrated.
    expect(props.nested).not.toEqual({ deep: { deeper: 1 } })
  })
})

describe('findByName enrichment flow', () => {
  // root → App (/src) → Modal (/src) and a library Tooltip (node_modules).
  const buildTree = (): Fiber => {
    const tooltip = component('Tooltip', { __source: at('/node_modules/.vite/deps/ui.js') })
    const modal = component('Modal', {
      __source: at('/src/Modal.tsx'),
      memoizedProps: { open: true },
      sibling: tooltip,
    })
    const app = component('App', { __source: at('/src/App.tsx'), child: modal })
    const root = asFiber({ tag: FunctionComponentTag, type: (): null => null, child: app })
    Object.assign(app, { return: root })
    Object.assign(modal, { return: app })
    Object.assign(tooltip, { return: app })
    return root
  }

  it('returns each match with its fiber, so the handler can enrich kind/props/source/isLibrary', async () => {
    const matches = findByName(buildTree(), 'o', false, 50)
    const names = matches.map((m) => m.name).sort()
    expect(names).toEqual(['Modal', 'Tooltip'])

    const enriched = await Promise.all(
      matches.map(async (m) => {
        const { kind, props } = matchDetail(m.fiber, 1)
        const { source, isLibrary } = await classifyFiber(m.fiber)
        return { name: m.name, kind, props, source, isLibrary }
      }),
    )
    const modal = enriched.find((e) => e.name === 'Modal')
    expect(modal?.kind).toBe('function')
    expect(modal?.props).toEqual({ open: true })
    expect(modal?.source?.file).toBe('/src/Modal.tsx')
    expect(modal?.isLibrary).toBe(false)

    const tooltip = enriched.find((e) => e.name === 'Tooltip')
    expect(tooltip?.isLibrary).toBe(true)
    expect(tooltip?.source?.file).toBe('/node_modules/.vite/deps/ui.js')
  })

  it('carries the ancestor path and respects the limit', () => {
    const limited = findByName(buildTree(), 'o', false, 1)
    expect(limited).toHaveLength(1)
    expect(limited[0]?.path).toContain('App')
  })
})
