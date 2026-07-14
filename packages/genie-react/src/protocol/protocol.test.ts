import { describe, expect, it } from 'vitest'
import {
  agentMessageSchema,
  appMessageSchema,
  decodeAgentBoundMessage,
  decodeAppBoundMessage,
  encodeMessage,
  newId,
} from './protocol'
import { decodeFrame } from './serialization'
import {
  CAPTURE_METRICS,
  captureArtifactSchema,
  captureComparisonSchema,
  devtoolsCaptureCompareContract,
  devtoolsCaptureCreateContract,
  devtoolsCapturePinContract,
  devtoolsCaptureReadContract,
  devtoolsInteractionBeginContract,
  devtoolsInteractionStopContract,
  devtoolsWaitContract,
} from './tools'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const richPayload = () => ({
  when: new Date('2026-06-29T12:00:00.000Z'),
  counts: new Map<string, bigint>([['a', 1n]]),
  tags: new Set([1, 2, 3]),
  big: 9007199254740993n,
})

const expectRich = (payload: ReturnType<typeof richPayload>) => {
  expect(payload.when).toBeInstanceOf(Date)
  expect(payload.when.toISOString()).toBe('2026-06-29T12:00:00.000Z')
  expect(payload.counts).toBeInstanceOf(Map)
  expect(payload.counts.get('a')).toBe(1n)
  expect(payload.tags).toBeInstanceOf(Set)
  expect(payload.big).toBe(9007199254740993n)
}

describe('protocol codecs', () => {
  it('round-trips superjson-rich app-bound (bridge → app) requests', () => {
    const frame = encodeMessage({
      kind: 'bridge/request',
      id: 'q-1',
      tool: 'query_set_data',
      args: richPayload(),
    })
    const decoded = decodeAppBoundMessage(frame)
    expect(decoded.kind).toBe('bridge/request')
    if (decoded.kind !== 'bridge/request') throw new Error('unreachable')
    expectRich(decoded.args as ReturnType<typeof richPayload>)
  })

  it('round-trips superjson-rich agent-bound (bridge → agent) results', () => {
    const frame = encodeMessage({
      kind: 'bridge/result',
      id: 'a-1',
      ok: true,
      result: richPayload(),
    })
    const decoded = decodeAgentBoundMessage(frame)
    expect(decoded.kind).toBe('bridge/result')
    if (decoded.kind !== 'bridge/result') throw new Error('unreachable')
    expectRich(decoded.result as ReturnType<typeof richPayload>)
  })

  it('rejects an unknown discriminant on every boundary', () => {
    const bogus = encodeMessage({ kind: 'app/bogus', anything: true })
    expect(() => decodeAppBoundMessage(bogus)).toThrow()
    expect(() => decodeAgentBoundMessage(bogus)).toThrow()
  })

  it('accepts an app/heartbeat frame', () => {
    const parsed = appMessageSchema.parse({ kind: 'app/heartbeat', sessionId: 's-1' })
    expect(parsed.kind).toBe('app/heartbeat')
  })

  it('carries an optional machine-readable app error code', () => {
    const parsed = appMessageSchema.parse({
      kind: 'app/response',
      id: 'r-invalid',
      ok: false,
      error: 'bad arguments',
      errorCode: 'invalid-args',
    })
    expect(parsed).toMatchObject({ errorCode: 'invalid-args' })
    expect(() =>
      appMessageSchema.parse({
        kind: 'app/response',
        id: 'r-invalid',
        ok: false,
        errorCode: 'busy',
      }),
    ).toThrow()
  })

  it('accepts readiness and rejects unsafe session names', () => {
    expect(appMessageSchema.parse({ kind: 'app/ready', sessionId: 's-1' }).kind).toBe('app/ready')
    expect(() =>
      appMessageSchema.parse({
        kind: 'app/hello',
        protocol: 1,
        sessionId: 's-1',
        logicalSessionId: 'logical-1',
        documentGeneration: 1,
        sessionName: 'review\nspoofed',
        app: {},
        capabilities: [],
        tools: [],
      }),
    ).toThrow()
  })

  it('carries errorCode + retryInMs on a bridge/result and stays backward-compatible without them', () => {
    const tagged = decodeAgentBoundMessage(
      encodeMessage({
        kind: 'bridge/result',
        id: 'r-1',
        ok: false,
        error: 'busy',
        errorCode: 'busy',
        retryInMs: 500,
      }),
    )
    if (tagged.kind !== 'bridge/result') throw new Error('unreachable')
    expect(tagged.errorCode).toBe('busy')
    expect(tagged.retryInMs).toBe(500)

    const plain = decodeAgentBoundMessage(
      encodeMessage({ kind: 'bridge/result', id: 'r-2', ok: true, result: { a: 1 } }),
    )
    if (plain.kind !== 'bridge/result') throw new Error('unreachable')
    expect(plain.errorCode).toBeUndefined()
    expect(plain.retryInMs).toBeUndefined()
  })

  it('rejects an unknown errorCode on a bridge/result', () => {
    expect(() =>
      decodeAgentBoundMessage(
        encodeMessage({ kind: 'bridge/result', id: 'r-3', ok: false, errorCode: 'nope' }),
      ),
    ).toThrow()
  })

  it('carries an optional timeoutMs on an agent/invoke frame', () => {
    const frame = encodeMessage({
      kind: 'agent/invoke',
      id: 'i-1',
      tool: 'react_get_tree',
      args: {},
      timeoutMs: 5000,
    })
    const parsed = agentMessageSchema.parse(decodeFrame(frame))
    if (parsed.kind !== 'agent/invoke') throw new Error('unreachable')
    expect(parsed.timeoutMs).toBe(5000)
  })
})

