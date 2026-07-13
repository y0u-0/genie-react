import { describe, expect, it } from 'vitest'
import { renderResult } from './agent'
import {
  summarizeCapture,
  summarizeCaptureComparison,
  summarizeCaptureList,
} from './capture-output'

describe('capture output', () => {
  it('summarizes stable and partial named captures without dumping their sections', () => {
    const artifact = {
      captureId: 'cap_123',
      name: 'before fix',
      include: ['react', 'effects'],
      consistency: { kind: 'react-commit-stable', attempts: 1, reactCommit: 7 },
      sections: { react: { status: 'ok' }, effects: { status: 'partial' } },
      complete: false,
      warnings: ['effects.react_effect_audit is unavailable'],
      sizeBytes: 12_345,
    }
    expect(summarizeCapture(artifact)).toBe(
      'capture "before fix" · stable at React commit 7 · 1/2 sections · incomplete · 12.3 KB · cap_123\n' +
        '  ! effects.react_effect_audit is unavailable',
    )
    expect(renderResult('devtools_capture_read', artifact)).not.toContain('"sections"')
    expect(summarizeCapture({ nope: true })).toBeNull()
  })

  it('lists retained captures newest first in a bounded human summary', () => {
    expect(
      summarizeCaptureList({
        total: 2,
        maxRetained: 20,
        captures: [
          {
            captureId: 'cap_new',
            name: 'after',
            consistency: { kind: 'react-commit-stable', reactCommit: 9 },
            complete: true,
            sizeBytes: 900,
          },
          {
            captureId: 'cap_old',
            name: 'before',
            consistency: { kind: 'best-effort' },
            complete: false,
            sizeBytes: 2_500,
          },
        ],
      }),
    ).toBe(
      '2 retained captures · max 20 · newest first\n' +
        '  cap_new · "after" · commit 9 · complete · 900 B\n' +
        '  cap_old · "before" · best effort · incomplete · 2.5 KB',
    )
    expect(summarizeCaptureList({ captures: [], total: 0, maxRetained: 20 })).toBe(
      'no retained captures · max 20',
    )
  })

  it('summarizes a repeated comparison as a bounded, actionable transcript', () => {
    const comparison = {
      kind: 'capture-comparison',
      comparisonId: 'cmp_123',
      overall: 'fail',
      minimumRuns: 3,
      baselineCaptureIds: ['b1', 'b2', 'b3'],
      candidateCaptureIds: ['c1', 'c2', 'c3'],
      metrics: [
        {
          metric: 'react.renders',
          verdict: 'fail',
          confidence: 'low',
          baseline: { median: 10, p95: 11, mad: 1 },
          candidate: { median: 12, p95: 13, mad: 1 },
          delta: { median: 2, regressionPct: 20 },
          budget: { metric: 'react.renders', maxRegressionPct: 10 },
          reasons: ['regression 20% exceeds maxRegressionPct 10%'],
        },
      ],
      warnings: ['Capture cohorts span two runtimes.'],
    }
    expect(summarizeCaptureComparison(comparison)).toBe(
      'FAIL comparison · 3 baseline vs 3 candidate · min 3 runs · cmp_123\n' +
        '  FAIL react.renders · median 10→12 · regression +20% · p95 11→13 · MAD 1→1 · low confidence · budget regression≤10%\n' +
        '    ! regression 20% exceeds maxRegressionPct 10%\n' +
        '  ! Capture cohorts span two runtimes.',
    )
    expect(renderResult('devtools_capture_compare', comparison)).not.toContain('"metrics"')
    expect(summarizeCaptureComparison({ nope: true })).toBeNull()
  })
})
