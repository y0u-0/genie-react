import {
  didFiberCommit,
  type Fiber,
  type FiberRoot,
  getFiberId,
  getTimings,
  HostTextTag,
  hasMemoCache,
  instrument,
  isCompositeFiber,
  isHostFiber,
  type RenderPhase,
  SuspenseComponentTag,
  traverseRenderedFibers,
  type Unsubscribe,
} from 'bippy'
import {
  registerQuerySubscriber,
  setExternalStoreObservation,
} from '../causal/external-store-registry'
import { type CommitWorkBudget, commitWorkExhaustions, consumeCommitWork } from './commit-budget'
import { recordResultingEffectCommit } from './effect-events'
import {
  clearEffects,
  type EffectScheduleObservation,
  type PreparedEffectObservation,
  prepareEffect,
  removeEffectRecord,
  scheduledEffectCount,
} from './effect-tracker'
import { clearErrorState, recordErrorState } from './error-tracker'
import { nameOf, noteCommit, noteCommittedRoot } from './fiber'
import {
  beginInstanceObservation,
  discardExcludedInstanceUnmount,
  getInstanceIdentityCoverage,
  invalidateLiveInstancesForRefresh,
  noteInstanceRender,
  prepareInstanceRender,
} from './instance-identity'
import {
  beginObservation,
  getActiveObservation,
  getDocumentCommitId,
  nextCausalEventId,
  noteAnalysisInvalidation,
  noteDocumentCommit,
  type ObservationWindow,
} from './observation'
import { isRefreshCommit, noteExcludedRefreshCommit } from './refresh-tracker'
import {
  createRenderEvidenceBudget,
  inputCoverage,
  type RenderInputCoverage,
} from './render-budget'
import {
  diffContextChanges,
  diffExternalStoreChanges,
  type PendingQuerySubscriberRegistration,
  type RenderCause,
  type RenderCauseEvent,
  type RenderNecessity,
} from './render-causes'
import { type CommitAnalysisBudget, createCommitAnalysisBudget } from './render-commit-budget'
import { childrenChanged, diffProps, diffStateChanges, type RenderChange } from './render-inputs'
import type {
  RenderRecord,
  RenderReport,
  RenderSummary,
  ReportAttribution,
  RetainedRenderCauseEvent,
} from './render-model'
import { draftRenderRecord } from './render-model'
import { assessRender, type CurrentCommitEvidence, type RenderAssessment } from './render-outcomes'
import {
  buildCurrentAggregates,
  buildRenderCauseEventsReport,
  buildRenderSummary,
  buildRenders,
  buildRendersLeaderboards,
  buildRendersMeasurementReport,
  buildRendersReport,
  type RenderCauseQuery,
  type RenderQuery,
} from './render-reports'
import {
  buildRenderTrackingCoverage,
  diffRenderSnapshot,
  type RenderTrackingCoverage,
  storeRenderSnapshot,
} from './render-snapshots'
import { captureReportEpoch, reportAttribution, reportStateMatches } from './report-attribution'
import { isSafeRenderer, supportedCommitHandler } from './safe-instrumentation'
import { clearSourceCache } from './source'

export type {
  RenderCause,
  RenderCauseCounts,
  RenderCauseKind,
  RenderNecessity,
} from './render-causes'
export { diffContextChanges, diffExternalStoreChanges } from './render-causes'
export type {
  ClassStateRenderChange,
  HookStateRenderChange,
  PropRenderChange,
  RenderChange,
  StateRenderChange,
} from './render-inputs'
export {
  childrenChanged,
  contextChanged,
  diffProps,
  diffStateChanges,
  stateChanged,
} from './render-inputs'
export type { RenderCauseQuery, RenderQuery } from './render-reports'
export { clearSnapshots, snapshotLabels } from './render-snapshots'
export type {
  CommitAnalysisBudget,
  RenderRecord,
  RenderReport,
  RenderSummary,
  ReportAttribution,
  RetainedRenderCauseEvent,
}
export { createCommitAnalysisBudget }

const records = new Map<number, RenderRecord>()
const recentCauseEvents: RetainedRenderCauseEvent[] = []
let commits = 0
let installed = false
let instrumentation: Unsubscribe | null = null
// Stop is intentionally a soft flag: the commit handler stays wired so the client's liveness heartbeat continues while profiling is paused.
let paused = false
let skippedCommitFibers = 0
let droppedPendingUnmountFibers = 0
let analysisFailedFibers = 0
let truncatedInputFibers = 0
let propsNotEnumeratedFibers = 0
let budgetExhaustedCommits = 0
const budgetExhaustedSubsystems = new Map<string, number>()
let droppedRenderEvents = 0
let clears = 0
let targetedFibersProcessed = 0
let targetedFibersSkipped = 0
let droppedTargetUnmountFibers = 0
let adaptiveBudgetScale = 1

export interface RenderObservationOptions {
  components?: string[]
  roots?: number[]
  budget?: {
    fiberLimit?: number
    operationLimit?: number
    timeLimitMs?: number
    targetOperationReserve?: number
    targetTimeReserveMs?: number
    adaptive?: boolean
  }
  lifecycle?: { bufferLimit?: number; targetReserve?: number }
}

