import type { ToolOutput } from '../../protocol'
import type { reactRendersDiffContract } from './contracts'

export interface ComponentAggregate {
  definitionKey: string
  name: string
  source: string | null
  renders: number
  mounts: number
  updates: number
  selfTime: number
  totalTime: number
  unnecessary: number
  referenceOnlyPropRenders: number
  /** Legacy alias for referenceOnlyPropRenders. */
  unstableRenders: number
}

export interface RenderTrackingCoverage {
  complete: boolean
  inputAttributionComplete: boolean
  semantics: 'exact' | 'lower-bound'
  coverageDomain: 'render-measurement' | 'render-causality'
  skippedCommitFibers: number
  droppedUnmountFibers: number
  analysisFailedFibers: number
  truncatedInputFibers: number
  propsNotEnumeratedFibers: number
  budgetExhaustedCommits: number
  budgetExhaustedSubsystems: { subsystem: string; commits: number }[]
  targeted?: {
    components: string[]
    roots: number[]
    processedFibers: number
    skippedFibers: number
    complete: boolean
  }
  observationBudget?: {
    adaptive: boolean
    adaptiveScale: number
    fiberLimit: number
    operationLimit: number
    timeLimitMs: number
    targetOperationReserve: number
    targetTimeReserveMs: number
    lifecycleBufferLimit: number
    lifecycleTargetReserve: number
  }
}

type RenderTrackingCoverageInput = Omit<
  RenderTrackingCoverage,
  | 'complete'
  | 'inputAttributionComplete'
  | 'semantics'
  | 'coverageDomain'
  | 'targeted'
  | 'observationBudget'
>

export function buildRenderTrackingCoverage(
  input: RenderTrackingCoverageInput,
  scope: 'causal' | 'measurement',
): RenderTrackingCoverage {
  const measurementComplete =
    input.skippedCommitFibers === 0 &&
    input.droppedUnmountFibers === 0 &&
    input.analysisFailedFibers === 0 &&
    input.budgetExhaustedCommits === 0
  const inputAttributionComplete =
    measurementComplete && input.truncatedInputFibers === 0 && input.propsNotEnumeratedFibers === 0
  return {
    ...input,
    complete: scope === 'measurement' ? measurementComplete : inputAttributionComplete,
    inputAttributionComplete,
    semantics: (scope === 'measurement' ? measurementComplete : inputAttributionComplete)
      ? 'exact'
      : 'lower-bound',
    coverageDomain: scope === 'measurement' ? 'render-measurement' : 'render-causality',
  }
}

export function renderSummarySemantics(
  coverage: RenderTrackingCoverage,
  observedRenders: number,
): 'exact' | 'lower-bound' | 'unknown' {
  if (coverage.complete) return 'exact'
  return observedRenders > 0 ? 'lower-bound' : 'unknown'
}

export function renderEvidenceComparability(
  coverage: RenderTrackingCoverage,
  attributionStatus: 'current' | 'stale',
): { comparable: boolean; notComparableReasons: string[] } {
  const reasons: string[] = []
  if (coverage.skippedCommitFibers > 0) reasons.push('skipped-commit-fibers')
  if (coverage.droppedUnmountFibers > 0) reasons.push('dropped-unmount-fibers')
  if (coverage.analysisFailedFibers > 0) reasons.push('fiber-analysis-failed')
  if (coverage.truncatedInputFibers > 0) reasons.push('render-input-scan-truncated')
  if (coverage.propsNotEnumeratedFibers > 0) reasons.push('render-props-not-enumerated')
  if (coverage.budgetExhaustedCommits > 0) reasons.push('commit-analysis-budget-exhausted')
  if (attributionStatus === 'stale') reasons.push('report-attribution-stale')
  return { comparable: reasons.length === 0, notComparableReasons: reasons }
}

interface Snapshot {
  commits: number
  clears: number
  components: ComponentAggregate[]
  coverage: RenderTrackingCoverage
}

type RendersDiff = ToolOutput<typeof reactRendersDiffContract>
type RenderDelta = RendersDiff['regressed'][number]

const snapshots = new Map<string, Snapshot>()

