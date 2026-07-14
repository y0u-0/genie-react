/** Neutral causal identity shared by React and TanStack collectors. */

import { publishEffectConsequence } from './effect-consequence'
import { isDataDescriptor, safeOwnPropertyDescriptor } from './safe-object'

export interface SubscriberReference {
  subscriberId: string
  componentId: number
  componentName: string
  mountId: string
  hookIndex: number
  externalStoreIndex: number
  observationId: string | null
  documentCommitId: number
  renderEventId: string | null
  commitId: number | null
}

export type SubscriberRegistration = Omit<SubscriberReference, 'renderEventId' | 'commitId'> & {
  renderEventId?: string | null
  commitId?: number | null
}

export type SubscriberObservationStatus =
  | 'current-observation'
  | 'previous-observation'
  | 'no-active-observation'
  | 'not-observed'

export interface SubscriberObservation {
  status: SubscriberObservationStatus
  subscriber: SubscriberReference | null
}

export interface ExternalStoreObservation {
  id: string
}

export interface RouterStoreReference {
  routerId: string
}

export interface RegisteredRouterStore extends RouterStoreReference {
  store: object
  readSnapshot: (() => unknown) | null
}

export interface QueryNotificationEvent {
  notificationId: string
  observerId: string
  observationId: string | null
  timestamp: number
  trackedFields: string[]
  trackedFieldsCoverage: 'exact' | 'unavailable'
  changedResultFields: string[]
  deliveryReason: string
  fanout: number
  structuralSharing: {
    reusedFields: string[]
    changedFields: string[]
    truncated: boolean
  }
  renderEventIds: string[]
}

interface RetainedQueryNotification extends QueryNotificationEvent {
  observer: object
  resultReference: unknown
}

export interface RouterNotificationEvent {
  notificationId: string
  routerId: string
  observationId: string | null
  timestamp: number
  renderEventIds: string[]
}

interface RetainedRouterNotification extends RouterNotificationEvent {
  store: object
  snapshotReference: unknown
}

let queryObserverSequence = 0
let routerSequence = 0
let queryNotificationSequence = 0
let routerNotificationSequence = 0
let externalStoreSequence = 0
let activeObservationId: string | null = null
const queryObserverIds = new WeakMap<object, string>()
const querySubscribers = new WeakMap<object, SubscriberReference>()
const routerStores = new WeakMap<object, RegisteredRouterStore>()
let externalStoreIds = new WeakMap<object, string>()
let latestQueryNotifications = new WeakMap<object, RetainedQueryNotification>()
let latestRouterNotifications = new WeakMap<object, RetainedRouterNotification>()
let registeredQueryObservers = new WeakSet<object>()
let instrumentedQueryObservers = new WeakMap<object, () => void>()
let observedQueryTracking = new WeakMap<object, { fields: Set<string>; exact: boolean }>()
const queryNotifications: RetainedQueryNotification[] = []
const routerNotifications: RetainedRouterNotification[] = []
const NOTIFICATION_LIMIT = 1_000
const FIELD_LIMIT = 50

export function queryObserverId(observer: object): string {
  const existing = queryObserverIds.get(observer)
  if (existing) return existing
  queryObserverSequence += 1
  const created = `query-observer:${queryObserverSequence}`
  queryObserverIds.set(observer, created)
  return created
}

/** Mark an observer whose identity came from the TanStack Query collector, not Fiber duck typing. */
export function registerQueryObserver(observer: object): string {
  registeredQueryObservers.add(observer)
  return queryObserverId(observer)
}

export function isRegisteredQueryObserver(observer: object): boolean {
  return registeredQueryObservers.has(observer)
}

export function registerQuerySubscriber(
  observer: object,
  subscriber: SubscriberRegistration,
): string {
  const observerId = registerQueryObserver(observer)
  querySubscribers.set(observer, {
    ...subscriber,
    renderEventId: subscriber.renderEventId ?? null,
    commitId: subscriber.commitId ?? null,
  })
  return observerId
}

export function querySubscriberFor(observer: object): SubscriberReference | null {
  const subscriber = querySubscribers.get(observer)
  return subscriber ? { ...subscriber } : null
}

/** Set the explicit measurement window used to classify retained subscriber evidence. */
export function setExternalStoreObservation(observation: ExternalStoreObservation | null): void {
  activeObservationId = observation?.id ?? null
}