interface RenderObservationConfiguration {
  components: string[]
  roots: number[]
  budget: {
    fiberLimit: number
    operationLimit: number
    timeLimitMs: number
    targetOperationReserve: number
    targetTimeReserveMs: number
    adaptive: boolean
  }
  lifecycle: { bufferLimit: number; targetReserve: number }
}

const DEFAULT_OBSERVATION_CONFIGURATION: RenderObservationConfiguration = {
  components: [],
  roots: [],
  budget: {
    fiberLimit: 250,
    operationLimit: 20_000,
    timeLimitMs: 8,
    targetOperationReserve: 4_000,
    targetTimeReserveMs: 4,
    adaptive: true,
  },
  lifecycle: { bufferLimit: 1_000, targetReserve: 100 },
}

let observationConfiguration = structuredClone(DEFAULT_OBSERVATION_CONFIGURATION)
let observationRootIds = new Set<number>()

const DID_CAPTURE = 0b1000_0000
const RECENT_CAUSE_EVENT_LIMIT = 1_000
const pendingUnmounts: { rendererId: number; fiber: Fiber; targeted: boolean }[] = []
const pendingHostUnmountRenderers = new Set<number>()
let uncertainTraversalRoots = new WeakSet<FiberRoot>()

let commitListener: (() => void) | null = null

/** Register a per-commit callback (the client's liveness pump). Called on every commit — even while paused — because a committing thread is alive regardless of whether we record it. */
export function setCommitListener(listener: (() => void) | null): void {
  commitListener = listener
}

/** Installs commit-time instrumentation (idempotent) and (re)enables tracking; the DevTools hook must already be present before React loads, or no commits are delivered. */
export function startRenderTracking(): boolean {
  paused = false
  if (installed) return true
  try {
    instrumentation = instrument({
      name: 'genie-react',
      onCommitFiberUnmount: (rendererId: number, fiber: Fiber) => {
        if (!isSafeRenderer(rendererId)) return
        if (isHostFiber(fiber) || fiber.tag === HostTextTag) {
          pendingHostUnmountRenderers.add(rendererId)
        }
        queuePendingUnmount(rendererId, fiber)
      },
      onCommitFiberRoot: supportedCommitHandler((rendererId: number, root: FiberRoot) => {
        commitListener?.()
        noteCommit()
        noteCommittedRoot(root)
        if (!isSafeRenderer(rendererId)) return
        const hostUnmountObserved = pendingHostUnmountRenderers.delete(rendererId)
        if (isRefreshCommit()) {
          advanceExcludedCommitBaseline(root)
          noteAnalysisInvalidation()
          discardPendingUnmounts(rendererId)
          invalidateLiveInstancesForRefresh()
          noteExcludedRefreshCommit()
          return
        }
        noteDocumentCommit()
        recordResultingEffectCommit(getDocumentCommitId())
        if (paused) {
          discardPendingUnmounts(rendererId)
          advanceExcludedCommitBaseline(root)
          return
        }
        if (uncertainTraversalRoots.has(root)) {
          discardPendingUnmounts(rendererId)
          advanceExcludedCommitBaseline(root)
          return
        }
        commits += 1
        const effective = effectiveObservationBudget()
        const budget = createCommitAnalysisBudget(
          effective.fiberLimit,
          {
            operationLimit: effective.operationLimit,
            timeLimitMs: effective.timeLimitMs,
          },
          {
            operationLimit: effective.targetOperationReserve,
            timeLimitMs: effective.targetTimeReserveMs,
          },
        )
        recordPendingUnmounts(rendererId, budget)
        budget.currentCommitEvidence.hostMutationCaptureComplete = !hostUnmountObserved
        const candidates: { fiber: Fiber; phase: RenderPhase }[] = []
        const targetedCandidates: { fiber: Fiber; phase: RenderPhase }[] = []
        traverseRenderedFibers(root, (fiber, phase) => {
          const targeted = isObservationTarget(fiber)
          const traversalWork = targeted ? budget.targetWork : budget.work
          if (
            !consumeCommitWork(traversalWork, targeted ? 'target-traversal' : 'commit-traversal')
          ) {
            budget.currentCommitEvidence.hostMutationCaptureComplete = false
            if (shouldAnalyzeCommitFiber(fiber)) {
              if (targeted) {
                budget.targetSkipped += 1
                targetedFibersSkipped += 1
              } else {
                budget.skipped += 1
              }
              skippedCommitFibers += 1
            }
            return
          }
          budget.currentCommitEvidence.renderedFibers.add(fiber)
          if (isHostFiber(fiber)) {
            try {
              // The traversal proves this host rendered now; its mutation flag is not used alone.
              if (didFiberCommit(fiber)) {
                budget.currentCommitEvidence.hostMutationFibers.add(fiber)
              }
            } catch {
              budget.currentCommitEvidence.hostMutationCaptureComplete = false
            }
          }
          if (!shouldAnalyzeCommitFiber(fiber)) return
          if (targeted) {
            targetedCandidates.push({ fiber, phase })
            return
          }
          if (candidates.length >= budget.limit) {
            budget.skipped += 1
            skippedCommitFibers += 1
            return
          }
          candidates.push({ fiber, phase })
        })
        for (const candidate of targetedCandidates) {
          recordCommitFiber(candidate.fiber, candidate.phase, budget, true)
        }
        for (const candidate of candidates) {
          recordCommitFiber(candidate.fiber, candidate.phase, budget)
        }
        finalizeCommitAnalysisBudget(budget)
      }),
    })
    installed = true
  } catch {
    installed = false
  }
  return installed
}

