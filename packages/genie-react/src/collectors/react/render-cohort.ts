import { type Fiber, isCompositeFiber } from 'bippy'
import { findAllCommittedRootFibers, nameOf } from './fiber'
import {
  getInstanceIdentityCoverage,
  getInstanceTombstones,
  type InstanceDescriptor,
  instanceForReport,
  wasInstanceObserved,
} from './instance-identity'
import { getActiveObservation, type ObservationWindow } from './observation'

export type CohortStatus =
  | 'not-started'
  | 'absent'
  | 'mounted-idle'
  | 'updated'
  | 'unmounted'
  | 'mixed'
  | 'unknown'

export interface CohortInstance {
  componentName: string
  status: 'mounted-idle' | 'mounted-updated' | 'mounted-unknown' | 'unmounted'
  instance: InstanceDescriptor
  profileCommitId?: number
  documentCommitId?: number
}

export interface RenderCohort {
  observation: ObservationWindow | null
  query: { component: string; exact: boolean }
  status: CohortStatus
  matched: number
  mountedUpdated: number
  mountedIdle: number
  mountedUnknown: number
  unmounted: number
  returned: number
  omittedByLimit: number
  instances: CohortInstance[]
  coverage: {
    complete: boolean
    scannedFibers: number
    scanLimit: number
    scanTruncated: boolean
    rootAvailable: boolean
    rootCount: number
    scannedRootCount: number
    rootLimit: number
    rootScope: 'committed' | 'committed+fallback' | 'fallback' | 'missing'
    rootScopeComplete: boolean
    rootScopeTruncated: boolean
    inputAttributionComplete: boolean
    skippedCommitFibers: number
    droppedUnmountFibers: number
    analysisFailedFibers: number
    truncatedInputFibers: number
    propsNotEnumeratedFibers: number
    budgetExhaustedCommits: number
    budgetExhaustedSubsystems: { subsystem: string; commits: number }[]
    generationHistoryEvictions: number
  }
}

export interface RenderCoverageGaps {
  skippedCommitFibers: number
  droppedUnmountFibers: number
  analysisFailedFibers: number
  truncatedInputFibers: number
  propsNotEnumeratedFibers?: number
  budgetExhaustedCommits?: number
  budgetExhaustedSubsystems?: { subsystem: string; commits: number }[]
}

const COHORT_SCAN_LIMIT = 20_000

