import {
  type Fiber,
  FunctionComponentTag,
  HostComponentTag,
  HostRootTag,
  isCompositeFiber,
  isHostFiber,
} from 'bippy'
import { describe, expect, it } from 'vitest'
import {
  buildTree,
  findByName,
  findFiberById,
  type NodeId,
  nameOf,
  noteCommit,
  registerFiber,
  type TreeNode,
  type TreeResult,
} from './fiber'

const asFiber = (shape: unknown): Fiber => shape as Fiber

// Deterministic PRNG (mulberry32) so failures reproduce.
function rng(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NAME_POOL = ['Row', 'RowHeader', 'Cell', 'CellBody', 'Label', 'Grid', 'Zed']

function namedComponent(name: string): () => null {
  const type = (): null => null
  Object.defineProperty(type, 'name', { value: name })
  return type
}

function makeFiber(tag: number, type: unknown, key: string | null): Fiber {
  return asFiber({
    tag,
    type,
    key,
    child: null,
    sibling: null,
    return: null,
    alternate: null,
    memoizedProps: {},
    memoizedState: null,
    stateNode: null,
  })
}

function randomTree(random: () => number, maxFibers: number): Fiber {
  const root = makeFiber(HostRootTag, null, null)
  let budget = maxFibers
  const grow = (parent: Fiber, depth: number): void => {
    if (budget <= 0 || depth > 8) return
    const children: Fiber[] = []
    const count = 1 + Math.floor(random() * 4)
    for (let i = 0; i < count && budget > 0; i += 1) {
      budget -= 1
      const host = random() < 0.4
      const key = random() < 0.2 ? `k${Math.floor(random() * 5)}` : null
      const child = host
        ? makeFiber(HostComponentTag, random() < 0.5 ? 'div' : 'span', key)
        : makeFiber(
            FunctionComponentTag,
            namedComponent(NAME_POOL[Math.floor(random() * NAME_POOL.length)] ?? 'Row'),
            key,
          )
      children.push(child)
      if (random() < 0.7) grow(child, depth + 1)
    }
    parent.child = children[0] ?? null
    children.forEach((child, i) => {
      child.return = parent
      child.sibling = children[i + 1] ?? null
    })
  }
  grow(root, 0)
  return root
}

// ── Reference oracles: the exact pre-optimization implementations (see git history of fiber.ts) ──

function referenceCountNodes(root: Fiber, includeHost: boolean): number {
  let count = 0
  const visit = (fiber: Fiber): void => {
    let child: Fiber | null = fiber.child
    while (child) {
      if (isCompositeFiber(child) || (includeHost && isHostFiber(child))) count += 1
      visit(child)
      child = child.sibling
    }
  }
  visit(root)
  return count
}

function referenceHasReportableDescendant(root: Fiber, includeHost: boolean): boolean {
  let child: Fiber | null = root.child
  while (child) {
    if (isCompositeFiber(child) || (includeHost && isHostFiber(child))) return true
    if (referenceHasReportableDescendant(child, includeHost)) return true
    child = child.sibling
  }
  return false
}

function referenceBuildTree(
  root: Fiber,
  options: { depth: number; includeHost: boolean; maxNodes: number },
): TreeResult {
  const entries: { node: TreeNode; fiber: Fiber }[] = []
  let depthClipped = false
  let nodeCapped = false

  const visit = (fiber: Fiber, parentId: NodeId | null, depth: number): void => {
    let child: Fiber | null = fiber.child
    while (child) {
      const composite = isCompositeFiber(child)
      const keep = composite || (options.includeHost && isHostFiber(child))
      if (keep) {
        if (entries.length >= options.maxNodes) {
          nodeCapped = true
          return
        }
        const id = registerFiber(child)
        entries.push({
          node: {
            id,
            parentId,
            name: nameOf(child),
            key: child.key,
            kind: composite ? 'component' : 'host',
          },
          fiber: child,
        })
        if (depth > 0) visit(child, id, depth - 1)
        else if (referenceHasReportableDescendant(child, options.includeHost)) depthClipped = true
      } else {
        visit(child, parentId, depth)
      }
      child = child.sibling
    }
  }

  visit(root, null, options.depth)
  const total = referenceCountNodes(root, options.includeHost)
  const nodes = entries.map((entry) => entry.node)
  const truncatedBy = nodeCapped ? 'maxNodes' : depthClipped ? 'depth' : null
  return {
    rootId: nodes[0]?.id ?? null,
    nodes,
    total,
    truncated: truncatedBy !== null,
    truncatedBy,
  }
}

function referenceFindByName(
  root: Fiber,
  query: string,
  exact: boolean,
  limit: number,
): { id: NodeId; name: string; path: string }[] {
  const matches: { id: NodeId; name: string; path: string }[] = []
  const needle = query.toLowerCase()

  const visit = (fiber: Fiber, ancestors: string[]): void => {
    let child: Fiber | null = fiber.child
    while (child) {
      if (matches.length >= limit) return
      if (isCompositeFiber(child)) {
        const name = nameOf(child)
        const hit = exact ? name === query : name.toLowerCase().includes(needle)
        if (hit)
          matches.push({ id: registerFiber(child), name, path: [...ancestors, name].join(' > ') })
        visit(child, [...ancestors, name])
      } else {
        visit(child, ancestors)
      }
      child = child.sibling
    }
  }

  visit(root, [])
  return matches
}

const DEPTHS = [0, 1, 2, 5, 30]
const MAX_NODES = [1, 7, 50, 10_000]

describe('optimized walkers preserve pre-optimization behavior', () => {
  it('buildTree matches the reference on randomized trees across the option grid', async () => {
    const random = rng(20260709)
    for (let round = 0; round < 25; round += 1) {
      const root = randomTree(random, 40 + Math.floor(random() * 500))
      for (const depth of DEPTHS) {
        for (const maxNodes of MAX_NODES) {
          for (const includeHost of [false, true]) {
            const options = { depth, maxNodes, includeHost }
            const actual = await buildTree(root, options)
            expect(actual, JSON.stringify(options)).toEqual(referenceBuildTree(root, options))
          }
        }
      }
    }
  })

  it('buildTree can include one selected component as a bounded subtree root', async () => {
    const root = makeFiber(HostRootTag, null, null)
    const parent = makeFiber(FunctionComponentTag, namedComponent('Parent'), null)
    const child = makeFiber(FunctionComponentTag, namedComponent('Child'), null)
    const grandchild = makeFiber(FunctionComponentTag, namedComponent('Grandchild'), null)
    const hostLeaf = makeFiber(HostComponentTag, 'div', null)
    const unrelated = makeFiber(FunctionComponentTag, namedComponent('Unrelated'), null)
    root.child = parent
    parent.return = root
    parent.child = child
    parent.sibling = unrelated
    child.return = parent
    child.child = grandchild
    grandchild.return = child
    grandchild.child = hostLeaf
    hostLeaf.return = grandchild
    unrelated.return = root

    const parentId = registerFiber(parent)
    const subtree = await buildTree(parent, {
      depth: 2,
      includeHost: false,
      maxNodes: 100,
      includeRoot: true,
    })

    expect(subtree.rootId).toBe(parentId)
    expect(subtree.nodes.map((node) => node.name)).toEqual(['Parent', 'Child', 'Grandchild'])
    expect(subtree.nodes[0]?.parentId).toBeNull()
    expect(subtree.total).toBe(3)
    expect(subtree.truncated).toBe(false)
    expect(subtree.truncatedBy).toBeNull()
  })

  it('findByName matches the reference for hits, misses, exact, and limits', () => {
    const random = rng(97)
    for (let round = 0; round < 25; round += 1) {
      const root = randomTree(random, 40 + Math.floor(random() * 500))
      for (const query of ['Row', 'row', 'Cell', 'ell', 'Zed', 'Missing', '']) {
        for (const exact of [false, true]) {
          for (const limit of [1, 3, 100]) {
            const actual = findByName(root, query, exact, limit).map(({ id, name, path }) => ({
              id,
              name,
              path,
            }))
            expect(actual, `${query}/${exact}/${limit}`).toEqual(
              referenceFindByName(root, query, exact, limit),
            )
          }
        }
      }
    }
  })

  it('findFiberById resolves registered, swapped-buffer, and unmounted fibers as before', () => {
    const random = rng(1234)
    const root = randomTree(random, 200)
    const { nodes } = referenceBuildTree(root, { depth: 30, maxNodes: 10_000, includeHost: true })
    const deepId = nodes[nodes.length - 1]?.id
    if (deepId === undefined) throw new Error('fixture produced no nodes')

    expect(findFiberById(root, deepId)).not.toBeNull()

    const target = findFiberById(root, deepId) as Fiber
    const stale = makeFiber(target.tag, target.type, target.key)
    stale.alternate = target
    target.alternate = stale
    registerFiber(stale)
    expect(findFiberById(root, deepId), 'stale buffer resolves to its mounted alternate').toBe(
      target,
    )

    const orphanRoot = randomTree(random, 50)
    const orphan = referenceBuildTree(orphanRoot, {
      depth: 30,
      maxNodes: 10_000,
      includeHost: true,
    })
    const orphanId = orphan.nodes[orphan.nodes.length - 1]?.id
    if (orphanId === undefined) throw new Error('orphan fixture produced no nodes')
    expect(findFiberById(root, orphanId), 'fiber from another tree is not resolved').toBeNull()
  })
})

describe('commit-versioned cache stays invisible to callers', () => {
  const options = { depth: 30, maxNodes: 10_000, includeHost: true }

  it('reflects tree changes while no commit has ever been observed (cache disabled)', async () => {
    const random = rng(5)
    const root = randomTree(random, 100)
    const before = await buildTree(root, options)
    const extra = makeFiber(FunctionComponentTag, namedComponent('Appended'), null)
    extra.return = root
    let last = root.child as Fiber
    while (last.sibling) last = last.sibling
    last.sibling = extra
    const after = await buildTree(root, options)
    expect(after.total).toBe(before.total + 1)
    expect(after.nodes.map((n) => n.name)).toContain('Appended')
  })

  it('serves identical results between commits and fresh results after a commit', async () => {
    const random = rng(6)
    const root = randomTree(random, 100)
    noteCommit()
    const first = await buildTree(root, options)
    expect(await buildTree(root, options)).toEqual(first)

    const extra = makeFiber(FunctionComponentTag, namedComponent('PostCommit'), null)
    extra.return = root
    let last = root.child as Fiber
    while (last.sibling) last = last.sibling
    last.sibling = extra
    noteCommit()
    const second = await buildTree(root, options)
    expect(second.total).toBe(first.total + 1)
    expect(second.nodes.map((n) => n.name)).toContain('PostCommit')
  })

  it('never crosses option boundaries', async () => {
    const random = rng(7)
    const root = randomTree(random, 100)
    noteCommit()
    const wide = await buildTree(root, options)
    const narrow = await buildTree(root, { ...options, maxNodes: 3 })
    expect(narrow.nodes.length).toBeLessThanOrEqual(3)
    expect(narrow).not.toEqual(wide)
  })
})
