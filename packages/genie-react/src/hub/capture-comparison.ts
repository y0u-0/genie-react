import type {
  CaptureArtifact,
  CaptureComparison,
  CaptureMetric,
  devtoolsCaptureCompareContract,
  ToolInput,
} from '../protocol'

type ComparisonInput = ToolInput<typeof devtoolsCaptureCompareContract>
type ParsedComparisonInput = ComparisonInput & {
  metrics: CaptureMetric[]
  minimumRuns: number
  warmupRuns: number
  outlierThreshold: number
  confidenceLevel: number
  minimumEffectPct: number
  budgets: NonNullable<ComparisonInput['budgets']>
}
type MetricResult = CaptureComparison['metrics'][number]
type MetricBudget = NonNullable<MetricResult['budget']>

const METRIC_DIRECTIONS: Record<CaptureMetric, MetricResult['direction']> = {
  'react.commits': 'lower-is-better',
  'react.renders': 'lower-is-better',
  'react.updates': 'lower-is-better',
  'react.unnecessary': 'lower-is-better',
  'react.selfTimeMs': 'lower-is-better',
  'effects.hot': 'lower-is-better',
  'query.pending': 'lower-is-better',
  'memory.usedHeapBytes': 'lower-is-better',
  'performance.avgFps': 'higher-is-better',
  'performance.droppedFrames': 'lower-is-better',
}

export function compareCaptureCohorts(
  baseline: CaptureArtifact[],
  candidate: CaptureArtifact[],
  input: ParsedComparisonInput,
  identity: { comparisonId: string; createdAt: string },
): CaptureComparison {
  const warmupBaselineCaptureIds = baseline
    .slice(0, input.warmupRuns)
    .map((capture) => capture.captureId)
  const warmupCandidateCaptureIds = candidate
    .slice(0, input.warmupRuns)
    .map((capture) => capture.captureId)
  const usableBaseline = baseline.slice(input.warmupRuns)
  const usableCandidate = candidate.slice(input.warmupRuns)
  const budgets = new Map(input.budgets.map((budget) => [budget.metric, budget]))
  const metrics = input.metrics.map((metric) =>
    compareMetric(metric, usableBaseline, usableCandidate, input, budgets.get(metric)),
  )
  const budgeted = metrics.filter((metric) => metric.budget !== undefined)
  const violations = budgeted
    .filter((metric) => metric.verdict === 'fail')
    .map((metric) => ({ metric: metric.metric, reasons: metric.reasons }))
  const overall: CaptureComparison['overall'] =
    budgeted.length === 0
      ? 'informational'
      : violations.length > 0
        ? 'fail'
        : budgeted.some((metric) => metric.verdict === 'not-comparable')
          ? 'not-comparable'
          : budgeted.some((metric) => metric.verdict === 'insufficient-data')
            ? 'insufficient-data'
            : budgeted.some((metric) => metric.verdict === 'inconclusive')
              ? 'inconclusive'
              : 'pass'

  return {
    schemaVersion: '1.0',
    kind: 'capture-comparison',
    comparisonId: identity.comparisonId,
    createdAt: identity.createdAt,
    minimumRuns: input.minimumRuns,
    policy: {
      warmupRuns: input.warmupRuns,
      outlierThreshold: input.outlierThreshold,
      confidenceLevel: input.confidenceLevel,
      minimumEffectPct: input.minimumEffectPct,
    },
    excluded: { warmupBaselineCaptureIds, warmupCandidateCaptureIds },
    baselineCaptureIds: baseline.map((capture) => capture.captureId),
    candidateCaptureIds: candidate.map((capture) => capture.captureId),
    overall,
    metrics,
    violations,
    warnings: environmentWarnings(baseline, candidate),
  }
}

