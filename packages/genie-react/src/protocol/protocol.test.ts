import { describe, expect, it } from 'vitest'
import { decodeAgentBoundMessage, decodeAppBoundMessage, encodeMessage, newId } from './protocol'

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