describe('newId', () => {
  it('returns a v4-shaped uuid', () => {
    expect(newId()).toMatch(UUID_V4)
  })

  it('returns a distinct id on each call', () => {
    const ids = new Set(Array.from({ length: 64 }, () => newId()))
    expect(ids.size).toBe(64)
    for (const id of ids) expect(id).toMatch(UUID_V4)
  })
})

describe('capture protocol', () => {
  it('applies bounded defaults and rejects ambiguous or terminal-unsafe names', () => {
    expect(devtoolsCaptureCreateContract.input.parse({ name: 'before fix' })).toEqual({
      name: 'before fix',
      include: ['react', 'effects', 'query', 'router', 'memory'],
      maxAttempts: 3,
    })
    expect(() =>
      devtoolsCaptureCreateContract.input.parse({
        name: 'duplicate domains',
        include: ['react', 'react'],
      }),
    ).toThrow()
    expect(() => devtoolsCaptureCreateContract.input.parse({ name: 'spoofed\noutput' })).toThrow()
    expect(() =>
      devtoolsCaptureCreateContract.input.parse({ name: 'valid', unexpected: true }),
    ).toThrow()
  })

  it('validates a stable schema-versioned artifact shape', () => {
    expect(
      captureArtifactSchema.parse({
        schemaVersion: '1.0',
        captureId: 'cap_1',
        name: 'baseline',
        createdAt: '2026-07-13T08:00:00.000Z',
        session: { sessionId: 's-1', app: { name: 'demo' } },
        include: ['react'],
        consistency: {
          kind: 'react-commit-stable',
          attempts: 1,
          reactCommit: 4,
          reason: 'stable',
        },
        sections: {
          react: {
            status: 'ok',
            tools: {
              react_get_renders: {
                status: 'ok',
                capturedAt: '2026-07-13T08:00:00.000Z',
                durationMs: 2,
                result: { commits: 4 },
              },
            },
          },
        },
        complete: true,
        warnings: [],
        sizeBytes: 512,
      }),
    ).toMatchObject({ schemaVersion: '1.0', captureId: 'cap_1' })
  })

  it('defaults capture reads to summaries and validates pinning', () => {
    expect(devtoolsCaptureReadContract.input.parse({ captureId: 'cap_1' })).toEqual({
      captureId: 'cap_1',
      view: 'summary',
    })
    expect(() =>
      devtoolsCaptureReadContract.input.parse({
        captureId: 'cap_1',
        sections: ['react'],
      }),
    ).toThrow(/sections requires view/)
    expect(devtoolsCapturePinContract.input.parse({ captureId: 'cap_1' })).toEqual({
      captureId: 'cap_1',
      pinned: true,
    })
  })

  it('defaults repeated comparisons and rejects ambiguous cohorts or budgets', () => {
    expect(
      devtoolsCaptureCompareContract.input.parse({
        baselineCaptureIds: ['cap_before'],
        candidateCaptureIds: ['cap_after'],
      }),
    ).toEqual({
      baselineCaptureIds: ['cap_before'],
      candidateCaptureIds: ['cap_after'],
      metrics: [...CAPTURE_METRICS],
      minimumRuns: 5,
      warmupRuns: 1,
      outlierThreshold: 3.5,
      confidenceLevel: 0.95,
      minimumEffectPct: 5,
      budgets: [],
    })

    expect(() =>
      devtoolsCaptureCompareContract.input.parse({
        baselineCaptureIds: ['cap_same'],
        candidateCaptureIds: ['cap_same'],
      }),
    ).toThrow(/cannot overlap/)
    expect(() =>
      devtoolsCaptureCompareContract.input.parse({
        baselineCaptureIds: ['cap_before'],
        candidateCaptureIds: ['cap_after'],
        metrics: ['react.renders'],
        budgets: [{ metric: 'performance.avgFps', minValue: 55 }],
      }),
    ).toThrow(/must also be requested/)
    expect(() =>
      devtoolsCaptureCompareContract.input.parse({
        baselineCaptureIds: ['cap_before'],
        candidateCaptureIds: ['cap_after'],
        metrics: ['react.renders'],
        budgets: [{ metric: 'react.renders' }],
      }),
    ).toThrow(/requires maxRegressionPct/)
  })

  it('validates the stable machine-readable comparison envelope', () => {
    expect(
      captureComparisonSchema.parse({
        schemaVersion: '1.0',
        kind: 'capture-comparison',
        comparisonId: 'cmp_1',
        createdAt: '2026-07-13T09:00:00.000Z',
        minimumRuns: 5,
        policy: {
          warmupRuns: 1,
          outlierThreshold: 3.5,
          confidenceLevel: 0.95,
          minimumEffectPct: 5,
        },
        excluded: {
          warmupBaselineCaptureIds: [],
          warmupCandidateCaptureIds: [],
        },
        baselineCaptureIds: ['cap_before'],
        candidateCaptureIds: ['cap_after'],
        overall: 'informational',
        metrics: [],
        violations: [],
        warnings: [],
      }),
    ).toMatchObject({ kind: 'capture-comparison', comparisonId: 'cmp_1' })
  })
})