function compareMetric(
  metric: CaptureMetric,
  baseline: CaptureArtifact[],
  candidate: CaptureArtifact[],
  input: ParsedComparisonInput,
  budget: MetricBudget | undefined,
): MetricResult {
  const baselineSamples = samplesFor(metric, baseline)
  const candidateSamples = samplesFor(metric, candidate)
  const baselineFiltered = rejectOutliers(baselineSamples.samples, input.outlierThreshold)
  const candidateFiltered = rejectOutliers(candidateSamples.samples, input.outlierThreshold)
  const baselineValues = baselineFiltered.kept.map((sample) => sample.value)
  const candidateValues = candidateFiltered.kept.map((sample) => sample.value)
  const baselineStats = summarizeSamples(baselineValues)
  const candidateStats = summarizeSamples(candidateValues)
  const medianDelta = nullableDifference(candidateStats.median, baselineStats.median)
  const regressionPct = metricRegressionPct(
    METRIC_DIRECTIONS[metric],
    baselineStats.median,
    candidateStats.median,
  )
  const sampleFloor = Math.min(baselineStats.samples, candidateStats.samples)
  const notComparableReasons = unique([
    ...baselineSamples.notComparableReasons,
    ...candidateSamples.notComparableReasons,
    ...crossCohortReasons(metric, baselineSamples, candidateSamples),
  ])
  const reasons: string[] = [...notComparableReasons]
  let verdict: MetricResult['verdict'] = budget ? 'pass' : 'informational'
  const confidence = comparisonConfidence(
    baselineValues,
    candidateValues,
    baselineStats,
    candidateStats,
    regressionPct,
    input,
  )

  if (budget && notComparableReasons.length > 0) {
    verdict = 'not-comparable'
  } else if (budget && sampleFloor < input.minimumRuns) {
    verdict = 'insufficient-data'
    reasons.push(
      `requires ${input.minimumRuns} usable samples per cohort after warm-up and outlier exclusion; found ${baselineStats.samples} baseline and ${candidateStats.samples} candidate`,
    )
  } else if (budget && candidateStats.median !== null) {
    if (budget.maxValue !== undefined && candidateStats.median > budget.maxValue) {
      verdict = 'fail'
      reasons.push(`candidate median ${candidateStats.median} exceeds maxValue ${budget.maxValue}`)
    }
    if (budget.minValue !== undefined && candidateStats.median < budget.minValue) {
      verdict = 'fail'
      reasons.push(`candidate median ${candidateStats.median} is below minValue ${budget.minValue}`)
    }
    if (budget.maxRegressionPct !== undefined) {
      if (regressionPct === null) {
        verdict = verdict === 'fail' ? 'fail' : 'insufficient-data'
        reasons.push('percentage regression is undefined because the baseline median is zero')
      } else if (regressionPct > budget.maxRegressionPct) {
        if (Math.abs(regressionPct) < input.minimumEffectPct || !confidence.significant) {
          verdict = verdict === 'fail' ? 'fail' : 'inconclusive'
          reasons.push(
            `regression ${regressionPct}% exceeds maxRegressionPct ${budget.maxRegressionPct}% but does not clear the ${input.minimumEffectPct}% practical-effect and ${input.confidenceLevel} confidence gates`,
          )
        } else {
          verdict = 'fail'
          reasons.push(
            `regression ${regressionPct}% exceeds maxRegressionPct ${budget.maxRegressionPct}% with ${confidence.achieved ?? 0} confidence`,
          )
        }
      }
    }
  }

  return {
    metric,
    direction: METRIC_DIRECTIONS[metric],
    baseline: baselineStats,
    candidate: candidateStats,
    missingBaselineCaptureIds: baselineSamples.missing,
    missingCandidateCaptureIds: candidateSamples.missing,
    outlierBaselineCaptureIds: baselineFiltered.rejected.map((sample) => sample.captureId),
    outlierCandidateCaptureIds: candidateFiltered.rejected.map((sample) => sample.captureId),
    comparable: notComparableReasons.length === 0,
    notComparableReasons,
    delta: { median: medianDelta, regressionPct },
    ...(budget ? { budget } : {}),
    confidence,
    verdict,
    reasons,
  }
}

function samplesFor(metric: CaptureMetric, captures: CaptureArtifact[]): SampleCollection {
  const samples: MetricSample[] = []
  const missing: string[] = []
  const notComparableReasons: string[] = []
  const refreshRates: number[] = []
  const coverageSignatures: string[] = []
  for (const capture of captures) {
    const evidence = metricEvidence(capture, metric)
    if (metric.startsWith('react.')) {
      coverageSignatures.push(evidence.coverageSignature ?? 'unreported')
    }
    if (!evidence.comparable) {
      notComparableReasons.push(...evidence.reasons)
      missing.push(capture.captureId)
      continue
    }
    const value = captureMetricValue(capture, metric)
    if (value === null) missing.push(capture.captureId)
    else samples.push({ captureId: capture.captureId, value })
    if (evidence.refreshRate !== null) refreshRates.push(evidence.refreshRate)
  }
  return { samples, missing, notComparableReasons, refreshRates, coverageSignatures }
}

