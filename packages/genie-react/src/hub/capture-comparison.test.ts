import { describe, expect, it } from 'vitest'
import {
  type CaptureArtifact,
  type CaptureMetric,
  devtoolsCaptureCompareContract,
} from '../protocol'
import { compareCaptureCohorts, summarizeSamples } from './capture-comparison'

interface FixtureMetrics {
  commits?: number
  renders?: number
  updates?: number
  unnecessary?: number
  selfTimeMs?: number
  hotEffects?: number
  queryPending?: number
  usedHeapBytes?: number
  avgFps?: number
  droppedFrames?: number
  hidden?: boolean
}

function capture(id: string, metrics: FixtureMetrics, reactVersion = '19.2.7'): CaptureArtifact {
  const hotEffects = Array.from({ length: metrics.hotEffects ?? 0 }, () => ({
    hotness: { label: 'hot' },
  }))
  return {
    schemaVersion: '1.0',
    captureId: id,
    name: id,
    createdAt: '2026-07-13T08:00:00.000Z',
    session: { sessionId: `session-${id}`, app: { name: 'demo', reactVersion } },
    include: ['react', 'effects', 'query', 'memory', 'performance'],
    consistency: {
      kind: 'react-commit-stable',
      attempts: 1,
      reactCommit: metrics.commits ?? 1,
      reason: 'stable',
    },
    sections: {
      react: {
        status: 'ok',
        tools: {
          react_get_renders: {
            status: 'ok',
            capturedAt: '2026-07-13T08:00:00.000Z',
            durationMs: 1,
            result: {
              commits: metrics.commits,
              summary: {
                totalRenders: metrics.renders,
                totalUpdates: metrics.updates,
                semantics: 'exact',
              },
              comparable: true,
              notComparableReasons: [],
              components:
                metrics.unnecessary === undefined || metrics.selfTimeMs === undefined
                  ? []
                  : [{ unnecessary: metrics.unnecessary, selfTime: metrics.selfTimeMs }],
            },
          },
        },
      },
      effects: {
        status: 'ok',
        tools: {
          react_effect_audit: {
            status: 'ok',
            capturedAt: '2026-07-13T08:00:00.000Z',
            durationMs: 1,
            result: { components: [{ effects: hotEffects }] },
          },
        },
      },
      query: {
        status: 'ok',
        tools: {
          query_is_fetching: {
            status: 'ok',
            capturedAt: '2026-07-13T08:00:00.000Z',
            durationMs: 1,
            result:
              metrics.queryPending === undefined
                ? {}
                : { fetching: metrics.queryPending, mutating: 0 },
          },
        },
      },
      memory: {
        status: 'ok',
        tools: {
          browser_get_memory: {
            status: 'ok',
            capturedAt: '2026-07-13T08:00:00.000Z',
            durationMs: 1,
            result: { usedJSHeapSize: metrics.usedHeapBytes },
          },
        },
      },
      performance: {
        status: 'ok',
        tools: {
          browser_fps: {
            status: 'ok',
            capturedAt: '2026-07-13T08:00:00.000Z',
            durationMs: 250,
            result: {
              avgFps: metrics.avgFps,
              droppedFrames: metrics.droppedFrames,
              hidden: metrics.hidden ?? false,
              comparable: !(metrics.hidden ?? false),
              notComparableReasons: metrics.hidden ? ['document-hidden-during-sample'] : [],
              refreshRate: 60,
            },
          },
        },
      },
    },
    complete: true,
    warnings: [],
    sizeBytes: 1_000,
  }
}

function compare(
  baseline: CaptureArtifact[],
  candidate: CaptureArtifact[],
  metrics: CaptureMetric[],
  budgets: Array<{
    metric: CaptureMetric
    maxRegressionPct?: number
    maxValue?: number
    minValue?: number
  }> = [],
  minimumRuns = 3,
) {
  return compareCaptureCohorts(
    baseline,
    candidate,
    {
      baselineCaptureIds: baseline.map((item) => item.captureId),
      candidateCaptureIds: candidate.map((item) => item.captureId),
      metrics,
      minimumRuns,
      warmupRuns: 0,
      outlierThreshold: 3.5,
      confidenceLevel: 0.95,
      minimumEffectPct: 0,
      budgets,
    },
    { comparisonId: 'cmp_test', createdAt: '2026-07-13T09:00:00.000Z' },
  )
}