/** Advance Bippy's per-root previous-Fiber baseline without retaining excluded commit evidence. */
function advanceExcludedCommitBaseline(root: FiberRoot): void {
  try {
    traverseRenderedFibers(root, () => {})
    uncertainTraversalRoots.delete(root)
  } catch {
    uncertainTraversalRoots.add(root)
    analysisFailedFibers += 1
  }
}

/** Module/HMR teardown only. Profiling stop must keep the lightweight commit heartbeat installed. */
export function disposeRenderTracking(): void {
  noteAnalysisInvalidation()
  invalidateLiveInstancesForRefresh()
  instrumentation?.()
  instrumentation = null
  installed = false
  paused = false
  pendingUnmounts.length = 0
  pendingHostUnmountRenderers.clear()
  uncertainTraversalRoots = new WeakSet()
  droppedPendingUnmountFibers = 0
}

/** Pause commit recording without uninstalling instrumentation; isTracking() reports false until startRenderTracking() resumes. */
export function stopRenderTracking(): void {
  paused = true
}

export const isTracking = (): boolean => installed && !paused
export const getCommitCount = (): number => commits
export const getSkippedCommitFiberCount = (): number => skippedCommitFibers
export const getDroppedPendingUnmountFiberCount = (): number => droppedPendingUnmountFibers
export const getAnalysisFailedFiberCount = (): number => analysisFailedFibers
export const getTruncatedInputFiberCount = (): number => truncatedInputFibers
export const getPropsNotEnumeratedFiberCount = (): number => propsNotEnumeratedFibers
export const getBudgetExhaustedCommitCount = (): number => budgetExhaustedCommits
export const getBudgetExhaustedSubsystems = (): { subsystem: string; commits: number }[] =>
  [...budgetExhaustedSubsystems]
    .map(([subsystem, count]) => ({ subsystem, commits: count }))
    .sort((left, right) => left.subsystem.localeCompare(right.subsystem))
export const getDroppedRenderEventCount = (): number => droppedRenderEvents

export function getRenderTrackingCoverage(
  scope: 'causal' | 'measurement' = 'causal',
): RenderTrackingCoverage {
  const coverage = buildRenderTrackingCoverage(
    {
      skippedCommitFibers,
      droppedUnmountFibers: getDroppedUnmountEvidenceCount(),
      analysisFailedFibers,
      truncatedInputFibers,
      propsNotEnumeratedFibers,
      budgetExhaustedCommits,
      budgetExhaustedSubsystems: getBudgetExhaustedSubsystems(),
    },
    scope,
  )
  return {
    ...coverage,
    targeted: {
      components: [...observationConfiguration.components],
      roots: [...observationConfiguration.roots],
      processedFibers: targetedFibersProcessed,
      skippedFibers: targetedFibersSkipped,
      complete: targetedFibersSkipped === 0 && droppedTargetUnmountFibers === 0,
    },
    observationBudget: getRenderObservationConfig(),
  }
}

function getDroppedUnmountEvidenceCount(): number {
  const identityCoverage = getInstanceIdentityCoverage()
  return (
    droppedPendingUnmountFibers +
    identityCoverage.droppedTombstones +
    identityCoverage.excludedLifecycleFibers
  )
}

export function clearRenders(options: RenderObservationOptions = {}): ObservationWindow {
  configureRenderObservation(options)
  records.clear()
  recentCauseEvents.length = 0
  commits = 0
  skippedCommitFibers = 0
  droppedPendingUnmountFibers = 0
  analysisFailedFibers = 0
  truncatedInputFibers = 0
  propsNotEnumeratedFibers = 0
  budgetExhaustedCommits = 0
  budgetExhaustedSubsystems.clear()
  droppedRenderEvents = 0
  targetedFibersProcessed = 0
  targetedFibersSkipped = 0
  droppedTargetUnmountFibers = 0
  adaptiveBudgetScale = 1
  for (const pending of pendingUnmounts) discardExcludedInstanceUnmount(pending.fiber)
  pendingUnmounts.length = 0
  clears++
  clearEffects()
  clearErrorState()
  clearSourceCache()
  const observation = beginObservation()
  setExternalStoreObservation(observation)
  beginInstanceObservation(observation.id)
  return observation
}

export function getRenderObservationConfig(): NonNullable<
  RenderTrackingCoverage['observationBudget']
> {
  const effective = effectiveObservationBudget()
  return {
    adaptive: observationConfiguration.budget.adaptive,
    adaptiveScale: adaptiveBudgetScale,
    fiberLimit: effective.fiberLimit,
    operationLimit: effective.operationLimit,
    timeLimitMs: effective.timeLimitMs,
    targetOperationReserve: effective.targetOperationReserve,
    targetTimeReserveMs: effective.targetTimeReserveMs,
    lifecycleBufferLimit: observationConfiguration.lifecycle.bufferLimit,
    lifecycleTargetReserve: observationConfiguration.lifecycle.targetReserve,
  }
}