interface MetricSample {
  captureId: string
  value: number
}

interface SampleCollection {
  samples: MetricSample[]
  missing: string[]
  notComparableReasons: string[]
  refreshRates: number[]
  coverageSignatures: string[]
}

function metricEvidence(
  capture: CaptureArtifact,
  metric: CaptureMetric,
): {
  comparable: boolean
  reasons: string[]
  refreshRate: number | null
  coverageSignature: string | null
} {
  if (metric.startsWith('react.')) {
    const result = toolResult(capture, 'react', 'react_get_renders')
    if (!isRecord(result)) {
      return { comparable: true, reasons: [], refreshRate: null, coverageSignature: null }
    }
    const coverageSignature = renderCoverageSignature(result)
    if (
      (metric === 'react.unnecessary' || metric === 'react.selfTimeMs') &&
      finiteNumber(result.omittedByLimit) !== null &&
      (finiteNumber(result.omittedByLimit) ?? 0) > 0
    ) {
      return {
        comparable: false,
        reasons: ['render-component-list-truncated'],
        refreshRate: null,
        coverageSignature,
      }
    }
    if (result.comparable === false) {
      return {
        comparable: false,
        reasons: stringArray(result.notComparableReasons, 'render-evidence-not-comparable'),
        refreshRate: null,
        coverageSignature,
      }
    }
    const semantics = isRecord(result.summary) ? result.summary.semantics : undefined
    if (semantics !== 'exact') {
      return {
        comparable: false,
        reasons: ['render-evidence-semantics-not-exact'],
        refreshRate: null,
        coverageSignature,
      }
    }
    return { comparable: true, reasons: [], refreshRate: null, coverageSignature }
  }
  if (metric.startsWith('performance.')) {
    const result = toolResult(capture, 'performance', 'browser_fps')
    if (!isRecord(result)) {
      return { comparable: true, reasons: [], refreshRate: null, coverageSignature: null }
    }
    const refreshRate = finiteNumber(result.refreshRate)
    if (result.hidden === true || result.comparable === false) {
      return {
        comparable: false,
        reasons: stringArray(
          result.notComparableReasons,
          result.hidden === true ? 'document-hidden-during-sample' : 'fps-not-comparable',
        ),
        refreshRate,
        coverageSignature: null,
      }
    }
    return { comparable: true, reasons: [], refreshRate, coverageSignature: null }
  }
  return { comparable: true, reasons: [], refreshRate: null, coverageSignature: null }
}

function crossCohortReasons(
  metric: CaptureMetric,
  baseline: SampleCollection,
  candidate: SampleCollection,
): string[] {
  const reasons: string[] = []
  if (metric.startsWith('react.')) {
    const signatures = new Set([...baseline.coverageSignatures, ...candidate.coverageSignatures])
    if (signatures.size > 1) reasons.push('render-coverage-policy-mismatch-between-cohorts')
  }
  if (metric.startsWith('performance.')) {
    const rates = new Set([...baseline.refreshRates, ...candidate.refreshRates])
    if (rates.size > 1) reasons.push('inferred-refresh-rate-mode-mismatch')
  }
  return reasons
}

function renderCoverageSignature(result: Record<string, unknown>): string | null {
  const coverage = isRecord(result.coverage) ? result.coverage : null
  if (!coverage) return null
  const targeted = isRecord(coverage.targeted) ? coverage.targeted : null
  const observationBudget = isRecord(coverage.observationBudget) ? coverage.observationBudget : null
  return JSON.stringify({
    complete: coverage.complete ?? null,
    inputAttributionComplete: coverage.inputAttributionComplete ?? null,
    semantics: coverage.semantics ?? null,
    coverageDomain: coverage.coverageDomain ?? null,
    targeted: targeted
      ? {
          components: stringArray(targeted.components, '').filter(Boolean).sort(),
          roots: numberArray(targeted.roots).sort((left, right) => left - right),
        }
      : null,
    observationBudget: observationBudget
      ? {
          adaptive: observationBudget.adaptive ?? null,
          adaptiveScale: observationBudget.adaptiveScale ?? null,
          fiberLimit: observationBudget.fiberLimit ?? null,
          operationLimit: observationBudget.operationLimit ?? null,
          timeLimitMs: observationBudget.timeLimitMs ?? null,
          targetOperationReserve: observationBudget.targetOperationReserve ?? null,
          targetTimeReserveMs: observationBudget.targetTimeReserveMs ?? null,
          lifecycleBufferLimit: observationBudget.lifecycleBufferLimit ?? null,
          lifecycleTargetReserve: observationBudget.lifecycleTargetReserve ?? null,
        }
      : null,
  })
}

