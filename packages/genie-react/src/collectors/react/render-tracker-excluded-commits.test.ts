import type { Fiber, FiberRoot, InstrumentationOptions } from 'bippy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  options: null as InstrumentationOptions | null,
  refresh: false,
  traverse: vi.fn(),
}))

vi.mock('bippy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bippy')>()
  return {
    ...actual,
    instrument: (options: InstrumentationOptions) => {
      harness.options = options
      return () => {}
    },
    traverseRenderedFibers: harness.traverse,
  }
})

vi.mock('./safe-instrumentation', () => ({
  isSafeRenderer: () => true,
  supportedCommitHandler: (handler: (rendererId: number, root: FiberRoot) => void) => handler,
}))

vi.mock('./refresh-tracker', () => ({
  isRefreshCommit: () => harness.refresh,
  noteExcludedRefreshCommit: () => {},
}))

vi.mock('bippy/source', () => ({
  formatOwnerStack: () => '',
  getFiberHooks: () => [],
  getSourceMap: async () => null,
  getSourceFromSourceMap: () => null,
  isSourceFile: () => true,
  normalizeFileName: (file: string) => file,
  parseStack: () => [],
  symbolicateStack: async (frames: unknown[]) => frames,
}))

import { getInstanceTombstones } from './instance-identity'
import {
  clearRenders,
  disposeRenderTracking,
  getAnalysisFailedFiberCount,
  getRenders,
  startRenderTracking,
  stopRenderTracking,
} from './render-tracker'

function rootWithComponent(name: string): FiberRoot {
  const type = (): null => null
  Object.assign(type, { displayName: name })
  const root = { tag: 3, child: null, return: null } as unknown as Fiber
  const previous = {
    tag: 0,
    type,
    memoizedProps: {},
    memoizedState: null,
    child: null,
    sibling: null,
    return: root,
  } as unknown as Fiber
  const current = {
    ...previous,
    alternate: previous,
    actualDuration: 1,
    selfBaseDuration: 1,
  } as Fiber
  previous.alternate = current
  root.child = current
  return { current: root } as FiberRoot
}

beforeEach(() => {
  disposeRenderTracking()
  clearRenders()
  harness.options = null
  harness.refresh = false
  harness.traverse.mockReset().mockImplementation((root: FiberRoot, visit) => {
    const child = root.current.child
    if (child) visit(child, 'update')
  })
  startRenderTracking()
})

afterEach(() => disposeRenderTracking())

describe('excluded commit traversal baselines', () => {
  it('advances a paused commit without publishing it, then records only the next commit', async () => {
    const root = rootWithComponent('PausedCounter')
    stopRenderTracking()
    harness.options?.onCommitFiberRoot?.(1, root)

    expect(await getRenders({ sort: 'renders', limit: 10 })).toEqual([])
    startRenderTracking()
    harness.options?.onCommitFiberRoot?.(1, root)

    expect(harness.traverse).toHaveBeenCalledTimes(2)
    expect(await getRenders({ sort: 'renders', limit: 10 })).toMatchObject([
      { name: 'PausedCounter', renders: 1 },
    ])
  })

  it('does not publish an unmount tombstone while profiling is paused', () => {
    const root = rootWithComponent('PausedUnmount')
    const child = root.current.child
    expect(child).not.toBeNull()

    stopRenderTracking()
    if (child) harness.options?.onCommitFiberUnmount?.(1, child)
    harness.options?.onCommitFiberRoot?.(1, root)

    expect(getInstanceTombstones()).toEqual([])
  })

  it('fails closed when an excluded baseline cannot advance', async () => {
    const root = rootWithComponent('RecoveredBaseline')
    harness.traverse.mockImplementationOnce(() => {
      throw new Error('baseline failed')
    })

    stopRenderTracking()
    harness.options?.onCommitFiberRoot?.(1, root)
    startRenderTracking()
    harness.options?.onCommitFiberRoot?.(1, root)
    expect(await getRenders({ sort: 'renders', limit: 10 })).toEqual([])

    harness.options?.onCommitFiberRoot?.(1, root)
    expect(await getRenders({ sort: 'renders', limit: 10 })).toMatchObject([
      { name: 'RecoveredBaseline', renders: 1 },
    ])
    expect(getAnalysisFailedFiberCount()).toBe(1)
  })

  it('advances a refresh commit without publishing it, then records only the next commit', async () => {
    const root = rootWithComponent('RefreshedCounter')
    harness.refresh = true
    harness.options?.onCommitFiberRoot?.(1, root)

    harness.refresh = false
    harness.options?.onCommitFiberRoot?.(1, root)

    expect(harness.traverse).toHaveBeenCalledTimes(2)
    expect(await getRenders({ sort: 'renders', limit: 10 })).toMatchObject([
      { name: 'RefreshedCounter', renders: 1 },
    ])
  })
})