function configureRenderObservation(options: RenderObservationOptions): void {
  observationConfiguration = {
    components: [...new Set(options.components ?? [])].map((name) => name.toLowerCase()),
    roots: [...new Set(options.roots ?? [])],
    budget: {
      fiberLimit: options.budget?.fiberLimit ?? DEFAULT_OBSERVATION_CONFIGURATION.budget.fiberLimit,
      operationLimit:
        options.budget?.operationLimit ?? DEFAULT_OBSERVATION_CONFIGURATION.budget.operationLimit,
      timeLimitMs:
        options.budget?.timeLimitMs ?? DEFAULT_OBSERVATION_CONFIGURATION.budget.timeLimitMs,
      targetOperationReserve:
        options.budget?.targetOperationReserve ??
        DEFAULT_OBSERVATION_CONFIGURATION.budget.targetOperationReserve,
      targetTimeReserveMs:
        options.budget?.targetTimeReserveMs ??
        DEFAULT_OBSERVATION_CONFIGURATION.budget.targetTimeReserveMs,
      adaptive: options.budget?.adaptive ?? DEFAULT_OBSERVATION_CONFIGURATION.budget.adaptive,
    },
    lifecycle: {
      bufferLimit:
        options.lifecycle?.bufferLimit ?? DEFAULT_OBSERVATION_CONFIGURATION.lifecycle.bufferLimit,
      targetReserve:
        options.lifecycle?.targetReserve ??
        DEFAULT_OBSERVATION_CONFIGURATION.lifecycle.targetReserve,
    },
  }
  observationRootIds = new Set(observationConfiguration.roots)
}

function effectiveObservationBudget(): RenderObservationConfiguration['budget'] {
  const scale = observationConfiguration.budget.adaptive ? adaptiveBudgetScale : 1
  return {
    ...observationConfiguration.budget,
    fiberLimit: Math.min(5_000, observationConfiguration.budget.fiberLimit * scale),
    operationLimit: Math.min(200_000, observationConfiguration.budget.operationLimit * scale),
    timeLimitMs: Math.min(50, observationConfiguration.budget.timeLimitMs * scale),
  }
}

function isObservationTarget(fiber: Fiber): boolean {
  if (
    observationConfiguration.components.length === 0 &&
    observationConfiguration.roots.length === 0
  ) {
    return false
  }
  if (
    observationConfiguration.components.length > 0 &&
    observationConfiguration.components.some((needle) =>
      nameOf(fiber).toLowerCase().includes(needle),
    )
  ) {
    return true
  }
  if (observationConfiguration.roots.length === 0) return false
  let current: Fiber | null = fiber
  for (let depth = 0; current && depth < 100; depth += 1) {
    try {
      if (observationRootIds.has(getFiberId(current))) return true
    } catch {
      return false
    }
    current = current.return
  }
  return false
}

export async function getRenders(query: RenderQuery): Promise<RenderReport[]> {
  return buildRenders(records, query)
}

export async function getRendersReport(
  query: RenderQuery,
): Promise<{ components: RenderReport[]; libraryHidden: number; omittedByLimit: number }> {
  return buildRendersReport(records, query)
}

export async function getRendersMeasurement(query: RenderQuery): Promise<{
  tracking: boolean
  commits: number
  documentCommitId: number
  observation: ObservationWindow | null
  attribution: ReportAttribution
  summary: RenderSummary
  components: RenderReport[]
  libraryHidden: number
  omittedByLimit: number
  skippedCommitFibers: number
  droppedUnmountFibers: number
  analysisFailedFibers: number
  truncatedInputFibers: number
  propsNotEnumeratedFibers: number
  budgetExhaustedCommits: number
  budgetExhaustedSubsystems: { subsystem: string; commits: number }[]
}> {
  const recordsAtStart = snapshotRenderRecords()
  const commitsAtStart = commits
  const epoch = captureReportEpoch()
  const observation = getActiveObservation()
  const tracking = isTracking()
  const skippedAtStart = skippedCommitFibers
  const droppedUnmountsAtStart = getDroppedUnmountEvidenceCount()
  const failedAtStart = analysisFailedFibers
  const truncatedAtStart = truncatedInputFibers
  const propsNotEnumeratedAtStart = propsNotEnumeratedFibers
  const budgetCommitsAtStart = budgetExhaustedCommits
  const budgetSubsystemsAtStart = getBudgetExhaustedSubsystems()
  const report = await buildRendersMeasurementReport(recordsAtStart, commitsAtStart, query, {
    isCurrent: () => reportStateMatches(epoch),
  })
  return {
    tracking,
    commits: commitsAtStart,
    documentCommitId: epoch.documentCommitId,
    observation,
    attribution: reportAttribution(epoch),
    ...report,
    skippedCommitFibers: skippedAtStart,
    droppedUnmountFibers: droppedUnmountsAtStart,
    analysisFailedFibers: failedAtStart,
    truncatedInputFibers: truncatedAtStart,
    propsNotEnumeratedFibers: propsNotEnumeratedAtStart,
    budgetExhaustedCommits: budgetCommitsAtStart,
    budgetExhaustedSubsystems: budgetSubsystemsAtStart,
  }
}

function snapshotRenderRecords(): Map<number, RenderRecord> {
  return new Map(
    [...records].map(([id, record]) => [
      id,
      {
        ...record,
        instance: structuredClone(record.instance),
        changes: structuredClone(record.changes),
        causes: structuredClone(record.causes),
        causeCounts: { ...record.causeCounts },
        assessment: structuredClone(record.assessment),
        inputCoverage: { ...record.inputCoverage },
      },
    ]),
  )
}

