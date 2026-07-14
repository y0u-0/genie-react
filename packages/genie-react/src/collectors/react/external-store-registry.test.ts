import { beforeEach, describe, expect, it } from 'vitest'
import {
  isRegisteredQueryObserver,
  queryNotificationFor,
  queryObserverId,
  querySubscriberFor,
  querySubscriberObservationFor,
  recordQueryNotification,
  registeredRouterStore,
  registerQueryObserver,
  registerQuerySubscriber,
  registerRouterStore,
  resetExternalStoreRegistryForTests,
  routerStoreReference,
  setExternalStoreObservation,
} from '../causal/external-store-registry'

beforeEach(() => resetExternalStoreRegistryForTests())

describe('external store identity registry', () => {
  it('distinguishes assigned IDs from explicitly registered Query observers', () => {
    const observer = {}
    queryObserverId(observer)
    expect(isRegisteredQueryObserver(observer)).toBe(false)

    registerQueryObserver(observer)
    expect(isRegisteredQueryObserver(observer)).toBe(true)
  })

  it('keeps stable document-local Query observer and Router store IDs', () => {
    const observer = {}
    const store = {}
    expect(queryObserverId(observer)).toBe('query-observer:1')
    expect(queryObserverId(observer)).toBe('query-observer:1')
    expect(registerRouterStore(store)).toEqual({ routerId: 'router:1' })
    expect(routerStoreReference(store)).toEqual({ routerId: 'router:1' })
  })

  it('joins a live Query observer to its latest component subscriber', () => {
    const observer = {}
    registerQuerySubscriber(observer, {
      subscriberId: 'subscriber:mount:1:0',
      componentId: 7,
      componentName: 'Todos',
      mountId: 'mount:1',
      hookIndex: 3,
      externalStoreIndex: 0,
      observationId: 'observation:1',
      documentCommitId: 7,
      renderEventId: 'render:7:1',
      commitId: 3,
    })
    expect(querySubscriberFor(observer)).toEqual({
      subscriberId: 'subscriber:mount:1:0',
      componentId: 7,
      componentName: 'Todos',
      mountId: 'mount:1',
      hookIndex: 3,
      externalStoreIndex: 0,
      observationId: 'observation:1',
      documentCommitId: 7,
      renderEventId: 'render:7:1',
      commitId: 3,
    })
  })

  it('marks retained subscriber evidence as previous as soon as a new observation starts', () => {
    const observer = {}
    setExternalStoreObservation({ id: 'observation:1' })
    registerQuerySubscriber(observer, {
      subscriberId: 'subscriber:mount:1:0',
      componentId: 7,
      componentName: 'Todos',
      mountId: 'mount:1',
      hookIndex: 3,
      externalStoreIndex: 0,
      observationId: 'observation:1',
      documentCommitId: 7,
    })

    expect(querySubscriberObservationFor(observer)).toMatchObject({
      status: 'current-observation',
      subscriber: { observationId: 'observation:1', documentCommitId: 7 },
    })

    setExternalStoreObservation({ id: 'observation:2' })
    expect(querySubscriberObservationFor(observer)).toMatchObject({
      status: 'previous-observation',
      subscriber: { observationId: 'observation:1', documentCommitId: 7 },
    })

    registerQuerySubscriber(observer, {
      subscriberId: 'subscriber:mount:1:0',
      componentId: 7,
      componentName: 'Todos',
      mountId: 'mount:1',
      hookIndex: 3,
      externalStoreIndex: 0,
      observationId: 'observation:2',
      documentCommitId: 8,
    })
    expect(querySubscriberObservationFor(observer)).toMatchObject({
      status: 'current-observation',
      subscriber: { observationId: 'observation:2', documentCommitId: 8 },
    })
  })

  it('updates the registered Router snapshot reader without changing identity', () => {
    const store = {}
    registerRouterStore(store)
    registerRouterStore(store, () => 'current')

    expect(registeredRouterStore(store)?.routerId).toBe('router:1')
    expect(registeredRouterStore(store)?.readSnapshot?.()).toBe('current')
  })

  it('joins only the exact delivered Query result identity to a notification ID', () => {
    const observer = {}
    const before = { data: { id: 1 }, status: 'success' }
    const after = { data: before.data, status: 'success', isFetching: false }
    registerQueryObserver(observer)

    const event = recordQueryNotification(observer, before, after, {
      trackedFields: ['data', 'isFetching'],
      trackedFieldsCoverage: 'exact',
      fanout: 1,
    })

    expect(event).toMatchObject({
      notificationId: 'query-notification:1',
      observerId: 'query-observer:1',
      trackedFields: ['data', 'isFetching'],
      changedResultFields: ['isFetching'],
      structuralSharing: { reusedFields: ['data', 'status'], changedFields: ['isFetching'] },
    })
    expect(queryNotificationFor(observer, after)?.notificationId).toBe('query-notification:1')
    expect(queryNotificationFor(observer, { ...after })).toBeNull()
  })
})