describe('summarizeSamples', () => {
  it('computes median, interpolated p95, and median absolute deviation', () => {
    expect(summarizeSamples([1, 2, 3, 100])).toEqual({
      samples: 4,
      median: 2.5,
      p95: 85.45,
      mad: 1,
      min: 1,
      max: 100,
    })
    expect(summarizeSamples([])).toEqual({
      samples: 0,
      median: null,
      p95: null,
      mad: null,
      min: null,
      max: null,
    })
  })
})

describe('compareCaptureCohorts', () => {
  it('rejects the minority value in a three-run zero-MAD cohort', () => {
    const baseline = [30, 30, 30].map((renders, index) => capture(`b-mad-${index}`, { renders }))
    const candidate = [2, 30, 30].map((renders, index) => capture(`c-mad-${index}`, { renders }))

    const result = compare(baseline, candidate, ['react.renders'], [], 2)

    expect(result.metrics[0]).toMatchObject({
      candidate: { samples: 2, median: 30 },
      outlierCandidateCaptureIds: ['c-mad-0'],
    })
  })

  it('defaults to five usable runs after one warm-up capture', () => {
    const parsed = devtoolsCaptureCompareContract.input.parse({
      baselineCaptureIds: ['b1'],
      candidateCaptureIds: ['c1'],
    })

    expect(parsed).toMatchObject({
      minimumRuns: 5,
      warmupRuns: 1,
      outlierThreshold: 3.5,
      confidenceLevel: 0.95,
      minimumEffectPct: 5,
    })
  })

  it('fails lower- and higher-is-better percentage budgets from cohort medians', () => {
    const baseline = [
      capture('b1', { renders: 10, avgFps: 60 }),
      capture('b2', { renders: 10, avgFps: 60 }),
      capture('b3', { renders: 10, avgFps: 60 }),
      capture('b4', { renders: 10, avgFps: 60 }),
      capture('b5', { renders: 10, avgFps: 60 }),
    ]
    const candidate = [
      capture('c1', { renders: 12, avgFps: 55 }),
      capture('c2', { renders: 12, avgFps: 55 }),
      capture('c3', { renders: 12, avgFps: 55 }),
      capture('c4', { renders: 12, avgFps: 55 }),
      capture('c5', { renders: 12, avgFps: 55 }),
    ]
    const result = compare(
      baseline,
      candidate,
      ['react.renders', 'performance.avgFps'],
      [
        { metric: 'react.renders', maxRegressionPct: 10 },
        { metric: 'performance.avgFps', maxRegressionPct: 5 },
      ],
      5,
    )

    expect(result.overall, JSON.stringify(result.metrics)).toBe('fail')
    expect(result.violations.map((violation) => violation.metric)).toEqual([
      'react.renders',
      'performance.avgFps',
    ])
    expect(result.metrics[0]).toMatchObject({
      baseline: { samples: 5, median: 10 },
      candidate: { samples: 5, median: 12 },
      delta: { median: 2, regressionPct: 20 },
      verdict: 'fail',
    })
    expect(result.metrics[1]?.delta.regressionPct).toBeCloseTo(8.3333, 4)
  })

  it('passes absolute and percentage budgets when repeated candidates improve', () => {
    const baseline = [9, 10, 11].map((renders, index) =>
      capture(`b${index}`, { renders, unnecessary: 2, selfTimeMs: 4 }),
    )
    const candidate = [7, 8, 9].map((renders, index) =>
      capture(`c${index}`, { renders, unnecessary: 0, selfTimeMs: 2 }),
    )
    const result = compare(
      baseline,
      candidate,
      ['react.renders', 'react.unnecessary'],
      [
        { metric: 'react.renders', maxRegressionPct: 0 },
        { metric: 'react.unnecessary', maxValue: 0 },
      ],
    )
    expect(result.overall).toBe('pass')
    expect(result.metrics.map((metric) => metric.verdict)).toEqual(['pass', 'pass'])
    expect(result.metrics[0]?.delta.regressionPct).toBe(-20)
  })

  it('refuses a verdict when cohorts are too small or a percentage baseline is zero', () => {
    const tooSmall = compare(
      [capture('b1', { renders: 0 }), capture('b2', { renders: 0 })],
      [capture('c1', { renders: 1 }), capture('c2', { renders: 1 })],
      ['react.renders'],
      [{ metric: 'react.renders', maxRegressionPct: 0 }],
      3,
    )
    expect(tooSmall.overall).toBe('insufficient-data')
    expect(tooSmall.metrics[0]).toMatchObject({
      verdict: 'insufficient-data',
    })

    const zeroBaseline = compare(
      [capture('b1', { renders: 0 })],
      [capture('c1', { renders: 1 })],
      ['react.renders'],
      [{ metric: 'react.renders', maxRegressionPct: 0 }],
      1,
    )
    expect(zeroBaseline.overall).toBe('insufficient-data')
    expect(zeroBaseline.metrics[0]?.delta.regressionPct).toBeNull()
  })

  it('marks hidden FPS samples missing and warns across runtime fingerprints', () => {
    const result = compare(
      [capture('b1', { avgFps: 60 }, '19.2.7')],
      [capture('c1', { avgFps: 2, hidden: true }, '20.0.0')],
      ['performance.avgFps'],
      [{ metric: 'performance.avgFps', minValue: 50 }],
      1,
    )
    expect(result.overall).toBe('not-comparable')
    expect(result.metrics[0]).toMatchObject({
      candidate: { samples: 0, median: null },
      missingCandidateCaptureIds: ['c1'],
    })
    expect(result.warnings[0]).toContain('2 runtime fingerprints')
  })

  it('excludes warm-up runs and robust zero-MAD outliers before summarizing', () => {
    const baseline = [100, 10, 10, 10, 10, 10].map((renders, index) =>
      capture(`b${index}`, { renders }),
    )
    const candidate = [200, 10, 10, 10, 10, 1000].map((renders, index) =>
      capture(`c${index}`, { renders }),
    )
    const result = compareCaptureCohorts(
      baseline,
      candidate,
      {
        baselineCaptureIds: baseline.map((item) => item.captureId),
        candidateCaptureIds: candidate.map((item) => item.captureId),
        metrics: ['react.renders'],
        minimumRuns: 4,
        warmupRuns: 1,
        outlierThreshold: 3.5,
        confidenceLevel: 0.95,
        minimumEffectPct: 5,
        budgets: [{ metric: 'react.renders', maxRegressionPct: 0 }],
      },
      { comparisonId: 'cmp_warmup', createdAt: '2026-07-13T09:00:00.000Z' },
    )

    expect(result.excluded).toMatchObject({
      warmupBaselineCaptureIds: ['b0'],
      warmupCandidateCaptureIds: ['c0'],
    })
    expect(result.metrics[0]).toMatchObject({
      baseline: { samples: 5, median: 10 },
      candidate: { samples: 4, median: 10 },
      outlierCandidateCaptureIds: ['c5'],
      verdict: 'pass',
    })
  })

  it('returns inconclusive for an A/A-sized regression inside the measured noise floor', () => {
    const baseline = [9, 11, 9, 11, 10].map((renders, index) => capture(`b${index}`, { renders }))
    const candidate = [10, 12, 10, 12, 11].map((renders, index) =>
      capture(`c${index}`, { renders }),
    )
    const result = compareCaptureCohorts(
      baseline,
      candidate,
      {
        baselineCaptureIds: baseline.map((item) => item.captureId),
        candidateCaptureIds: candidate.map((item) => item.captureId),
        metrics: ['react.renders'],
        minimumRuns: 5,
        warmupRuns: 0,
        outlierThreshold: 3.5,
        confidenceLevel: 0.95,
        minimumEffectPct: 5,
        budgets: [{ metric: 'react.renders', maxRegressionPct: 0 }],
      },
      { comparisonId: 'cmp_noise', createdAt: '2026-07-13T09:00:00.000Z' },
    )

    expect(result.overall).toBe('inconclusive')
    expect(result.metrics[0]).toMatchObject({ verdict: 'inconclusive' })
    expect(result.metrics[0]?.confidence.significant).toBe(false)
  })

  it('refuses incomplete React evidence and refresh-mode-mismatched FPS evidence', () => {
    const incomplete = capture('c-incomplete', { renders: 12 })
    const renderResult = incomplete.sections.react?.tools.react_get_renders?.result as Record<
      string,
      unknown
    >
    renderResult.comparable = false
    renderResult.notComparableReasons = ['render-input-attribution-incomplete']

    const changedMode = capture('c-mode', { avgFps: 55 })
    const fpsResult = changedMode.sections.performance?.tools.browser_fps?.result as Record<
      string,
      unknown
    >
    fpsResult.comparable = false
    fpsResult.notComparableReasons = ['inferred-refresh-rate-mode-mismatch']

    const renderComparison = compare(
      [capture('b-render', { renders: 10 })],
      [incomplete],
      ['react.renders'],
      [{ metric: 'react.renders', maxRegressionPct: 0 }],
      1,
    )
    const fpsComparison = compare(
      [capture('b-fps', { avgFps: 60 })],
      [changedMode],
      ['performance.avgFps'],
      [{ metric: 'performance.avgFps', maxRegressionPct: 0 }],
      1,
    )

    expect(renderComparison.overall).toBe('not-comparable')
    expect(renderComparison.metrics[0]?.notComparableReasons).toContain(
      'render-input-attribution-incomplete',
    )
    expect(fpsComparison.overall).toBe('not-comparable')
    expect(fpsComparison.metrics[0]?.notComparableReasons).toContain(
      'inferred-refresh-rate-mode-mismatch',
    )
  })

  it('refuses FPS cohorts whose inferred refresh rates differ between samples', () => {
    const baseline = capture('b-refresh', { avgFps: 60 })
    const candidate = capture('c-refresh', { avgFps: 120 })
    const candidateFps = candidate.sections.performance?.tools.browser_fps?.result as Record<
      string,
      unknown
    >
    candidateFps.refreshRate = 120

    const result = compare(
      [baseline],
      [candidate],
      ['performance.avgFps'],
      [{ metric: 'performance.avgFps', minValue: 50 }],
      1,
    )

    expect(result.overall).toBe('not-comparable')
    expect(result.metrics[0]?.notComparableReasons).toContain('inferred-refresh-rate-mode-mismatch')
  })

  it('refuses React cohorts collected under different coverage policies', () => {
    const baseline = capture('b-policy', { renders: 10 })
    const candidate = capture('c-policy', { renders: 10 })
    for (const [artifact, fiberLimit] of [
      [baseline, 2_000],
      [candidate, 4_000],
    ] as const) {
      const result = artifact.sections.react?.tools.react_get_renders?.result as Record<
        string,
        unknown
      >
      result.coverage = {
        complete: true,
        inputAttributionComplete: true,
        semantics: 'exact',
        coverageDomain: 'render-measurement',
        targeted: { components: ['Checkout'], roots: [7] },
        observationBudget: {
          adaptive: true,
          adaptiveScale: 1,
          fiberLimit,
          operationLimit: 20_000,
          timeLimitMs: 12,
          targetOperationReserve: 4_000,
          targetTimeReserveMs: 4,
          lifecycleBufferLimit: 2_000,
          lifecycleTargetReserve: 200,
        },
      }
    }

    const result = compare(
      [baseline],
      [candidate],
      ['react.renders'],
      [{ metric: 'react.renders', maxRegressionPct: 0 }],
      1,
    )

    expect(result.overall).toBe('not-comparable')
    expect(result.metrics[0]?.notComparableReasons).toContain(
      'render-coverage-policy-mismatch-between-cohorts',
    )
  })

  it('refuses component-derived metrics when the capture recipe truncated the component list', () => {
    const baseline = capture('b-truncated-components', {
      unnecessary: 1,
      selfTimeMs: 2,
    })
    const candidate = capture('c-truncated-components', {
      unnecessary: 1,
      selfTimeMs: 2,
    })
    const result = candidate.sections.react?.tools.react_get_renders?.result as Record<
      string,
      unknown
    >
    result.omittedByLimit = 3

    const comparison = compare(
      [baseline],
      [candidate],
      ['react.unnecessary', 'react.selfTimeMs'],
      [
        { metric: 'react.unnecessary', maxRegressionPct: 0 },
        { metric: 'react.selfTimeMs', maxRegressionPct: 0 },
      ],
      1,
    )

    expect(comparison.overall).toBe('not-comparable')
    expect(comparison.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: 'not-comparable',
          notComparableReasons: ['render-component-list-truncated'],
        }),
      ]),
    )
  })
})