export async function getRenderCauseEventsReport(query: RenderCauseQuery): Promise<{
  events: RenderCauseEvent[]
  libraryHidden: number
  omittedByLimit: number
}> {
  return buildRenderCauseEventsReport(records, recentCauseEvents, query)
}

export async function getRenderCauseMeasurement(query: RenderCauseQuery): Promise<{
  tracking: boolean
  commits: number
  documentCommitId: number
  observation: ObservationWindow | null
  attribution: ReportAttribution
  events: RenderCauseEvent[]
  libraryHidden: number
  omittedByLimit: number
  skippedCommitFibers: number
  droppedUnmountFibers: number
  analysisFailedFibers: number
  truncatedInputFibers: number
  propsNotEnumeratedFibers: number
  budgetExhaustedCommits: number
  budgetExhaustedSubsystems: { subsystem: string; commits: number }[]
  renderEventRetention: {
    evictedEvents: number
    earliestDocumentCommitId: number | null
    latestDocumentCommitId: number | null
  }
}> {
  const recordsAtStart = snapshotRenderRecords()
  const eventsAtStart = structuredClone(recentCauseEvents)
  const commitsAtStart = commits
  const epoch = captureReportEpoch()
  const observation = getActiveObservation()
  const tracking = isTracking()
  const skippedAtStart = skippedCommitFibers
  const droppedUnmountsAtStart = getDroppedUnmountEvidenceCount()
  const failedAtStart = analysisFailedFibers
  const truncatedAtStart = truncatedInputFibers
  const propsNotEnumeratedAtStart = propsNotEnumeratedFibers
  const budgetCommitsAtStart = budgetExhaustedCommits
  const budgetSubsystemsAtStart = getBudgetExhaustedSubsystems()
  const evictedAtStart = droppedRenderEvents
  const report = await buildRenderCauseEventsReport(recordsAtStart, eventsAtStart, query, {
    isCurrent: () => reportStateMatches(epoch),
  })
  return {
    tracking,
    commits: commitsAtStart,
    documentCommitId: epoch.documentCommitId,
    observation,
    attribution: reportAttribution(epoch),
    ...report,
    skippedCommitFibers: skippedAtStart,
    droppedUnmountFibers: droppedUnmountsAtStart,
    analysisFailedFibers: failedAtStart,
    truncatedInputFibers: truncatedAtStart,
    propsNotEnumeratedFibers: propsNotEnumeratedAtStart,
    budgetExhaustedCommits: budgetCommitsAtStart,
    budgetExhaustedSubsystems: budgetSubsystemsAtStart,
    renderEventRetention: {
      evictedEvents: evictedAtStart,
      earliestDocumentCommitId: eventsAtStart[0]?.documentCommitId ?? null,
      latestDocumentCommitId: eventsAtStart.at(-1)?.documentCommitId ?? null,
    },
  }
}

export async function getRendersLeaderboards(limit: number): Promise<{
  slowest: RenderReport[]
  mostRerendered: RenderReport[]
  mostUnnecessary: RenderReport[]
  mostUnstable: RenderReport[]
}> {
  return buildRendersLeaderboards(records, limit)
}

export async function getRendersLeaderboardsMeasurement(limit: number): Promise<{
  commits: number
  tracking: boolean
  documentCommitId: number
  attribution: ReportAttribution
  coverage: RenderTrackingCoverage
  boards: Awaited<ReturnType<typeof buildRendersLeaderboards>>
}> {
  const recordsAtStart = snapshotRenderRecords()
  const commitsAtStart = commits
  const epoch = captureReportEpoch()
  const tracking = isTracking()
  const coverage = getRenderTrackingCoverage('measurement')
  const boards = await buildRendersLeaderboards(recordsAtStart, limit, {
    isCurrent: () => reportStateMatches(epoch),
  })
  return {
    commits: commitsAtStart,
    tracking,
    documentCommitId: epoch.documentCommitId,
    attribution: reportAttribution(epoch),
    coverage,
    boards,
  }
}

export async function getRenderSummary(appOnly = true): Promise<RenderSummary> {
  return buildRenderSummary(records, commits, appOnly)
}

/** Store the current aggregates under `label` (overwriting a prior snapshot of the same label) so a later react_renders_diff can measure change against it. */
export async function takeSnapshot(label: string): Promise<{
  label: string
  commits: number
  components: number
  coverage: RenderTrackingCoverage
}> {
  const recordsAtStart = snapshotRenderRecords()
  const commitsAtStart = commits
  const clearsAtStart = clears
  const epoch = captureReportEpoch()
  const coverage = getRenderTrackingCoverage('measurement')
  const components = await buildCurrentAggregates(recordsAtStart, true, {
    isCurrent: () => reportStateMatches(epoch),
  })
  if (!reportStateMatches(epoch)) {
    throw new Error(
      'React analysis changed while the snapshot was resolving. Retry after commits, clears, or refreshes settle.',
    )
  }
  return storeRenderSnapshot(label, commitsAtStart, clearsAtStart, components, coverage)
}