const aggregateKey = (aggregate: ComponentAggregate): string => aggregate.definitionKey

const round1 = (value: number): number => Math.round(value * 10) / 10

const pctChange = (before: number, delta: number): number | null =>
  before === 0 ? null : round1((delta / before) * 100)

const toDelta = (
  name: string,
  source: string | null,
  before: ComponentAggregate,
  after: ComponentAggregate,
): RenderDelta => ({
  name,
  ...(source ? { source } : {}),
  deltaMs: round1(after.selfTime - before.selfTime),
  before: { renders: before.renders, selfTime: round1(before.selfTime) },
  after: { renders: after.renders, selfTime: round1(after.selfTime) },
})

export function storeRenderSnapshot(
  label: string,
  commits: number,
  clears: number,
  components: ComponentAggregate[],
  coverage: RenderTrackingCoverage,
): { label: string; commits: number; components: number; coverage: RenderTrackingCoverage } {
  snapshots.set(label, { commits, clears, components, coverage })
  return { label, commits, components: components.length, coverage }
}

export const snapshotLabels = (): string[] => [...snapshots.keys()]

export function diffRenderSnapshot(
  baseline: string,
  thresholdMs: number,
  commits: number,
  clears: number,
  after: ComponentAggregate[],
  coverage: RenderTrackingCoverage,
): RendersDiff {
  const snapshot = snapshots.get(baseline)
  if (!snapshot) {
    throw new Error(
      snapshots.size === 0
        ? `No snapshot named "${baseline}" — take one with react_profile_snapshot first (no snapshots stored yet).`
        : `No snapshot named "${baseline}". Stored labels: ${snapshotLabels().join(', ')}.`,
    )
  }

  const beforeByKey = new Map(snapshot.components.map((entry) => [aggregateKey(entry), entry]))
  const afterByKey = new Map(after.map((entry) => [aggregateKey(entry), entry]))
  const regressed: RenderDelta[] = []
  const improved: RenderDelta[] = []
  const added: { name: string; source?: string; renders: number; selfTime: number }[] = []
  const removed: { name: string; source?: string }[] = []

  for (const [key, afterAggregate] of afterByKey) {
    const beforeAggregate = beforeByKey.get(key)
    if (!beforeAggregate) {
      added.push({
        name: afterAggregate.name,
        ...(afterAggregate.source ? { source: afterAggregate.source } : {}),
        renders: afterAggregate.renders,
        selfTime: round1(afterAggregate.selfTime),
      })
      continue
    }
    const delta = afterAggregate.selfTime - beforeAggregate.selfTime
    if (delta > thresholdMs) {
      regressed.push(
        toDelta(afterAggregate.name, afterAggregate.source, beforeAggregate, afterAggregate),
      )
    } else if (delta < -thresholdMs) {
      improved.push(
        toDelta(afterAggregate.name, afterAggregate.source, beforeAggregate, afterAggregate),
      )
    }
  }
  for (const [key, beforeAggregate] of beforeByKey) {
    if (!afterByKey.has(key)) {
      removed.push({
        name: beforeAggregate.name,
        ...(beforeAggregate.source ? { source: beforeAggregate.source } : {}),
      })
    }
  }

  const byMagnitude = (left: RenderDelta, right: RenderDelta): number =>
    Math.abs(right.deltaMs) - Math.abs(left.deltaMs)
  regressed.sort(byMagnitude)
  improved.sort(byMagnitude)

  const beforeSelf = snapshot.components.reduce((sum, entry) => sum + entry.selfTime, 0)
  const afterSelf = after.reduce((sum, entry) => sum + entry.selfTime, 0)
  const selfDelta = afterSelf - beforeSelf
  return {
    baseline,
    commits: { before: snapshot.commits, after: commits },
    clearsSinceBaseline: clears - snapshot.clears,
    coverage: { baseline: snapshot.coverage, current: coverage },
    selfTimeMs: {
      before: round1(beforeSelf),
      after: round1(afterSelf),
      delta: round1(selfDelta),
      pct: pctChange(beforeSelf, selfDelta),
    },
    regressed,
    improved,
    added,
    removed,
  }
}

export function clearSnapshots(): void {
  snapshots.clear()
}
