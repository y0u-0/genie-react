import { type Fiber, type FiberRoot, HostComponentTag } from 'bippy'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forgetCommittedRoots, noteCommittedRoot } from './fiber'
import {
  beginInstanceObservation,
  clearInstanceIdentityForTests,
  noteInstanceRender,
} from './instance-identity'
import { beginObservation, resetObservationStateForTests } from './observation'
import { getRenderCohort } from './render-cohort'

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

function attach(parent: Fiber, children: Fiber[]): void {
  ;(parent as { child: Fiber | null }).child = children[0] ?? null
  children.forEach((child, index) => {
    ;(child as { return: Fiber }).return = parent
    ;(child as { sibling: Fiber | null }).sibling = children[index + 1] ?? null
  })
}

function commit(root: Fiber): FiberRoot {
  const owner = { current: root } as FiberRoot
  noteCommittedRoot(owner)
  return owner
}

function host(): Fiber {
  return asFiber({
    tag: HostComponentTag,
    type: 'div',
    key: null,
    child: null,
    sibling: null,
    return: null,
    alternate: null,
    memoizedProps: {},
    memoizedState: null,
  })
}

function hostChain(length: number): Fiber {
  const root = component('Root')
  let parent = root
  for (let index = 0; index < length; index += 1) {
    const child = host()
    attach(parent, [child])
    parent = child
  }
  return root
}

beforeEach(() => {
  clearInstanceIdentityForTests()
  resetObservationStateForTests()
  forgetCommittedRoots()
})

afterEach(() => {
  forgetCommittedRoots()
})

function startObservation(): void {
  beginInstanceObservation(beginObservation().id)
}