/** Compare a stored snapshot against the current live aggregates: total self-time change plus per-component regressions/improvements past a threshold, and components that appeared/vanished. */
export async function rendersDiff(baseline: string, thresholdMs: number) {
  const recordsAtStart = snapshotRenderRecords()
  const commitsAtStart = commits
  const clearsAtStart = clears
  const epoch = captureReportEpoch()
  const coverage = getRenderTrackingCoverage('measurement')
  const after = await buildCurrentAggregates(recordsAtStart, true, {
    isCurrent: () => reportStateMatches(epoch),
  })
  if (!reportStateMatches(epoch)) {
    throw new Error(
      'React analysis changed while the render diff was resolving. Retry after commits, clears, or refreshes settle.',
    )
  }
  return diffRenderSnapshot(baseline, thresholdMs, commitsAtStart, clearsAtStart, after, coverage)
}

function shouldAnalyzeCommitFiber(fiber: Fiber): boolean {
  return (
    isCompositeFiber(fiber) ||
    fiber.tag === SuspenseComponentTag ||
    ((fiber.flags ?? 0) & DID_CAPTURE) !== 0
  )
}

export function recordCommitFiber(
  fiber: Fiber,
  phase: RenderPhase,
  budget: CommitAnalysisBudget,
  targeted = isObservationTarget(fiber),
): boolean {
  if (!shouldAnalyzeCommitFiber(fiber)) return false
  if (!targeted && budget.processed >= budget.limit) {
    budget.skipped += 1
    skippedCommitFibers += 1
    return false
  }
  const work = targeted ? budget.targetWork : budget.work
  if (!consumeCommitWork(work, targeted ? 'target-fibers' : 'commit-fibers')) {
    if (targeted) {
      budget.targetSkipped += 1
      targetedFibersSkipped += 1
    } else {
      budget.skipped += 1
    }
    skippedCommitFibers += 1
    return false
  }
  if (targeted) {
    budget.targetProcessed += 1
    targetedFibersProcessed += 1
  } else {
    budget.processed += 1
  }
  try {
    const effectPreparation = prepareEffect(fiber, phase, commits, work)
    if (!consumeCommitWork(work, targeted ? 'target-render-record' : 'render-record')) {
      if (targeted) {
        budget.targetSkipped += 1
        targetedFibersSkipped += 1
      } else {
        budget.skipped += 1
      }
      skippedCommitFibers += 1
      return false
    }
    recordRender(fiber, phase, effectPreparation, work, budget.currentCommitEvidence)
    if (consumeCommitWork(work, targeted ? 'target-error-state' : 'error-state')) {
      recordErrorState(fiber)
    }
    return true
  } catch {
    budget.failed += 1
    analysisFailedFibers += 1
    return false
  }
}

export function recordRender(
  fiber: Fiber,
  phase: RenderPhase,
  effectPreparation?: PreparedEffectObservation,
  commitWork?: CommitWorkBudget,
  commitEvidence?: CurrentCommitEvidence,
): void {
  if (!isCompositeFiber(fiber)) return
  const id = getFiberId(fiber)
  const previous = records.get(id)
  const checkpoint = previous ? { ...previous, causeCounts: { ...previous.causeCounts } } : null
  try {
    recordRenderAtomic(fiber, phase, effectPreparation, commitWork, commitEvidence)
  } catch (error) {
    if (checkpoint) records.set(id, checkpoint)
    else records.delete(id)
    throw error
  }
}

