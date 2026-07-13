import type { Fiber } from 'bippy'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginInstanceObservation,
  clearInstanceIdentityForTests,
  discardExcludedInstanceUnmount,
  getInstanceIdentityCoverage,
  getInstanceTombstones,
  instanceForMountedFiber,
  noteInstanceRender,
  wasInstanceObserved,
} from './instance-identity'

const asFiber = (value: unknown): Fiber => value as Fiber

function component(name: string, key: string | null = null): Fiber {
  const type = (): null => null
  Object.assign(type, { displayName: name })
  return asFiber({
    tag: 0,
    type,
    key,
    child: null,
    sibling: null,
    return: null,
    alternate: null,
    memoizedProps: {},
    memoizedState: null,
  })
}

function host(type: string): Fiber {
  return asFiber({
    tag: 5,
    type,
    key: null,
    child: null,
    sibling: null,
    return: null,
    alternate: null,
  })
}

function attach(parent: Fiber, children: Fiber[]): void {
  ;(parent as { child: Fiber | null }).child = children[0] ?? null
  children.forEach((child, index) => {
    ;(child as { return: Fiber }).return = parent
    ;(child as { sibling: Fiber | null }).sibling = children[index + 1] ?? null
  })
}

beforeEach(() => clearInstanceIdentityForTests())

describe('React component instance identity', () => {
  it('keeps a keyed physical mount stable when sibling order changes', () => {
    const parent = component('Rows')
    const a = component('Row', 'a')
    const b = component('Row', 'b')
    attach(parent, [a, b])

    const mounted = noteInstanceRender(a, 'mount', 1, 10)
    attach(parent, [b, a])
    const reordered = instanceForMountedFiber(a)

    expect(reordered).toMatchObject({
      fiberId: mounted.fiberId,
      mountId: mounted.mountId,
      mountGeneration: 1,
      mountGenerationEvidence: 'exact',
      key: 'a',
      siblingIndex: 1,
      logicalIdentityEvidence: 'keyed',
    })
    expect(reordered.logicalPath).toBe(mounted.logicalPath)
  })

  it('labels unkeyed and duplicate-key identities as positional', () => {
    const parent = component('Rows')
    const first = component('Row', 'same')
    const second = component('Row', 'same')
    const unkeyed = component('Row')
    attach(parent, [first, second, unkeyed])

    expect(instanceForMountedFiber(first).logicalIdentityEvidence).toBe('positional')
    expect(instanceForMountedFiber(unkeyed)).toMatchObject({
      siblingIndex: 2,
      logicalIdentityEvidence: 'positional',
      mountGenerationEvidence: 'inferred',
    })
  })

  it('creates a tombstone and increments generation when the same key remounts', () => {
    beginInstanceObservation('observation:1')
    const parent = component('Rows')
    const first = component('Row', 'a')
    attach(parent, [first])
    const firstMount = noteInstanceRender(first, 'mount', 1, 10)

    // React can detach return/sibling links before the DevTools unmount callback.
    ;(first as { return: Fiber | null }).return = null
    const removed = noteInstanceRender(first, 'unmount', 2, 11)
    const replacement = component('Row', 'a')
    attach(parent, [replacement])
    const secondMount = noteInstanceRender(replacement, 'mount', 3, 12)

    expect(removed.mountId).toBe(firstMount.mountId)
    expect(removed.parent?.name).toBe('Rows')
    expect(removed.logicalPath).toBe(firstMount.logicalPath)
    expect(secondMount.mountId).not.toBe(firstMount.mountId)
    expect(secondMount.mountGeneration).toBe(2)
    expect(getInstanceTombstones()).toEqual([
      expect.objectContaining({
        componentName: 'Row',
        observationId: 'observation:1',
        profileCommitId: 2,
        documentCommitId: 11,
        instance: expect.objectContaining({ mountId: firstMount.mountId }),
      }),
    ])
  })

  it('tracks whether a mounted instance rendered in the active observation', () => {
    beginInstanceObservation('observation:1')
    const fiber = component('Idle')
    const idle = instanceForMountedFiber(fiber)
    expect(wasInstanceObserved(idle.fiberId)).toBe(false)

    noteInstanceRender(fiber, 'update', 1, 1)
    expect(wasInstanceObserved(idle.fiberId)).toBe(true)

    beginInstanceObservation('observation:2')
    expect(wasInstanceObserved(idle.fiberId)).toBe(false)
  })

  it('drops HMR-invalidated live identity and records a lifecycle coverage gap', () => {
    beginInstanceObservation('observation:1')
    const fiber = component('RefreshedRow')
    const before = noteInstanceRender(fiber, 'mount', 1, 1)

    discardExcludedInstanceUnmount(fiber)
    const after = instanceForMountedFiber(fiber)

    expect(after.mountId).not.toBe(before.mountId)
    expect(after.mountGeneration).toBe(2)
    expect(getInstanceIdentityCoverage().excludedLifecycleFibers).toBe(1)
    expect(getInstanceTombstones()).toEqual([])
  })

  it('includes host ancestry so positional rows in separate wrappers do not collide', () => {
    const root = component('Root')
    const left = host('div')
    const right = host('div')
    const leftRow = component('Row')
    const rightRow = component('Row')
    attach(root, [left, right])
    attach(left, [leftRow])
    attach(right, [rightRow])

    const leftIdentity = instanceForMountedFiber(leftRow)
    const rightIdentity = instanceForMountedFiber(rightRow)

    expect(leftIdentity.logicalPath).toContain('<div>[index=0]')
    expect(rightIdentity.logicalPath).toContain('<div>[index=1]')
    expect(leftIdentity.logicalPath).not.toBe(rightIdentity.logicalPath)
  })

  it('bounds tombstones and reports exactly what was dropped', () => {
    beginInstanceObservation('observation:1')
    const row = component('Row')
    for (let index = 0; index < 1_001; index += 1) {
      noteInstanceRender(row, 'unmount', index, index)
    }

    expect(getInstanceTombstones()).toHaveLength(1_000)
    expect(getInstanceIdentityCoverage().droppedTombstones).toBe(1)
  })

  it('bounds generation history and downgrades identities after eviction', () => {
    let last: ReturnType<typeof instanceForMountedFiber> | null = null
    for (let index = 0; index < 10_001; index += 1) {
      last = instanceForMountedFiber(component(`Row${index}`))
    }

    expect(getInstanceIdentityCoverage().generationHistoryEvictions).toBe(1)
    expect(last?.mountGenerationEvidence).toBe('unknown')
  })
})
