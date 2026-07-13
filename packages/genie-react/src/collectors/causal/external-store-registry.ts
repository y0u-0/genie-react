/** Neutral causal identity shared by React and TanStack collectors. */
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
  readSnapshot: (() => unknown) | null
}

let queryObserverSequence = 0
let routerSequence = 0
let activeObservationId: string | null = null
const queryObserverIds = new WeakMap<object, string>()
const querySubscribers = new WeakMap<object, SubscriberReference>()
const routerStores = new WeakMap<object, RegisteredRouterStore>()
let registeredQueryObservers = new WeakSet<object>()

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
  activeObservationId = null
  registeredQueryObservers = new WeakSet()
}