function recordRenderAtomic(
  fiber: Fiber,
  phase: RenderPhase,
  effectPreparation?: PreparedEffectObservation,
  commitWork?: CommitWorkBudget,
  commitEvidence?: CurrentCommitEvidence,
): void {
  if (!isCompositeFiber(fiber)) return

  // Ignore simulated Suspense unmounts; recordPendingUnmounts handles exact lifecycle tombstones.
  if (phase === 'unmount') {
    return
  }
  const id = getFiberId(fiber)
  const existing = records.get(id)
  const recordName = existing?.name ?? nameOf(fiber)
  const forget = existing?.forget ?? hasMemoCache(fiber)
  const timings = getTimings(fiber)
  const instancePreparation = prepareInstanceRender(
    fiber,
    phase,
    commits,
    getDocumentCommitId(),
    commitWork,
  )
  const instance = instancePreparation.instance

  if (phase === 'mount') {
    const inputCoverage = {
      complete: true,
      omittedInputs: 0,
      scanTruncated: false,
      propsNotEnumerated: false,
    } as const
    const eventId = nextCausalEventId('render')
    const causes: RenderCause[] = [{ kind: 'mount', evidence: 'exact' }]
    const effects: EffectScheduleObservation = effectPreparation?.observation ?? {
      scheduled: scheduledEffectCount(fiber),
      complete: true,
    }
    const assessment = assessRender(
      fiber,
      phase,
      causes,
      effects.scheduled,
      true,
      commitWork,
      effects.complete,
      commitEvidence,
    )
    const retained = prepareCauseEventEvidence(causes, assessment, inputCoverage)
    const record = draftRenderRecord(existing, {
      id,
      name: recordName,
      instance,
      fiber,
      forget,
      timings,
      commitId: commits,
      documentCommitId: getDocumentCommitId(),
    })
    record.renders += 1
    record.mounts += 1
    record.causes = causes
    record.necessity = 'necessary'
    record.assessment = assessment
    record.inputCoverage = inputCoverage
    publishCauseEvent(record, retained, eventId)
    instancePreparation.publish()
    effectPreparation?.publish(instance)
    return
  }

  const renderEventId = nextCausalEventId('render')
  const evidenceBudget = createRenderEvidenceBudget(commitWork)
  const pendingQuerySubscribers: PendingQuerySubscriberRegistration[] = []
  const propChanges = diffProps(fiber, evidenceBudget)
  const stateChanges = diffStateChanges(fiber, evidenceBudget)
  const contextChanges = diffContextChanges(fiber, evidenceBudget)
  const externalStoreChanges = diffExternalStoreChanges(
    fiber,
    evidenceBudget,
    { renderEventId, commitId: commits },
    pendingQuerySubscribers,
    instance,
  )
  const childrenDidChange = childrenChanged(fiber, evidenceBudget)
  const coverage = inputCoverage(evidenceBudget)
  const stateDidChange = stateChanges.length > 0
  const changes: RenderChange[] = [...propChanges, ...stateChanges]
  const observableCauses: RenderCause[] = [
    ...propChanges.map(
      (change): RenderCause => ({
        kind: 'props',
        evidence: 'exact',
        name: change.name,
        referenceChanged: change.referenceChanged,
        referenceOnly: change.referenceOnly,
        unstable: change.unstable,
        beforePresent: change.beforePresent,
        afterPresent: change.afterPresent,
        before: change.before,
        after: change.after,
        deepDiff: change.deepDiff,
      }),
    ),
    ...stateChanges.map(
      (change): RenderCause => ({
        kind: 'state',
        evidence: 'exact',
        name: change.name,
        before: change.before,
        after: change.after,
        deepDiff: change.deepDiff,
        ...('hook' in change ? { hook: change.hook } : {}),
      }),
    ),
    ...(childrenDidChange ? ([{ kind: 'children', evidence: 'exact' }] as const) : []),
    ...contextChanges,
    ...externalStoreChanges,
  ]
  const parentResult =
    observableCauses.length === 0
      ? renderedParentCause(fiber, commitWork, commitEvidence?.renderedFibers)
      : { cause: null, complete: true }
  const parentCause = parentResult.cause
  const causalAnalysisComplete = coverage.complete && parentResult.complete
  const causes: RenderCause[] =
    observableCauses.length > 0
      ? observableCauses
      : parentCause
        ? [parentCause]
        : !causalAnalysisComplete
          ? [{ kind: 'unknown', evidence: 'unknown', reason: 'causal-analysis-incomplete' }]
          : [{ kind: 'unknown', evidence: 'unknown', reason: 'no-observable-fiber-input-change' }]
  const necessity: RenderNecessity =
    observableCauses.length > 0
      ? 'necessary'
      : !causalAnalysisComplete || parentCause
        ? 'unknown'
        : 'unnecessary'
  const effects: EffectScheduleObservation = effectPreparation?.observation ?? {
    scheduled: scheduledEffectCount(fiber),
    complete: true,
  }
  const assessment = assessRender(
    fiber,
    phase,
    causes,
    effects.scheduled,
    causalAnalysisComplete,
    commitWork,
    effects.complete,
    commitEvidence,
  )
  const retained = prepareCauseEventEvidence(causes, assessment, coverage)
  const record = draftRenderRecord(existing, {
    id,
    name: recordName,
    instance,
    fiber,
    forget,
    timings,
    commitId: commits,
    documentCommitId: getDocumentCommitId(),
  })
  record.renders += 1
  record.updates += 1
  record.changes = changes
  record.causes = causes
  record.necessity = necessity
  record.assessment = assessment
  record.inputCoverage = coverage
  // A render is unnecessary only when none of props/state/children/context changed — new children or context are legitimate reasons.
  if (
    coverage.complete &&
    changes.length === 0 &&
    !childrenDidChange &&
    contextChanges.length === 0 &&
    externalStoreChanges.length === 0
  ) {
    record.unnecessary += 1
  }
  // Canonical allocation candidate: bounded deep evidence found reference-only props and no other React input cause.
  if (
    coverage.complete &&
    propChanges.length > 0 &&
    propChanges.every((change) => change.referenceOnly) &&
    !stateDidChange &&
    !childrenDidChange &&
    contextChanges.length === 0 &&
    externalStoreChanges.length === 0
  ) {
    record.referenceOnlyPropRenders += 1
    record.unstableRenders += 1
  }
  publishCauseEvent(record, retained, renderEventId)
  instancePreparation.publish()
  for (const pending of pendingQuerySubscribers) {
    registerQuerySubscriber(pending.observer, pending.subscriber)
  }
  effectPreparation?.publish(instance)
  if (coverage.scanTruncated || coverage.omittedInputs > 0) truncatedInputFibers += 1
  if (coverage.propsNotEnumerated) propsNotEnumeratedFibers += 1
}

interface PreparedCauseEventEvidence {
  causes: RenderCause[]
  assessment: RenderAssessment
  inputCoverage: RenderInputCoverage
}

function prepareCauseEventEvidence(
  causes: RenderCause[],
  assessment: RenderAssessment,
  coverage: RenderInputCoverage,
): PreparedCauseEventEvidence {
  return {
    causes: structuredClone(causes),
    assessment: structuredClone(assessment),
    inputCoverage: { ...coverage },
  }
}

