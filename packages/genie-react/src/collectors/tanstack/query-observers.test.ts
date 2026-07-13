import { describe, expect, it } from 'vitest'
import { summarizeQueryObserver } from './query-observers'

describe('summarizeQueryObserver', () => {
  it('reports documented result fields and never enumerates or invokes app accessors', () => {
    let accessorReads = 0
    let ownKeyReads = 0
    const options = { queryHash: 'query:1' }
    Object.defineProperty(options, 'enabled', {
      enumerable: true,
      get: () => {
        accessorReads += 1
        throw new Error('must not run')
      },
    })
    const resultTarget: Record<string, unknown> = {
      data: [],
      status: 'success',
      fetchStatus: 'idle',
    }
    Object.defineProperty(resultTarget, 'secret', {
      enumerable: true,
      get: () => {
        accessorReads += 1
        throw new Error('must not run')
      },
    })
    const result = new Proxy(resultTarget, {
      ownKeys() {
        ownKeyReads += 1
        throw new Error('must not enumerate')
      },
    })
    const query = { queryHash: 'query:1', queryKey: ['query', 1] }
    const observer = {
      options,
      getCurrentQuery: () => query,
      getCurrentResult: () => result,
      subscribe: () => () => {},
    }

    const summary = summarizeQueryObserver(observer)

    expect(summary.resultFields).toEqual(['data', 'status', 'fetchStatus'])
    expect(summary.enabled).toBe('default')
    expect(accessorReads).toBe(0)
    expect(ownKeyReads).toBe(0)
  })
})
