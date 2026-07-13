import { describe, expect, it } from 'vitest'
import { deepDiff } from './deep-diff'

describe('deepDiff', () => {
  it('reports nested array value, addition, and removal paths as JSON Pointers', () => {
    const result = deepDiff([['first', 1], 'removed'], [['first', 2, 'added']])

    expect(result).toEqual({
      changes: [
        { kind: 'value', path: '/length', before: 2, after: 1 },
        { kind: 'value', path: '/0/length', before: 2, after: 3 },
        { kind: 'value', path: '/0/1', before: 1, after: 2 },
        { kind: 'added', path: '/0/2', after: 'added' },
        { kind: 'removed', path: '/1', before: 'removed' },
      ],
      visited: 8,
      truncated: false,
    })
  })

  it('reports the narrowest reference-only path for a deep-equal array replacement', () => {
    const shared = ['stable']
    const result = deepDiff([['dark'], shared], [['dark'], shared])

    expect(result.changes).toEqual([{ kind: 'reference-only', path: '/0' }])
    expect(result.truncated).toBe(false)
  })

  it('never invokes accessors and marks arbitrary objects incomplete', () => {
    let reads = 0
    const before = Object.defineProperty({}, 'computed', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'before'
      },
    })
    const after = Object.defineProperty({}, 'computed', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'after'
      },
    })

    expect(deepDiff(before, after)).toMatchObject({
      changes: [{ kind: 'reference-only', path: '' }],
      truncated: true,
    })
    expect(reads).toBe(0)
  })

  it('bounds a huge array before walking its entries', () => {
    const before = Array.from({ length: 10_000 }, (_, index) => index)
    const after = before.slice()
    after[0] = -1

    const result = deepDiff(before, after, { maxVisited: 4 })

    expect(result.changes).toContainEqual({ kind: 'value', path: '/0', before: 0, after: -1 })
    expect(result.visited).toBeLessThanOrEqual(4)
    expect(result.truncated).toBe(true)
  })

  it('reports sparse array length changes as value changes', () => {
    const before: unknown[] = []
    const after: unknown[] = []
    before.length = 1
    after.length = 100

    expect(deepDiff(before, after)).toEqual({
      changes: [{ kind: 'value', path: '/length', before: 1, after: 100 }],
      visited: 2,
      truncated: false,
    })
  })

  it('never reads accessor-backed array entries', () => {
    let reads = 0
    const before: unknown[] = []
    const after: unknown[] = []
    for (const value of [before, after]) {
      Object.defineProperty(value, '0', {
        enumerable: true,
        configurable: true,
        get: () => {
          reads += 1
          return value === before ? 'before' : 'after'
        },
      })
      value.length = 1
    }

    expect(deepDiff(before, after)).toMatchObject({
      changes: [{ kind: 'reference-only', path: '/0' }],
      truncated: true,
    })
    expect(reads).toBe(0)
  })

  it('guards array cycles by object pair without treating them as truncation', () => {
    const before: unknown[] = []
    const after: unknown[] = []
    before.push(before)
    after.push(after)

    const result = deepDiff(before, after)
    expect(result.changes).toEqual([{ kind: 'reference-only', path: '/0' }])
    expect(result.truncated).toBe(false)
  })

  it.each([
    [new Date(0), new Date(1)],
    [new Map([['key', 1]]), new Map([['key', 2]])],
    [new Set([1]), new Set([2])],
    [() => 1, () => 2],
    [
      new (class Value {
        count = 1
      })(),
      new (class Value {
        count = 2
      })(),
    ],
  ])('marks unsupported changed references incomplete', (before, after) => {
    expect(deepDiff(before, after)).toMatchObject({
      changes: [{ kind: 'reference-only', path: '' }],
      truncated: true,
    })
  })

  it('does not invoke a Proxy ownKeys trap during deep analysis', () => {
    let ownKeyReads = 0
    const proxy = (value: number) =>
      new Proxy(
        { value },
        {
          ownKeys() {
            ownKeyReads += 1
            throw new Error('must not enumerate app objects')
          },
        },
      )

    expect(deepDiff(proxy(1), proxy(2)).truncated).toBe(true)
    expect(ownKeyReads).toBe(0)
  })

  it('keeps non-JSON numeric changes unambiguous on the wire', () => {
    expect(deepDiff(Number.NaN, Number.POSITIVE_INFINITY).changes).toEqual([
      {
        kind: 'value',
        path: '',
        before: { type: 'number', value: 'NaN' },
        after: { type: 'number', value: 'Infinity' },
      },
    ])
    expect(deepDiff(-0, 0).changes[0]).toMatchObject({
      before: { type: 'number', value: '-0' },
      after: 0,
    })
  })

  it('marks a depth-limited branch as truncated instead of claiming a deep value change', () => {
    const result = deepDiff([[1]], [[2]], { maxDepth: 1 })

    expect(result).toEqual({
      changes: [{ kind: 'reference-only', path: '/0' }],
      visited: 2,
      truncated: true,
    })
  })

  it('stops at the work budget and reports how much it inspected', () => {
    const result = deepDiff([1, 1], [2, 2], { maxVisited: 2 })

    expect(result).toEqual({
      changes: [{ kind: 'value', path: '/0', before: 1, after: 2 }],
      visited: 2,
      truncated: true,
    })
  })

  it('caps output without doing unbounded work after the change budget is exhausted', () => {
    const result = deepDiff([1, 1, 1], [2, 2, 2], { maxChanges: 1 })

    expect(result.changes).toEqual([{ kind: 'value', path: '/0', before: 1, after: 2 }])
    expect(result.visited).toBe(3)
    expect(result.truncated).toBe(true)
  })

  it('bounds retained scalar text', () => {
    const long = 'x'.repeat(10_000)
    const result = deepDiff([long], [`${long}changed`])

    const change = result.changes[0]
    expect(change).toMatchObject({
      before: { type: 'string', truncated: true },
      after: { type: 'string', truncated: true },
    })
    expect(result.truncated).toBe(true)
  })

  it('does not stringify arbitrarily large bigints', () => {
    const result = deepDiff(10n ** 10_000n, -(10n ** 10_000n))

    expect(result.changes[0]).toMatchObject({
      before: { type: 'bigint', value: '[large]' },
      after: { type: 'bigint', value: '-[large]' },
    })
    expect(result.truncated).toBe(true)
  })

  it('shares one work budget across several comparisons', () => {
    const budget = { remainingVisited: 2, remainingChanges: 2 }
    expect(deepDiff([1], [2], { budget }).truncated).toBe(false)
    const second = deepDiff([1], [2], { budget })

    expect(second.visited).toBe(0)
    expect(second.truncated).toBe(true)
  })
})