function recordPendingUnmounts(rendererId: number, budget: CommitAnalysisBudget): void {
  const retained: { rendererId: number; fiber: Fiber; targeted: boolean }[] = []
  for (const pending of pendingUnmounts) {
    const work = pending.targeted ? budget.targetWork : budget.work
    if (
      !consumeCommitWork(work, pending.targeted ? 'target-pending-unmounts' : 'pending-unmounts')
    ) {
      retained.push(pending)
      if (pending.targeted) {
        budget.targetSkipped += 1
        targetedFibersSkipped += 1
      }
      continue
    }
    if (pending.rendererId !== rendererId) {
      retained.push(pending)
      continue
    }
    if (!isCompositeFiber(pending.fiber)) continue
    const instance = noteInstanceRender(
      pending.fiber,
      'unmount',
      commits,
      getDocumentCommitId(),
      work,
    )
    removeEffectRecord(pending.fiber)
    records.delete(instance.fiberId)
  }
  pendingUnmounts.length = 0
  pendingUnmounts.push(...retained)
}

/** Queue only component lifecycles; host-node unmounts cannot produce cohort tombstones. */
export function queuePendingUnmount(rendererId: number, fiber: Fiber): void {
  if (!isCompositeFiber(fiber)) return
  const targeted = isObservationTarget(fiber)
  pendingUnmounts.push({ rendererId, fiber, targeted })
  if (pendingUnmounts.length <= observationConfiguration.lifecycle.bufferLimit) return
  const protectedTargetIndices = new Set<number>()
  let remainingReservation = observationConfiguration.lifecycle.targetReserve
  for (let index = pendingUnmounts.length - 1; index >= 0 && remainingReservation > 0; index -= 1) {
    if (!pendingUnmounts[index]?.targeted) continue
    protectedTargetIndices.add(index)
    remainingReservation -= 1
  }
  const evictionIndex = Math.max(
    0,
    pendingUnmounts.findIndex((_, index) => !protectedTargetIndices.has(index)),
  )
  const [dropped] = pendingUnmounts.splice(evictionIndex, 1)
  if (dropped?.targeted) droppedTargetUnmountFibers += 1
  droppedPendingUnmountFibers += 1
}

function discardPendingUnmounts(rendererId: number): void {
  const retained: { rendererId: number; fiber: Fiber; targeted: boolean }[] = []
  for (const pending of pendingUnmounts) {
    if (pending.rendererId === rendererId) discardExcludedInstanceUnmount(pending.fiber)
    else retained.push(pending)
  }
  pendingUnmounts.length = 0
  pendingUnmounts.push(...retained)
}

function publishCauseEvent(
  record: RenderRecord,
  retained: PreparedCauseEventEvidence,
  eventId: string,
): void {
  for (const cause of retained.causes) record.causeCounts[cause.kind] += 1
  record.latestRenderEventId = eventId
  const event: RetainedRenderCauseEvent = {
    renderEventId: eventId,
    observationId: getActiveObservation()?.id ?? null,
    commitId: commits,
    documentCommitId: getDocumentCommitId(),
    componentId: record.id,
    componentName: record.name,
    instance: {
      ...record.instance,
      parent: record.instance.parent ? { ...record.instance.parent } : null,
      keyedParent: record.instance.keyedParent ? { ...record.instance.keyedParent } : null,
    },
    causes: retained.causes,
    necessity: record.necessity,
    assessment: retained.assessment,
    inputCoverage: retained.inputCoverage,
  }
  records.set(record.id, record)
  recentCauseEvents.push(event)
  if (recentCauseEvents.length > RECENT_CAUSE_EVENT_LIMIT) {
    recentCauseEvents.shift()
    droppedRenderEvents += 1
  }
}

/** Finalize once after traversal so report coverage names every subsystem the shared guard stopped. */
export function finalizeCommitAnalysisBudget(budget: CommitAnalysisBudget): void {
  const exhausted = [
    ...commitWorkExhaustions(budget.work),
    ...commitWorkExhaustions(budget.targetWork).map((subsystem) => `target:${subsystem}`),
  ]
  if (exhausted.length === 0) return
  budgetExhaustedCommits += 1
  for (const subsystem of exhausted) {
    budgetExhaustedSubsystems.set(subsystem, (budgetExhaustedSubsystems.get(subsystem) ?? 0) + 1)
  }
  if (observationConfiguration.budget.adaptive && adaptiveBudgetScale < 4) {
    adaptiveBudgetScale += 1
  }
}

function renderedParentCause(
  fiber: Fiber,
  budget?: CommitWorkBudget,
  renderedFibers?: ReadonlySet<Fiber>,
): { cause: RenderCause | null; complete: boolean } {
  try {
    let parent = fiber.return
    while (parent && !isCompositeFiber(parent)) {
      if (!consumeCommitWork(budget, 'parent-ancestry')) return { cause: null, complete: false }
      parent = parent.return
    }
    if (!parent) return { cause: null, complete: true }
    if (!renderedFibers) return { cause: null, complete: false }
    if (!consumeCommitWork(budget, 'parent-ancestry')) return { cause: null, complete: false }
    if (!renderedFibers.has(parent)) return { cause: null, complete: true }
    return {
      cause: {
        kind: 'parent',
        evidence: 'inferred',
        parentId: getFiberId(parent),
        parentName: nameOf(parent),
        reason: 'nearest-rendered-ancestor',
      },
      complete: true,
    }
  } catch {
    analysisFailedFibers += 1
    return { cause: null, complete: false }
  }
}
