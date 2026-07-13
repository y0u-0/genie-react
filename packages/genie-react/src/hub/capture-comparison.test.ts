import { describe, expect, it } from 'vitest'
import type { CaptureArtifact, CaptureMetric } from '../protocol'
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
              },
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
  it('fails lower- and higher-is-better percentage budgets from cohort medians', () => {
    const baseline = [
      capture('b1', { renders: 9, avgFps: 61 }),
      capture('b2', { renders: 10, avgFps: 60 }),
      capture('b3', { renders: 11, avgFps: 59 }),
    ]
    const candidate = [
      capture('c1', { renders: 11, avgFps: 56 }),
      capture('c2', { renders: 12, avgFps: 55 }),
      capture('c3', { renders: 13, avgFps: 54 }),
    ]
    const result = compare(
      baseline,
      candidate,
      ['react.renders', 'performance.avgFps'],
      [
        { metric: 'react.renders', maxRegressionPct: 10 },
        { metric: 'performance.avgFps', maxRegressionPct: 5 },
      ],
    )

    expect(result.overall).toBe('fail')
    expect(result.violations.map((violation) => violation.metric)).toEqual([
      'react.renders',
      'performance.avgFps',
    ])
    expect(result.metrics[0]).toMatchObject({
      baseline: { samples: 3, median: 10 },
      candidate: { samples: 3, median: 12 },
      delta: { median: 2, regressionPct: 20 },
      confidence: 'low',
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
      confidence: 'insufficient',
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
    expect(result.overall).toBe('insufficient-data')
    expect(result.metrics[0]).toMatchObject({
      candidate: { samples: 0, median: null },
      missingCandidateCaptureIds: ['c1'],
    })
    expect(result.warnings[0]).toContain('2 runtime fingerprints')
  })
})