function rejectOutliers(
  samples: MetricSample[],
  threshold: number,
): { kept: MetricSample[]; rejected: MetricSample[] } {
  if (samples.length < 3) return { kept: [...samples], rejected: [] }
  const values = samples.map((sample) => sample.value).sort((left, right) => left - right)
  const median = quantile(values, 0.5)
  const deviations = values.map((value) => Math.abs(value - median)).sort((a, b) => a - b)
  const mad = quantile(deviations, 0.5)
  const isOutlier =
    mad === 0
      ? (sample: MetricSample) =>
          samples.filter((candidate) => candidate.value === median).length >=
            Math.ceil(samples.length / 2) && sample.value !== median
      : (sample: MetricSample) => (0.6745 * Math.abs(sample.value - median)) / mad > threshold
  const kept: MetricSample[] = []
  const rejected: MetricSample[] = []
  for (const sample of samples) (isOutlier(sample) ? rejected : kept).push(sample)
  return { kept, rejected }
}

export function summarizeSamples(values: number[]): MetricResult['baseline'] {
  if (values.length === 0) {
    return { samples: 0, median: null, p95: null, mad: null, min: null, max: null }
  }
  const sorted = [...values].sort((left, right) => left - right)
  const median = quantile(sorted, 0.5)
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b)
  return {
    samples: sorted.length,
    median: round4(median),
    p95: round4(quantile(sorted, 0.95)),
    mad: round4(quantile(deviations, 0.5)),
    min: round4(sorted[0] ?? 0),
    max: round4(sorted.at(-1) ?? 0),
  }
}

function comparisonConfidence(
  baseline: number[],
  candidate: number[],
  baselineStats: MetricResult['baseline'],
  candidateStats: MetricResult['candidate'],
  observedEffectPct: number | null,
  input: ParsedComparisonInput,
): MetricResult['confidence'] {
  const pValue = permutationPValue(baseline, candidate)
  const baselineScale = Math.abs(baselineStats.median ?? 0)
  const pooledMad = Math.max(baselineStats.mad ?? 0, candidateStats.mad ?? 0)
  const noiseFloorPct =
    baselineScale > 0 ? round4(((pooledMad * 1.4826) / baselineScale) * 100) : null
  const achieved = pValue === null ? null : round4(1 - pValue)
  return {
    level: input.confidenceLevel,
    pValue,
    achieved,
    significant: pValue !== null && pValue <= 1 - input.confidenceLevel,
    minimumEffectPct: input.minimumEffectPct,
    observedEffectPct,
    noiseFloorPct,
  }
}