export function querySubscriberObservationFor(observer: object): SubscriberObservation {
  const subscriber = querySubscriberFor(observer)
  if (!subscriber) return { status: 'not-observed', subscriber: null }
  if (activeObservationId === null) {
    return { status: 'no-active-observation', subscriber }
  }
  return {
    status:
      subscriber.observationId === activeObservationId
        ? 'current-observation'
        : 'previous-observation',
    subscriber,
  }
}

export function recordQueryNotification(
  observer: object,
  before: unknown,
  after: unknown,
  metadata: {
    trackedFields: string[]
    trackedFieldsCoverage: 'exact' | 'unavailable'
    fanout: number
  },
): QueryNotificationEvent {
  queryNotificationSequence += 1
  const fields = changedAndReusedFields(before, after)
  const event: RetainedQueryNotification = {
    notificationId: `query-notification:${queryNotificationSequence}`,
    observerId: queryObserverId(observer),
    observationId: activeObservationId,
    timestamp: Date.now(),
    trackedFields: metadata.trackedFields.slice(0, FIELD_LIMIT),
    trackedFieldsCoverage: metadata.trackedFieldsCoverage,
    changedResultFields: fields.changed,
    deliveryReason: queryDeliveryReason(
      fields.changed,
      metadata.trackedFields,
      metadata.trackedFieldsCoverage,
    ),
    fanout: Math.max(0, Math.floor(metadata.fanout)),
    structuralSharing: {
      reusedFields: fields.reused,
      changedFields: fields.changed,
      truncated: fields.truncated,
    },
    renderEventIds: [],
    observer,
    resultReference: after,
  }
  latestQueryNotifications.set(observer, event)
  queryNotifications.push(event)
  if (queryNotifications.length > NOTIFICATION_LIMIT) queryNotifications.shift()
  publishEffectConsequence('query-notification', event.notificationId)
  return publicQueryNotification(event)
}

export function queryNotificationFor(
  observer: object,
  resultReference: unknown,
): QueryNotificationEvent | null {
  const event = latestQueryNotifications.get(observer)
  return event && Object.is(event.resultReference, resultReference)
    ? publicQueryNotification(event)
    : null
}

export function linkQueryNotificationToRender(
  observer: object,
  notificationId: string,
  renderEventId: string,
): void {
  const event = latestQueryNotifications.get(observer)
  if (!event || event.notificationId !== notificationId) return
  if (!event.renderEventIds.includes(renderEventId) && event.renderEventIds.length < FIELD_LIMIT) {
    event.renderEventIds.push(renderEventId)
  }
}

export function listQueryNotifications(options: { observerId?: string; limit: number }): {
  events: QueryNotificationEvent[]
  omittedByLimit: number
} {
  const matching = queryNotifications.filter(
    (event) => options.observerId === undefined || event.observerId === options.observerId,
  )
  return {
    events: matching.slice(-options.limit).reverse().map(publicQueryNotification),
    omittedByLimit: Math.max(0, matching.length - options.limit),
  }
}

/** Observe public QueryObserver tracking plus its listener Set without replacing subscriptions. */
export function instrumentQueryObserver(observer: object): () => void {
  const existing = instrumentedQueryObservers.get(observer)
  if (existing) return existing
  const trackedFields = new Set<string>()
  const tracking = { fields: trackedFields, exact: false }
  observedQueryTracking.set(observer, tracking)
  const restores: (() => void)[] = []
  let lastResult = callObjectMethod(observer, 'getCurrentResult')

  const trackProp = findDataMethod(observer, 'trackProp')
  if (trackProp) {
    const originalDescriptor = safeOwnPropertyDescriptor(observer, 'trackProp')
    try {
      Object.defineProperty(observer, 'trackProp', {
        configurable: true,
        writable: true,
        value(this: unknown, key: unknown) {
          if (typeof key === 'string' && trackedFields.size < FIELD_LIMIT) trackedFields.add(key)
          if (typeof key === 'string') tracking.exact = true
          return trackProp.apply(this, [key])
        },
      })
      restores.push(() => restoreOwnProperty(observer, 'trackProp', originalDescriptor))
    } catch {
      // Observer remains usable; tracked fields stay explicitly unavailable.
    }
  }

  const listenersDescriptor = safeOwnPropertyDescriptor(observer, 'listeners')
  const listeners = isDataDescriptor(listenersDescriptor) ? listenersDescriptor.value : null
  if (listeners instanceof Set) {
    const originalDescriptor = safeOwnPropertyDescriptor(listeners, 'forEach')
    const originalForEach = listeners.forEach
    try {
      Object.defineProperty(listeners, 'forEach', {
        configurable: true,
        writable: true,
        value(
          this: Set<unknown>,
          callback: (value: unknown, key: unknown, set: Set<unknown>) => void,
          thisArg?: unknown,
        ) {
          const currentResult = callObjectMethod(observer, 'getCurrentResult')
          if (currentResult.ok) {
            const currentTracking = queryTrackingFor(observer, tracking)
            recordQueryNotification(
              observer,
              lastResult.ok ? lastResult.value : undefined,
              currentResult.value,
              {
                trackedFields: currentTracking.fields,
                trackedFieldsCoverage: currentTracking.exact ? 'exact' : 'unavailable',
                fanout: this.size,
              },
            )
            lastResult = currentResult
          }
          return originalForEach.call(this, callback, thisArg)
        },
      })
      restores.push(() => restoreOwnProperty(listeners, 'forEach', originalDescriptor))
    } catch {
      // Delivery remains unavailable rather than risking observer behavior.
    }
  }

  const cleanup = (): void => {
    for (const restore of restores.reverse()) restore()
    instrumentedQueryObservers.delete(observer)
    observedQueryTracking.delete(observer)
  }
  instrumentedQueryObservers.set(observer, cleanup)
  return cleanup
}

