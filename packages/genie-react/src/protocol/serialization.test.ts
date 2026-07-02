import { describe, expect, it } from 'vitest'
import {
  DEHYDRATED,
  type DehydratedNode,
  decodeFrame,
  dehydrate,
  encodeFrame,
  isDehydratedNode,
  previewValue,
} from './serialization'

describe('encodeFrame / decodeFrame', () => {
  it('round-trips rich types through superjson', () => {
    const value = {
      date: new Date('2026-06-29T00:00:00.000Z'),
      map: new Map([['a', 1]]),
      set: new Set([1, 2, 3]),
      big: 42n,
      nope: undefined,
    }
    const decoded = decodeFrame(encodeFrame(value)) as typeof value
    expect(decoded.date).toBeInstanceOf(Date)
    expect(decoded.map).toBeInstanceOf(Map)
    expect(decoded.set).toBeInstanceOf(Set)
    expect(decoded.big).toBe(42n)
    expect('nope' in decoded).toBe(true)
  })
})

describe('dehydrate', () => {
  it('caps depth with a placeholder beyond the limit', () => {
    const result = dehydrate({ a: { b: { c: 1 } } }, { depth: 2 }) as Record<string, unknown>
    const a = result.a as Record<string, unknown>
    expect(isDehydratedNode(a.b)).toBe(true)
    expect((a.b as DehydratedNode).kind).toBe('object')
    expect((a.b as DehydratedNode).path).toEqual(['a', 'b'])
  })

  it('detects circular references', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node
    const result = dehydrate(node, { depth: 5 }) as Record<string, unknown>
    expect(isDehydratedNode(result.self)).toBe(true)
    expect((result.self as DehydratedNode).kind).toBe('circular')
  })

  it('keeps primitives and stringifies bigint for JSON safety', () => {
    expect(dehydrate(5)).toBe(5)
    expect(dehydrate(10n)).toBe('10n')
    expect(dehydrate('hi')).toBe('hi')
  })

  it('produces JSON-safe output for Map and Set (structuredContent must be JSON)', () => {
    const out = dehydrate({ m: new Map([['a', 1n]]), s: new Set([1, 2]) })
    expect(() => JSON.stringify(out)).not.toThrow()
    const typed = out as { m: { __type: string }; s: { __type: string } }
    expect(typed.m.__type).toBe('Map')
    expect(typed.s.__type).toBe('Set')
  })

  it('represents functions as placeholders', () => {
    const result = dehydrate({ fn: function greet() {} }, { depth: 2 }) as Record<string, unknown>
    expect((result.fn as DehydratedNode).kind).toBe('function')
  })

  it('re-roots at a requested path for incremental hydration', () => {
    const result = dehydrate(
      { props: { user: { name: 'Ada' } } },
      { path: ['props', 'user'], depth: 2 },
    )
    expect(result).toEqual({ name: 'Ada' })
  })

  it('reports a missing path instead of throwing', () => {
    const result = dehydrate({ a: 1 }, { path: ['a', 'b'] }) as DehydratedNode
    expect(result[DEHYDRATED]).toBe(true)
    expect(result.kind).toBe('not-found')
  })

  it('truncates oversized collections', () => {
    const big = Array.from({ length: 250 }, (_, i) => i)
    const result = dehydrate(big, { depth: 1, maxEntries: 100 }) as unknown[]
    expect(result).toHaveLength(101)
    expect((result.at(-1) as DehydratedNode).kind).toBe('truncated')
  })
})

describe('previewValue', () => {
  it('summarizes containers compactly', () => {
    expect(previewValue([1, 2, 3])).toBe('Array(3)')
    expect(previewValue(new Map([['a', 1]]))).toBe('Map(1)')
    expect(previewValue(new Set([1]))).toBe('Set(1)')
    expect(previewValue(null)).toBe('null')
  })
})
