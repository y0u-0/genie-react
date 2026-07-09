import type { Fiber } from 'bippy'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Honor a per-fiber __source so a component can classify as library (node_modules) — the shape source.test.ts uses; getFiberHooks stays empty so per-effect attribution is a no-op and component-level filtering drives the counts.
const getSource = vi.fn(async (fiber: { __source?: unknown }) => fiber.__source ?? null)
vi.mock('bippy/source', () => ({
  getSource: (fiber: { __source?: unknown }) => getSource(fiber),
  isSourceFile: (file: string) => !file.includes('/node_modules/'),
  normalizeFileName: (file: string) => file,
  getFiberHooks: () => {
    throw new Error('no inspector in this test')
  },
  symbolicateStack: async (frames: unknown[]) => frames,
}))

const { clearRenders, getRendersReport, recordRender } = await import('./render-tracker')
const { clearEffects, getEffectAuditReport, recordEffect } = await import('./effect-tracker')
const { buildTree } = await import('./fiber')
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
    __source: source,
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
    __source: source,
  })
}

// Burn bippy's falsy id 0 so every fixture gets a stable truthy id.
beforeAll(() => {
  recordRender(renderFiber('__warm__', null), 'mount')
  recordEffect(effectFiber('__warmE__', null, 1), 'mount')
})

beforeEach(() => {
  clearRenders()
  clearEffects()
  clearSourceCache()
  getSource.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

const NODE_MODULES = '/node_modules/.vite/deps/dep.js'

describe('getRendersReport filteredNote count', () => {
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
})

describe('getEffectAuditReport filteredNote count', () => {
  it('counts library-origin effects hidden by appOnly, and 0 when off', async () => {
    recordEffect(effectFiber('AppEffects', at('/src/App.tsx'), 1), 'mount')
    recordEffect(effectFiber('LibEffects', at(NODE_MODULES), 2), 'mount')

    const filtered = await getEffectAuditReport({ limit: 50, appOnly: true })
    expect(filtered.libraryEffectsHidden).toBe(2)
    expect(filtered.components.map((c) => c.name)).toEqual(['AppEffects'])

    const unfiltered = await getEffectAuditReport({ limit: 50, appOnly: false })
    expect(unfiltered.libraryEffectsHidden).toBe(0)
    expect(unfiltered.components.map((c) => c.name).sort()).toEqual(['AppEffects', 'LibEffects'])
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
      __source: at(source),
      ...over,
    })

  it('adds a filteredNote naming the folded library components when appOnly hides some', async () => {
    const libChild = treeFiber('LibChild', NODE_MODULES)
    const libRoot = treeFiber('LibRoot', NODE_MODULES, { child: libChild })
    const app = treeFiber('App', '/src/App.tsx', { child: libRoot })
    const root = asFiber({ tag: 3, type: null, child: app, __source: null })

    const result = await buildTree(root, {
      depth: 30,
      includeHost: false,
      maxNodes: 400,
      appOnly: true,
    })
    expect(result.filteredNote).toMatch(/library components hidden — set appOnly:false to include/)
    expect(result.nodes.map((n) => n.name)).not.toContain('LibChild')
  })

  it('omits filteredNote when nothing is hidden', async () => {
    const app = treeFiber('App', '/src/App.tsx', { child: treeFiber('Panel', '/src/Panel.tsx') })
    const root = asFiber({ tag: 3, type: null, child: app, __source: null })
    const result = await buildTree(root, {
      depth: 30,
      includeHost: false,
      maxNodes: 400,
      appOnly: true,
    })
    expect(result.filteredNote).toBeUndefined()
  })

  it('bounds in-call source classification so large trees still return, then warms the rest off-call', async () => {
    const children = Array.from({ length: 130 }, (_, index) =>
      treeFiber(`Lib${index}`, NODE_MODULES),
    )
    children.forEach((child, index) => {
      child.sibling = children[index + 1] ?? null
    })
    const app = treeFiber('App', '/src/App.tsx', { child: children[0] ?? null })
    const root = asFiber({ tag: 3, type: null, child: app, __source: null })

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
      expect(getSource.mock.calls.length).toBe(131)
    })
  })
})