/** Exact two-sided permutation test over the mean difference after robust outlier rejection. */
function permutationPValue(baseline: number[], candidate: number[]): number | null {
  if (baseline.length === 0 || candidate.length === 0) return null
  const combined = [...baseline, ...candidate]
  const baselineSize = baseline.length
  const observed = Math.abs(average(candidate) - average(baseline))
  let permutations = 0
  let atLeastAsExtreme = 0
  const selected: number[] = []

  const visit = (start: number): void => {
    if (selected.length === baselineSize) {
      const selectedSet = new Set(selected)
      const permutedBaseline = selected.map((index) => combined[index] ?? 0)
      const permutedCandidate = combined.filter((_, index) => !selectedSet.has(index))
      const difference = Math.abs(average(permutedCandidate) - average(permutedBaseline))
      permutations += 1
      if (difference + Number.EPSILON >= observed) atLeastAsExtreme += 1
      return
    }
    const remaining = baselineSize - selected.length
    for (let index = start; index <= combined.length - remaining; index += 1) {
      selected.push(index)
      visit(index + 1)
      selected.pop()
    }
  }
  visit(0)
  return permutations === 0 ? null : round4(atLeastAsExtreme / permutations)
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Type-7 linear quantile, matching the common R/NumPy default and behaving sensibly for small samples. */
function quantile(sorted: number[], probability: number): number {
  if (sorted.length === 1) return sorted[0] ?? 0
  const position = (sorted.length - 1) * probability
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lower = sorted[lowerIndex] ?? 0
  const upper = sorted[upperIndex] ?? lower
  return lower + (upper - lower) * (position - lowerIndex)
}

function metricRegressionPct(
  direction: MetricResult['direction'],
  baselineMedian: number | null,
  candidateMedian: number | null,
): number | null {
  if (baselineMedian === null || candidateMedian === null) return null
  if (baselineMedian === 0) return candidateMedian === 0 ? 0 : null
  const regression =
    direction === 'lower-is-better'
      ? candidateMedian - baselineMedian
      : baselineMedian - candidateMedian
  return round4((regression / Math.abs(baselineMedian)) * 100)
}

function nullableDifference(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : round4(after - before)
}

function captureMetricValue(capture: CaptureArtifact, metric: CaptureMetric): number | null {
  switch (metric) {
    case 'react.commits':
      return numberAt(toolResult(capture, 'react', 'react_get_renders'), 'commits')
    case 'react.renders':
      return numberAt(toolResult(capture, 'react', 'react_get_renders'), 'summary', 'totalRenders')
    case 'react.updates':
      return numberAt(toolResult(capture, 'react', 'react_get_renders'), 'summary', 'totalUpdates')
    case 'react.unnecessary':
      return sumComponentField(toolResult(capture, 'react', 'react_get_renders'), 'unnecessary')
    case 'react.selfTimeMs':
      return sumComponentField(toolResult(capture, 'react', 'react_get_renders'), 'selfTime')
    case 'effects.hot':
      return hotEffectCount(toolResult(capture, 'effects', 'react_effect_audit'))
    case 'query.pending': {
      const result = toolResult(capture, 'query', 'query_is_fetching')
      const fetching = numberAt(result, 'fetching')
      const mutating = numberAt(result, 'mutating')
      return fetching === null || mutating === null ? null : fetching + mutating
    }
    case 'memory.usedHeapBytes':
      return numberAt(toolResult(capture, 'memory', 'browser_get_memory'), 'usedJSHeapSize')
    case 'performance.avgFps': {
      const result = toolResult(capture, 'performance', 'browser_fps')
      return isRecord(result) && result.hidden === true ? null : numberAt(result, 'avgFps')
    }
    case 'performance.droppedFrames': {
      const result = toolResult(capture, 'performance', 'browser_fps')
      return isRecord(result) && result.hidden === true ? null : numberAt(result, 'droppedFrames')
    }
  }
}

function toolResult(
  capture: CaptureArtifact,
  domain: keyof CaptureArtifact['sections'],
  tool: string,
): unknown {
  const result = capture.sections[domain]?.tools[tool]
  return result?.status === 'ok' ? result.result : null
}

function sumComponentField(result: unknown, field: string): number | null {
  if (!isRecord(result) || !Array.isArray(result.components)) return null
  let total = 0
  for (const component of result.components) {
    const value = isRecord(component) ? component[field] : undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    total += value
  }
  return round4(total)
}

function hotEffectCount(result: unknown): number | null {
  if (!isRecord(result) || !Array.isArray(result.components)) return null
  let hot = 0
  for (const component of result.components) {
    if (!isRecord(component) || !Array.isArray(component.effects)) return null
    for (const effect of component.effects) {
      if (isRecord(effect) && isRecord(effect.hotness) && effect.hotness.label === 'hot') hot += 1
    }
  }
  return hot
}

function numberAt(value: unknown, ...path: string[]): number | null {
  let current = value
  for (const key of path) {
    if (!isRecord(current)) return null
    current = current[key]
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringArray(value: unknown, fallback: string): string[] {
  if (!Array.isArray(value)) return [fallback]
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length > 0 ? strings : [fallback]
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : []
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function environmentWarnings(baseline: CaptureArtifact[], candidate: CaptureArtifact[]): string[] {
  const signatures = new Set([...baseline, ...candidate].map(environmentSignature))
  return signatures.size <= 1
    ? []
    : [
        `Capture cohorts span ${signatures.size} runtime fingerprints (app/React/TanStack); compare like-for-like environments.`,
      ]
}

function environmentSignature(capture: CaptureArtifact): string {
  return JSON.stringify({
    name: capture.session.app.name ?? null,
    reactVersion: capture.session.app.reactVersion ?? null,
    tanstack: capture.session.app.tanstack ?? null,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