export function getRenderCohort(
  fallbackRoot: Fiber | null,
  query: { component: string; exact: boolean; limit: number },
  coverageGaps: RenderCoverageGaps,
): RenderCohort {
  const observation = getActiveObservation()
  const mountedCandidates: Array<{
    componentName: string
    instance: InstanceDescriptor
    observed: boolean
  }> = []
  const committedScope = findAllCommittedRootFibers()
  const fallbackInCommittedScope = fallbackRoot
    ? committedScope.roots.includes(fallbackRoot)
    : false
  const rootScope =
    committedScope.rootCount > 0
      ? fallbackRoot && !fallbackInCommittedScope
        ? 'committed+fallback'
        : 'committed'
      : fallbackRoot
        ? 'fallback'
        : 'missing'
  // Give the selected DOM root first claim on the shared budget when commit capture missed it.
  const rootCandidates = fallbackRoot
    ? [fallbackRoot, ...committedScope.roots.filter((root) => root !== fallbackRoot)]
    : committedScope.roots
  const rootScopeTruncated =
    committedScope.truncated || rootCandidates.length > committedScope.rootLimit
  const roots = rootCandidates.slice(0, committedScope.rootLimit)
  const rootFibers = new Set(roots)
  const scannedRoots = new Set<Fiber>()
  const visitedFibers = new Set<Fiber>()
  const mountedFiberIds = new Set<number>()
  // Reverse once so the oldest committed root remains first in the LIFO walk.
  const stack: Fiber[] = [...roots].reverse()
  let scannedFibers = 0

  while (stack.length > 0 && scannedFibers < COHORT_SCAN_LIMIT) {
    const fiber = stack.pop()
    if (!fiber || visitedFibers.has(fiber)) continue
    visitedFibers.add(fiber)
    if (rootFibers.has(fiber)) scannedRoots.add(fiber)
    scannedFibers += 1
    if (isCompositeFiber(fiber)) {
      const componentName = nameOf(fiber)
      if (matches(componentName, query.component, query.exact)) {
        const instance = instanceForReport(fiber)
        if (!mountedFiberIds.has(instance.fiberId)) {
          mountedFiberIds.add(instance.fiberId)
          mountedCandidates.push({
            componentName,
            instance,
            observed: wasInstanceObserved(instance.fiberId),
          })
        }
      }
    }
    if (fiber.sibling) stack.push(fiber.sibling)
    if (fiber.child) stack.push(fiber.child)
  }

  // Duplicate roots/fibers left on the stack do not represent missing data.
  const scanTruncated = stack.some((fiber) => !visitedFibers.has(fiber))
  const identityCoverage = getInstanceIdentityCoverage()
  const effectiveCoverageGaps = {
    ...coverageGaps,
    droppedUnmountFibers:
      coverageGaps.droppedUnmountFibers +
      identityCoverage.droppedTombstones +
      identityCoverage.excludedLifecycleFibers,
    generationHistoryEvictions: identityCoverage.generationHistoryEvictions,
    propsNotEnumeratedFibers: coverageGaps.propsNotEnumeratedFibers ?? 0,
    budgetExhaustedCommits: coverageGaps.budgetExhaustedCommits ?? 0,
    budgetExhaustedSubsystems: coverageGaps.budgetExhaustedSubsystems ?? [],
  }
  const rootCount = roots.length
  const scannedRootCount = scannedRoots.size
  const rootAvailable = rootCount > 0
  const rootScopeComplete = committedScope.rootCount > 0 && !rootScopeTruncated
  const complete =
    rootAvailable &&
    rootScopeComplete &&
    scannedRootCount === rootCount &&
    !scanTruncated &&
    effectiveCoverageGaps.skippedCommitFibers === 0 &&
    effectiveCoverageGaps.droppedUnmountFibers === 0 &&
    effectiveCoverageGaps.analysisFailedFibers === 0 &&
    effectiveCoverageGaps.budgetExhaustedCommits === 0 &&
    effectiveCoverageGaps.generationHistoryEvictions === 0
  const inputAttributionComplete =
    complete &&
    effectiveCoverageGaps.truncatedInputFibers === 0 &&
    effectiveCoverageGaps.propsNotEnumeratedFibers === 0
  const mounted: CohortInstance[] = mountedCandidates.map((entry) => ({
    componentName: entry.componentName,
    status: entry.observed ? 'mounted-updated' : complete ? 'mounted-idle' : 'mounted-unknown',
    instance: entry.instance,
  }))
  const unmounted: CohortInstance[] = observation
    ? getInstanceTombstones()
        .filter((entry) => entry.observationId === observation.id)
        .filter((entry) => matches(entry.componentName, query.component, query.exact))
        .map((entry) => ({
          componentName: entry.componentName,
          status: 'unmounted' as const,
          instance: entry.instance,
          profileCommitId: entry.profileCommitId,
          documentCommitId: entry.documentCommitId,
        }))
    : []

  const all = [...mounted, ...unmounted]
  const mountedUpdated = mounted.filter((entry) => entry.status === 'mounted-updated').length
  const mountedIdle = mounted.filter((entry) => entry.status === 'mounted-idle').length
  const mountedUnknown = mounted.filter((entry) => entry.status === 'mounted-unknown').length
  const matched = all.length
  const instances = all.slice(0, query.limit)

  return {
    observation,
    query: { component: query.component, exact: query.exact },
    status: cohortStatus({
      observation,
      mountedUpdated,
      mountedIdle,
      mountedUnknown,
      unmounted: unmounted.length,
      complete,
    }),
    matched,
    mountedUpdated,
    mountedIdle,
    mountedUnknown,
    unmounted: unmounted.length,
    returned: instances.length,
    omittedByLimit: Math.max(0, matched - instances.length),
    instances,
    coverage: {
      complete,
      scannedFibers,
      scanLimit: COHORT_SCAN_LIMIT,
      scanTruncated,
      rootAvailable,
      rootCount,
      scannedRootCount,
      rootLimit: committedScope.rootLimit,
      rootScope,
      rootScopeComplete,
      rootScopeTruncated,
      inputAttributionComplete,
      ...effectiveCoverageGaps,
    },
  }
}

function matches(name: string, query: string, exact: boolean): boolean {
  return exact ? name === query : name.toLowerCase().includes(query.toLowerCase())
}

function cohortStatus(input: {
  observation: ObservationWindow | null
  mountedUpdated: number
  mountedIdle: number
  mountedUnknown: number
  unmounted: number
  complete: boolean
}): CohortStatus {
  if (!input.observation) return 'not-started'
  if (!input.complete) return 'unknown'
  const populated = [
    input.mountedUpdated,
    input.mountedIdle,
    input.mountedUnknown,
    input.unmounted,
  ].filter((count) => count > 0).length
  if (populated > 1) return 'mixed'
  if (input.mountedUpdated > 0) return 'updated'
  if (input.mountedIdle > 0) return 'mounted-idle'
  if (input.mountedUnknown > 0) return 'unknown'
  if (input.unmounted > 0) return 'unmounted'
  return 'absent'
}