describe('wait protocol', () => {
  it('defaults to a bounded React settle scope and validates multi-domain requests', () => {
    expect(devtoolsWaitContract.input.parse({ condition: 'settled' })).toMatchObject({
      condition: 'settled',
      domains: ['react'],
      quietMs: 500,
      timeoutMs: 10_000,
    })
    expect(() =>
      devtoolsWaitContract.input.parse({
        condition: 'settled',
        domains: ['react', 'react'],
      }),
    ).toThrow()
    expect(() =>
      devtoolsWaitContract.input.parse({
        condition: 'component',
        name: 'Map',
        domains: ['query'],
      }),
    ).toThrow()
  })
})

describe('interaction protocol', () => {
  it('bounds targeted observation and settle inputs', () => {
    expect(devtoolsInteractionBeginContract.input.parse({ name: 'open details' })).toMatchObject({
      name: 'open details',
      components: [],
      roots: [],
      lifecycle: { bufferLimit: 1_000, targetReserve: 100 },
    })
    expect(devtoolsInteractionStopContract.input.parse({ interactionId: 'int_1' })).toEqual({
      interactionId: 'int_1',
      domains: ['react'],
      quietMs: 500,
      timeoutMs: 10_000,
    })
    expect(() =>
      devtoolsInteractionStopContract.input.parse({
        interactionId: 'int_1',
        domains: ['react', 'react'],
      }),
    ).toThrow()
  })
})
