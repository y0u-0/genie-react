import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFpsReport, classifyFps, estimateRefreshRate, sampleFps } from './perf'

describe('estimateRefreshRate', () => {
  it('snaps steady 16.7ms deltas to 60Hz', () => {
    expect(estimateRefreshRate(Array(30).fill(16.7))).toBe(60)
  })

  it('snaps steady 8.3ms deltas to 120Hz', () => {
    expect(estimateRefreshRate(Array(30).fill(8.3))).toBe(120)
  })

  it('reads the display rate from the fastest sustained deltas, not the janky ones', () => {
    const deltas = [...Array(20).fill(16.7), 120, 90, 250]
    expect(estimateRefreshRate(deltas)).toBe(60)
  })

  it('defaults to 60Hz with no usable deltas', () => {
    expect(estimateRefreshRate([])).toBe(60)
    expect(estimateRefreshRate([0, 0])).toBe(60)
  })
})

describe('buildFpsReport', () => {
  it('reports a clean 60fps sample with nothing dropped', () => {
    const deltas = Array(60).fill(1000 / 60)
    const report = buildFpsReport(deltas, 1000, false)
    expect(report.frames).toBe(60)
    expect(report.avgFps).toBe(60)
    expect(report.refreshRate).toBe(60)
    expect(report.longFrames).toBe(0)
    expect(report.droppedFrames).toBe(0)
    expect(report.hidden).toBe(false)
    expect(report.comparable).toBe(true)
    expect(report.notComparableReasons).toEqual([])
    expect(report.calibration).toMatchObject({
      method: 'frame-interval-distribution',
      confidence: 'high',
      sampleCount: 60,
      modesHz: [60],
    })
    expect(report.frameIntervalDistribution.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(60)
  })

  it('counts long frames and dropped frames against the frame budget', () => {
    // 57 clean frames + one 66.7ms gap (3 frames missing) + one 33.3ms gap (1 missing).
    const deltas = [...Array(57).fill(1000 / 60), 4000 / 60, 2000 / 60]
    const report = buildFpsReport(deltas, 1000, false)
    expect(report.longFrames).toBe(1)
    expect(report.droppedFrames).toBe(4)
    expect(report.worstFrameMs).toBeCloseTo(66.7, 1)
  })

  it('judges dropped frames against the estimated 120Hz budget on fast displays', () => {
    const deltas = [...Array(110).fill(1000 / 120), 4000 / 120]
    const report = buildFpsReport(deltas, 1000, false)
    expect(report.refreshRate).toBe(120)
    expect(report.droppedFrames).toBe(3)
  })

  it('refuses comparison when the inferred refresh mode changes during the sample', () => {
    const report = buildFpsReport(
      [...Array(30).fill(1000 / 120), ...Array(30).fill(1000 / 60)],
      750,
      false,
    )

    expect(report.comparable).toBe(false)
    expect(report.notComparableReasons).toContain('inferred-refresh-rate-mode-mismatch')
    expect(report.refreshRateModes).toEqual({ firstHalfHz: 120, secondHalfHz: 60 })
  })

  it('labels hidden samples and sparse calibration as unreliable evidence', () => {
    const report = buildFpsReport(Array(5).fill(1000 / 60), 100, true)

    expect(report.comparable).toBe(false)
    expect(report.notComparableReasons).toContain('document-hidden-during-sample')
    expect(report.calibration.confidence).toBe('low')
    expect(report.throttleState).toBe('visibility-throttled')
  })
})

describe('classifyFps', () => {
  const base = {
    durationMs: 1000,
    frames: 60,
    avgFps: 60,
    worstFrameMs: 17,
    longFrames: 0,
    droppedFrames: 0,
    refreshRate: 60,
    hidden: false,
  }

  it('calls a full-rate sample smooth', () => {
    expect(classifyFps(base)).toBe('smooth')
  })

  it('degrades below ~50fps on a 60Hz display, janky below half rate', () => {
    expect(classifyFps({ ...base, avgFps: 45 })).toBe('degraded')
    expect(classifyFps({ ...base, avgFps: 25 })).toBe('janky')
  })

  it('judges by ratio on a 120Hz display, not absolute fps', () => {
    expect(classifyFps({ ...base, refreshRate: 120, avgFps: 90, frames: 90 })).toBe('degraded')
    expect(classifyFps({ ...base, refreshRate: 120, avgFps: 110, frames: 110 })).toBe('smooth')
  })

  it('flags a single hard stall as janky even with a healthy average', () => {
    expect(classifyFps({ ...base, avgFps: 58, worstFrameMs: 400, longFrames: 1 })).toBe('janky')
    expect(classifyFps({ ...base, avgFps: 58, worstFrameMs: 80, longFrames: 2 })).toBe('degraded')
  })
})

describe('sampleFps', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws without requestAnimationFrame', () => {
    expect(() => sampleFps(500)).toThrow(/requestAnimationFrame/)
  })

  it('counts frames from the first rAF callback so every delta is a frame interval', async () => {
    let now = 1000
    const frame = 1000 / 60
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      now += frame
      queueMicrotask(() => cb(now))
      return 0
    })
    const report = await sampleFps(250)
    // 250ms at 60Hz = 15 frames; the first callback only anchors the clock.
    expect(report.frames).toBe(15)
    expect(report.refreshRate).toBe(60)
    expect(report.avgFps).toBe(60)
    expect(report.hidden).toBe(false)
  })
})
