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
  const budgets = new Map(input.budgets.map((budget) => [budget.metric, budget]))
  const metrics = input.metrics.map((metric) =>
    compareMetric(metric, baseline, candidate, input.minimumRuns, budgets.get(metric)),
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
        : budgeted.some((metric) => metric.verdict === 'insufficient-data')
          ? 'insufficient-data'
          : 'pass'

  return {
    schemaVersion: '1.0',
    kind: 'capture-comparison',
    comparisonId: identity.comparisonId,
    createdAt: identity.createdAt,
    minimumRuns: input.minimumRuns,
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
  minimumRuns: number,
  budget: MetricBudget | undefined,
): MetricResult {
  const baselineSamples = samplesFor(metric, baseline)
  const candidateSamples = samplesFor(metric, candidate)
  const baselineStats = summarizeSamples(baselineSamples.values)
  const candidateStats = summarizeSamples(candidateSamples.values)
  const medianDelta = nullableDifference(candidateStats.median, baselineStats.median)
  const regressionPct = metricRegressionPct(
    METRIC_DIRECTIONS[metric],
    baselineStats.median,
    candidateStats.median,
  )
  const sampleFloor = Math.min(baselineStats.samples, candidateStats.samples)
  const confidence = confidenceFor(sampleFloor, minimumRuns)
  const reasons: string[] = []
  let verdict: MetricResult['verdict'] = budget ? 'pass' : 'informational'

  if (budget && sampleFloor < minimumRuns) {
    verdict = 'insufficient-data'
    reasons.push(
      `requires ${minimumRuns} usable samples per cohort; found ${baselineStats.samples} baseline and ${candidateStats.samples} candidate`,
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
        verdict = 'fail'
        reasons.push(
          `regression ${regressionPct}% exceeds maxRegressionPct ${budget.maxRegressionPct}%`,
        )
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
    delta: { median: medianDelta, regressionPct },
    confidence,
    ...(budget ? { budget } : {}),
    verdict,
    reasons,
  }
}

function samplesFor(
  metric: CaptureMetric,
  captures: CaptureArtifact[],
): { values: number[]; missing: string[] } {
  const values: number[] = []
  const missing: string[] = []
  for (const capture of captures) {
    const value = captureMetricValue(capture, metric)
    if (value === null) missing.push(capture.captureId)
    else values.push(value)
  }
  return { values, missing }
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

function confidenceFor(sampleFloor: number, minimumRuns: number): MetricResult['confidence'] {
  if (sampleFloor < minimumRuns) return 'insufficient'
  if (sampleFloor >= 10) return 'high'
  if (sampleFloor >= 5) return 'medium'
  return 'low'
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