export function queryObservedTracking(observer: object): {
  fields: string[]
  coverage: 'exact' | 'unavailable'
} {
  const tracking = queryTrackingFor(observer, observedQueryTracking.get(observer))
  return {
    fields: tracking.fields,
    coverage: tracking.exact ? 'exact' : 'unavailable',
  }
}

function queryTrackingFor(
  observer: object,
  observed: { fields: Set<string>; exact: boolean } | undefined,
): { fields: string[]; exact: boolean } {
  const explicit = explicitQueryTracking(observer)
  if (explicit.exact) return explicit
  return {
    fields: observed ? [...observed.fields] : [],
    exact: observed?.exact ?? false,
  }
}

function explicitQueryTracking(observer: object): {
  fields: string[]
  exact: boolean
} {
  const optionsDescriptor = safeOwnPropertyDescriptor(observer, 'options')
  const options = isDataDescriptor(optionsDescriptor) ? optionsDescriptor.value : null
  if (typeof options !== 'object' || options === null) {
    return { fields: [], exact: false }
  }
  const policyDescriptor = safeOwnPropertyDescriptor(options, 'notifyOnChangeProps')
  const policy = isDataDescriptor(policyDescriptor) ? policyDescriptor.value : undefined
  if (policy === 'all') return { fields: ['*'], exact: true }
  if (!Array.isArray(policy)) return { fields: [], exact: false }
  const fields: string[] = []
  const lengthDescriptor = safeOwnPropertyDescriptor(policy, 'length')
  const length =
    isDataDescriptor(lengthDescriptor) && typeof lengthDescriptor.value === 'number'
      ? Math.min(FIELD_LIMIT, Math.max(0, Math.floor(lengthDescriptor.value)))
      : null
  if (length === null) return { fields, exact: false }
  for (let index = 0; index < length; index += 1) {
    const descriptor = safeOwnPropertyDescriptor(policy, String(index))
    if (isDataDescriptor(descriptor) && typeof descriptor.value === 'string') {
      fields.push(descriptor.value)
    }
  }
  return { fields, exact: true }
}

function queryDeliveryReason(
  changedFields: string[],
  trackedFields: string[],
  coverage: 'exact' | 'unavailable',
): string {
  if (coverage !== 'exact') return 'observer-notified'
  const tracked = new Set(trackedFields)
  const changed = tracked.has('*')
    ? changedFields[0]
    : changedFields.find((field) => tracked.has(field))
  return changed ? `tracked-field-changed:${changed.slice(0, 100)}` : 'observer-notified'
}

function findDataMethod(
  object: object,
  key: PropertyKey,
): ((...args: unknown[]) => unknown) | null {
  let current: object | null = object
  for (let depth = 0; current && depth < 6; depth += 1) {
    const descriptor = safeOwnPropertyDescriptor(current, key)
    if (isDataDescriptor(descriptor) && typeof descriptor.value === 'function') {
      return descriptor.value as (...args: unknown[]) => unknown
    }
    try {
      current = Object.getPrototypeOf(current) as object | null
    } catch {
      return null
    }
  }
  return null
}

function callObjectMethod(
  object: object,
  key: PropertyKey,
): { ok: true; value: unknown } | { ok: false } {
  const method = findDataMethod(object, key)
  if (!method) return { ok: false }
  try {
    return { ok: true, value: method.call(object) }
  } catch {
    return { ok: false }
  }
}