describe('render lifecycle cohorts', () => {
  it('distinguishes mounted-idle, updated, unmounted, and absent', () => {
    const root = component('Root')
    const idle = component('Row', 'idle')
    const updated = component('Row', 'updated')
    attach(root, [idle, updated])
    commit(root)
    startObservation()
    noteInstanceRender(updated, 'update', 1, 1)

    expect(
      getRenderCohort(
        root,
        { component: 'Row', exact: true, limit: 10 },
        {
          skippedCommitFibers: 0,
          droppedUnmountFibers: 0,
          analysisFailedFibers: 0,
          truncatedInputFibers: 0,
        },
      ),
    ).toMatchObject({
      status: 'mixed',
      matched: 2,
      mountedUpdated: 1,
      mountedIdle: 1,
      mountedUnknown: 0,
      unmounted: 0,
    })

    noteInstanceRender(idle, 'unmount', 2, 2)
    attach(root, [updated])
    expect(
      getRenderCohort(
        root,
        { component: 'Row', exact: true, limit: 10 },
        {
          skippedCommitFibers: 0,
          droppedUnmountFibers: 0,
          analysisFailedFibers: 0,
          truncatedInputFibers: 0,
        },
      ),
    ).toMatchObject({
      status: 'mixed',
      mountedUpdated: 1,
      mountedIdle: 0,
      mountedUnknown: 0,
      unmounted: 1,
    })

    expect(
      getRenderCohort(
        root,
        { component: 'Missing', exact: true, limit: 10 },
        {
          skippedCommitFibers: 0,
          droppedUnmountFibers: 0,
          analysisFailedFibers: 0,
          truncatedInputFibers: 0,
        },
      ),
    ).toMatchObject({ status: 'absent', matched: 0, coverage: { complete: true } })
  })

  it('keeps lifecycle coverage complete when only prop attribution is opaque', () => {
    const root = component('Root')
    attach(root, [component('Row')])
    commit(root)
    startObservation()

    const report = getRenderCohort(
      root,
      { component: 'Row', exact: true, limit: 10 },
      {
        skippedCommitFibers: 0,
        droppedUnmountFibers: 0,
        analysisFailedFibers: 0,
        truncatedInputFibers: 0,
        propsNotEnumeratedFibers: 1,
      },
    )

    expect(report).toMatchObject({
      status: 'mounted-idle',
      mountedIdle: 1,
      mountedUnknown: 0,
      coverage: { complete: true, inputAttributionComplete: false },
    })
  })

  it('discloses result and commit-analysis omissions', () => {
    const root = component('Root')
    const rows = [component('Row', 'a'), component('Row', 'b'), component('Row', 'c')]
    attach(root, rows)
    commit(root)
    startObservation()

    expect(
      getRenderCohort(
        root,
        { component: 'Row', exact: true, limit: 1 },
        {
          skippedCommitFibers: 4,
          droppedUnmountFibers: 2,
          analysisFailedFibers: 0,
          truncatedInputFibers: 0,
        },
      ),
    ).toMatchObject({
      status: 'unknown',
      matched: 3,
      mountedIdle: 0,
      mountedUnknown: 3,
      returned: 1,
      omittedByLimit: 2,
      coverage: { complete: false, skippedCommitFibers: 4, droppedUnmountFibers: 2 },
    })
    expect(
      getRenderCohort(
        root,
        { component: 'Missing', exact: true, limit: 1 },
        {
          skippedCommitFibers: 4,
          droppedUnmountFibers: 2,
          analysisFailedFibers: 0,
          truncatedInputFibers: 0,
        },
      ).status,
    ).toBe('unknown')
  })

  it('reports that measurement has not started instead of inventing an empty window', () => {
    const root = component('Root')
    attach(root, [component('Row')])
    commit(root)
    expect(
      getRenderCohort(
        root,
        { component: 'Row', exact: true, limit: 10 },
        {
          skippedCommitFibers: 0,
          droppedUnmountFibers: 0,
          analysisFailedFibers: 0,
          truncatedInputFibers: 0,
        },
      ).status,
    ).toBe('not-started')
  })

  it('does not claim absence when the React root is unavailable', () => {
    startObservation()

    expect(
      getRenderCohort(
        null,
        { component: 'Missing', exact: true, limit: 10 },
        {
          skippedCommitFibers: 0,
          droppedUnmountFibers: 0,
          analysisFailedFibers: 0,
          truncatedInputFibers: 0,
        },
      ),
    ).toMatchObject({
      status: 'unknown',
      coverage: { complete: false, rootAvailable: false },
    })
  })

  it('scans every committed root and reports the document root scope', () => {
    const firstRoot = component('FirstRoot')
    const idle = component('Row', 'first')
    attach(firstRoot, [idle])
    const secondRoot = component('SecondRoot')
    const updated = component('Row', 'second')
    attach(secondRoot, [updated])
    commit(firstRoot)
    commit(secondRoot)
    startObservation()
    noteInstanceRender(updated, 'update', 1, 1)

    expect(
      getRenderCohort(
        firstRoot,
        { component: 'Row', exact: true, limit: 10 },
        {
          skippedCommitFibers: 0,
          droppedUnmountFibers: 0,
          analysisFailedFibers: 0,
          truncatedInputFibers: 0,
        },
      ),
    ).toMatchObject({
      status: 'mixed',
      matched: 2,
      mountedUpdated: 1,
      mountedIdle: 1,
      coverage: {
        complete: true,
        rootAvailable: true,
        rootCount: 2,
        scannedRootCount: 2,
        rootLimit: 100,
        rootScope: 'committed',
        rootScopeComplete: true,
        rootScopeTruncated: false,
      },
    })
  })

  it('includes a selected app root that the commit registry has not seen', () => {
    const overlayRoot = component('OverlayRoot')
    attach(overlayRoot, [component('DevOverlay')])
    const appRoot = component('AppRoot')
    attach(appRoot, [component('Row')])
    commit(overlayRoot)
    startObservation()

    expect(
      getRenderCohort(
        appRoot,
        { component: 'Row', exact: true, limit: 10 },
        {
          skippedCommitFibers: 0,
          droppedUnmountFibers: 0,
          analysisFailedFibers: 0,
          truncatedInputFibers: 0,
        },
      ),
    ).toMatchObject({
      status: 'mounted-idle',
      matched: 1,
      coverage: {
        complete: true,
        rootCount: 2,
        scannedRootCount: 2,
        rootScope: 'committed+fallback',
        rootScopeComplete: true,
        rootScopeTruncated: false,
      },
    })
  })

  it('deduplicates the same live root registered by more than one owner', () => {
    const root = component('Root')
    attach(root, [component('Row')])
    commit(root)
    commit(root)
    startObservation()

    expect(
      getRenderCohort(
        root,
        { component: 'Row', exact: true, limit: 10 },
        {
          skippedCommitFibers: 0,
          droppedUnmountFibers: 0,
          analysisFailedFibers: 0,
          truncatedInputFibers: 0,
        },
      ),
    ).toMatchObject({
      status: 'mounted-idle',
      matched: 1,
      coverage: {
        complete: true,
        scannedFibers: 2,
        rootCount: 1,
        scannedRootCount: 1,
      },
    })
  })

  it('marks a DOM fallback root as an incomplete root scope', () => {
    const root = component('Root')
    attach(root, [component('Row')])
    startObservation()

    expect(
      getRenderCohort(
        root,
        { component: 'Row', exact: true, limit: 10 },
        {
          skippedCommitFibers: 0,
          droppedUnmountFibers: 0,
          analysisFailedFibers: 0,
          truncatedInputFibers: 0,
        },
      ),
    ).toMatchObject({
      status: 'unknown',
      matched: 1,
      mountedUnknown: 1,
      coverage: {
        complete: false,
        rootAvailable: true,
        rootCount: 1,
        scannedRootCount: 1,
        rootScope: 'fallback',
        rootScopeComplete: false,
        rootScopeTruncated: false,
      },
    })
  })

  it('does not claim completeness when the committed-root scope is capped', () => {
    let firstRoot: Fiber | null = null
    for (let index = 0; index < 101; index += 1) {
      const root = component(`Root${index}`)
      attach(root, [component('Row')])
      commit(root)
      firstRoot ??= root
    }
    startObservation()

    const report = getRenderCohort(
      firstRoot,
      { component: 'Missing', exact: true, limit: 10 },
      {
        skippedCommitFibers: 0,
        droppedUnmountFibers: 0,
        analysisFailedFibers: 0,
        truncatedInputFibers: 0,
      },
    )

    expect(report).toMatchObject({
      status: 'unknown',
      matched: 0,
      coverage: {
        complete: false,
        rootCount: 100,
        scannedRootCount: 100,
        rootLimit: 100,
        rootScope: 'committed',
        rootScopeComplete: false,
        rootScopeTruncated: true,
        scanTruncated: false,
      },
    })
  })

  it('shares one fiber scan budget across all roots', () => {
    const firstRoot = hostChain(12_000)
    const secondRoot = hostChain(12_000)
    commit(firstRoot)
    commit(secondRoot)
    startObservation()

    const report = getRenderCohort(
      firstRoot,
      { component: 'Missing', exact: true, limit: 10 },
      {
        skippedCommitFibers: 0,
        droppedUnmountFibers: 0,
        analysisFailedFibers: 0,
        truncatedInputFibers: 0,
      },
    )

    expect(report).toMatchObject({
      status: 'unknown',
      matched: 0,
      coverage: {
        complete: false,
        scannedFibers: 20_000,
        scanLimit: 20_000,
        scanTruncated: true,
        rootCount: 2,
        scannedRootCount: 2,
      },
    })
  })
})
