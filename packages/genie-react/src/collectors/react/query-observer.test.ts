import { describe, expect, it } from 'vitest'
import {
  callObserverMethod,
  queryNotificationPolicy,
  queryObserverIdentity,
  queryObserverOptions,
} from '../causal/query-observer'

describe('Query observer evidence', () => {
  it('reports only an identity whose public query and options agree', () => {
    const query = { queryHash: '["item",2]', queryKey: ['item', 2] }
    const observer = {
      options: { queryHash: '["item",2]', select: () => null },
      getCurrentQuery: () => query,
      getCurrentResult: () => ({}),
      subscribe: () => () => {},
    }
    expect(queryObserverIdentity(observer)).toMatchObject({
      queryHash: '["item",2]',
      queryKey: ['item', 2],
      identityStatus: 'current',
      hasSelect: true,
    })

    observer.options.queryHash = '["item",1]'
    expect(queryObserverIdentity(observer)).toMatchObject({ identityStatus: 'transitioning' })
    expect(queryObserverIdentity(observer)).not.toHaveProperty('queryHash')
  })

  it('keeps default and dynamic tracked fields explicitly unavailable', () => {
    expect(queryNotificationPolicy(undefined)).toEqual({
      mode: 'auto-tracked',
      trackedFieldsAvailable: false,
    })
    expect(queryNotificationPolicy(() => ['data'])).toEqual({
      mode: 'dynamic',
      trackedFieldsAvailable: false,
    })
    expect(queryNotificationPolicy(['data', 'status'])).toEqual({
      mode: 'fields',
      fields: ['data', 'status'],
      trackedFieldsAvailable: true,
    })
  })

  it('caps notification fields before filtering a huge sparse array', () => {
    const fields = new Array<unknown>(1_000_000)
    fields[999_999] = 'data'

    expect(queryNotificationPolicy(fields)).toEqual({
      mode: 'fields',
      fields: [],
      trackedFieldsAvailable: false,
    })
  })

  it('never invokes accessors while locating observer methods or options', () => {
    let reads = 0
    const observer = {}
    for (const key of ['getCurrentResult', 'options']) {
      Object.defineProperty(observer, key, {
        get: () => {
          reads += 1
          throw new Error('must not run')
        },
      })
    }

    expect(callObserverMethod(observer, 'getCurrentResult')).toEqual({ ok: false })
    expect(queryObserverOptions(observer)).toBeNull()
    expect(reads).toBe(0)
  })
})