function restoreOwnProperty(
  object: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | null | undefined,
): void {
  try {
    if (descriptor && descriptor !== undefined) Object.defineProperty(object, key, descriptor)
    else Reflect.deleteProperty(object, key)
  } catch {
    // Cleanup is best effort; the original behavior was retained by closure while active.
  }
}

export function recordRouterNotification(
  store: object,
  snapshot: unknown,
): RouterNotificationEvent {
  const registration = registeredRouterStore(store) ?? registerRouterStore(store)
  routerNotificationSequence += 1
  const event: RetainedRouterNotification = {
    notificationId: `router-notification:${routerNotificationSequence}`,
    routerId: registration.routerId,
    observationId: activeObservationId,
    timestamp: Date.now(),
    renderEventIds: [],
    store,
    snapshotReference: snapshot,
  }
  latestRouterNotifications.set(store, event)
  routerNotifications.push(event)
  if (routerNotifications.length > NOTIFICATION_LIMIT) routerNotifications.shift()
  publishEffectConsequence('router-notification', event.notificationId)
  return publicRouterNotification(event)
}

export function routerNotificationFor(
  store: object,
  snapshotReference: unknown,
): RouterNotificationEvent | null {
  const event = latestRouterNotifications.get(store)
  return event && Object.is(event.snapshotReference, snapshotReference)
    ? publicRouterNotification(event)
    : null
}

export function linkRouterNotificationToRender(
  store: object,
  notificationId: string,
  renderEventId: string,
): void {
  const event = latestRouterNotifications.get(store)
  if (!event || event.notificationId !== notificationId) return
  if (!event.renderEventIds.includes(renderEventId) && event.renderEventIds.length < FIELD_LIMIT) {
    event.renderEventIds.push(renderEventId)
  }
}

export function externalStoreId(store: object): string {
  const existing = externalStoreIds.get(store)
  if (existing) return existing
  externalStoreSequence += 1
  const created = `external-store:${externalStoreSequence}`
  externalStoreIds.set(store, created)
  return created
}

function publicQueryNotification(event: RetainedQueryNotification): QueryNotificationEvent {
  const { observer: _observer, resultReference: _resultReference, ...publicEvent } = event
  return structuredClone(publicEvent)
}

function publicRouterNotification(event: RetainedRouterNotification): RouterNotificationEvent {
  const { store: _store, snapshotReference: _snapshotReference, ...publicEvent } = event
  return structuredClone(publicEvent)
}

function changedAndReusedFields(
  before: unknown,
  after: unknown,
): { changed: string[]; reused: string[]; truncated: boolean } {
  if (!isPlainRecord(before) || !isPlainRecord(after)) {
    return Object.is(before, after)
      ? { changed: [], reused: ['$value'], truncated: false }
      : { changed: ['$value'], reused: [], truncated: false }
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const changed: string[] = []
  const reused: string[] = []
  for (const key of keys.slice(0, FIELD_LIMIT)) {
    if (Object.is(before[key], after[key])) reused.push(key)
    else changed.push(key)
  }
  return { changed, reused, truncated: keys.length > FIELD_LIMIT }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function registerRouterStore(
  store: object,
  readSnapshot?: () => unknown,
): RouterStoreReference {
  const existing = routerStores.get(store)
  if (existing) {
    if (readSnapshot) existing.readSnapshot = readSnapshot
    return { routerId: existing.routerId }
  }
  routerSequence += 1
  const created: RegisteredRouterStore = {
    routerId: `router:${routerSequence}`,
    store,
    readSnapshot: readSnapshot ?? null,
  }
  routerStores.set(store, created)
  return { routerId: created.routerId }
}

export function routerStoreReference(value: object): RouterStoreReference | null {
  const registration = routerStores.get(value)
  return registration ? { routerId: registration.routerId } : null
}

export function registeredRouterStore(value: object): RegisteredRouterStore | null {
  return routerStores.get(value) ?? null
}

/** Test-only reset. WeakMap entries expire naturally; counters and observation state reset. */
export function resetExternalStoreRegistryForTests(): void {
  queryObserverSequence = 0
  routerSequence = 0
  queryNotificationSequence = 0
  routerNotificationSequence = 0
  externalStoreSequence = 0
  activeObservationId = null
  registeredQueryObservers = new WeakSet()
  instrumentedQueryObservers = new WeakMap()
  observedQueryTracking = new WeakMap()
  latestQueryNotifications = new WeakMap()
  latestRouterNotifications = new WeakMap()
  externalStoreIds = new WeakMap()
  queryNotifications.length = 0
  routerNotifications.length = 0
}
