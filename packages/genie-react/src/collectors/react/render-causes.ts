import type { ContextDependency, Fiber, MemoizedState } from 'bippy'
import { dehydrate, type ToolOutput } from '../../protocol'
import {
  externalStoreId,
  isRegisteredQueryObserver,
  linkQueryNotificationToRender,
  linkRouterNotificationToRender,
  queryNotificationFor,
  queryObserverId,
  type RegisteredRouterStore,
  registeredRouterStore,
  registerQuerySubscriber,
  routerNotificationFor,
  type SubscriberRegistration,
} from '../causal/external-store-registry'
import {
  callObserverMethod,
  isQueryObserver,
  type QueryObserverIdentity,
  queryObserverIdentity,
} from '../causal/query-observer'
import { isDataDescriptor, safeOwnPropertyDescriptor } from './deep-diff'
import { nameOf } from './fiber'
import { type InstanceDescriptor, instanceForMountedFiber } from './instance-identity'
import { getActiveObservation, getDocumentCommitId } from './observation'
import {
  createRenderEvidenceBudget,
  diffWithBudget,
  type RenderEvidenceBudget,
  retainInputEvidence,
  scanInputEvidence,
  truncateInputScan,
} from './render-budget'
import type { reactRenderCausesContract } from './render-contract'

export type RenderCauseEvent = ToolOutput<typeof reactRenderCausesContract>['events'][number]
export type RenderCause = RenderCauseEvent['causes'][number]
export type RenderNecessity = RenderCauseEvent['necessity']
export type RenderCauseKind = RenderCause['kind']
export type RenderCauseCounts = Record<RenderCauseKind, number>

export interface PendingQuerySubscriberRegistration {
  observer: object
  subscriber: SubscriberRegistration
}

export const HOOK_WALK_LIMIT = 1_000
const STATE_VALUE_DEPTH = 2
const STATE_VALUE_MAX_ENTRIES = 20
const STATE_VALUE_MAX_STRING_LENGTH = 200
const SNAPSHOT_FIELD_OUTPUT_LIMIT = 50
const QUERY_OBSERVER_LIMIT = 200
const ROUTER_PROPERTY_SCAN_LIMIT = 200
const QUERY_SNAPSHOT_FIELDS = [
  'data',
  'dataUpdatedAt',
  'error',
  'errorUpdatedAt',
  'failureCount',
  'failureReason',
  'errorUpdateCount',
  'isError',
  'isFetched',
  'isFetchedAfterMount',
  'isFetching',
  'isLoading',
  'isPending',
  'isLoadingError',
  'isInitialLoading',
  'isPaused',
  'isPlaceholderData',
  'isRefetchError',
  'isRefetching',
  'isStale',
  'isSuccess',
  'isEnabled',
  'status',
  'fetchStatus',
  'promise',
] as const
const ROUTER_SNAPSHOT_FIELDS = [
  'location',
  'resolvedLocation',
  'matches',
  'loadedAt',
  'status',
  'isLoading',
  'href',
  'pathname',
  'search',
  'searchStr',
  'hash',
  'params',
  'routeId',
  'context',
] as const
const ROUTER_STORE_CONTAINER_FIELDS = [
  'deps',
  'store',
  'router',
  'state',
  'value',
  'current',
  'snapshot',
] as const
const RENDER_CAUSE_KINDS: RenderCauseKind[] = [
  'mount',
  'props',
  'state',
  'children',
  'context',
  'external-store',
  'query',
  'router',
  'parent',
  'unknown',
]

/** Bound causal values before retention; render tracking never pins an app's full state graph. */
export function stateValue(value: unknown, evidence?: RenderEvidenceBudget): unknown {
  if (evidence && !scanInputEvidence(evidence, 'dehydrate')) {
    return { __genie_dehydrated__: true, preview: '[omitted: commit budget]' }
  }
  try {
    const bounded = boundedStateValue(value, 0, [], new WeakSet(), evidence)
    return dehydrate(bounded, {
      depth: STATE_VALUE_DEPTH,
      maxEntries: STATE_VALUE_MAX_ENTRIES,
      maxStringLength: STATE_VALUE_MAX_STRING_LENGTH,
    })
  } catch {
    return { __genie_dehydrated__: true, preview: '[unavailable]' }
  }
}

export function emptyCauseCounts(): RenderCauseCounts {
  return Object.fromEntries(RENDER_CAUSE_KINDS.map((kind) => [kind, 0])) as RenderCauseCounts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasOwnDataProperty(value: object, key: string): boolean {
  return isDataDescriptor(safeOwnPropertyDescriptor(value, key))
}

function ownDataPropertyValue(value: object, key: string): unknown {
  const descriptor = safeOwnPropertyDescriptor(value, key)
  return isDataDescriptor(descriptor) ? descriptor.value : undefined
}

function ownArrayLength(value: unknown[]): number | null {
  const descriptor = safeOwnPropertyDescriptor(value, 'length')
  return isDataDescriptor(descriptor) && typeof descriptor.value === 'number'
    ? Math.max(0, Math.floor(descriptor.value))
    : null
}

function boundedStateValue(
  value: unknown,
  depth: number,
  path: ReadonlyArray<string | number>,
  seen: WeakSet<object>,
  evidence?: RenderEvidenceBudget,
): unknown {
  if (typeof value === 'function') {
    return dehydratedValue('function', 'ƒ anonymous()', path)
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'symbol') return dehydratedValue('symbol', value.toString(), path)
    return value
  }
  if (evidence && !scanInputEvidence(evidence, 'dehydrate')) {
    return dehydratedValue('truncated', '[omitted: commit budget]', path)
  }
  const object = value as object
  if (seen.has(object)) return dehydratedValue('circular', '[Circular]', path)

  if (!Array.isArray(value)) {
    return dehydratedValue('object', '[object fields not inspected]', path)
  }
  const length = ownArrayLength(value)
  if (depth >= STATE_VALUE_DEPTH) {
    return dehydratedValue('array', `Array(${length ?? '?'})`, path, length ?? undefined)
  }
  seen.add(object)
  try {
    return boundedArrayValue(value, depth, path, seen, evidence)
  } finally {
    seen.delete(object)
  }
}

function boundedArrayValue(
  value: unknown[],
  depth: number,
  path: ReadonlyArray<string | number>,
  seen: WeakSet<object>,
  evidence?: RenderEvidenceBudget,
): unknown[] | Record<string, unknown> {
  const length = ownArrayLength(value)
  if (length === null) return dehydratedValue('array', '[unavailable]', path)
  const result: unknown[] = []
  const limit = Math.min(length, STATE_VALUE_MAX_ENTRIES)
  for (let index = 0; index < limit; index += 1) {
    if (evidence && !scanInputEvidence(evidence, 'dehydrate')) {
      result[index] = dehydratedValue('truncated', '[omitted: commit budget]', [...path, index])
      break
    }
    const descriptor = safeOwnPropertyDescriptor(value, String(index))
    if (descriptor === null) {
      result[index] = undefined
    } else if (!isDataDescriptor(descriptor)) {
      result[index] = dehydratedValue('getter-error', '[getter not invoked]', [...path, index])
    } else {
      result[index] = boundedStateValue(
        descriptor.value,
        depth + 1,
        [...path, index],
        seen,
        evidence,
      )
    }
  }
  // A sparse length does not allocate elements, but lets the safe dehydrate pass retain exact size.
  result.length = length
  return result
}

function dehydratedValue(
  kind: string,
  preview: string,
  path: ReadonlyArray<string | number>,
  size?: number,
): Record<string, unknown> {
  return {
    __genie_dehydrated__: true,
    kind,
    preview,
    path,
    ...(size === undefined ? {} : { size }),
  }
}

function isExternalStoreHook(hook: MemoizedState | null): boolean {
  if (!hook) return false
  const queueDescriptor = safeOwnPropertyDescriptor(hook, 'queue')
  if (!isDataDescriptor(queueDescriptor) || !isRecord(queueDescriptor.value)) return false
  const valueDescriptor = safeOwnPropertyDescriptor(queueDescriptor.value, 'value')
  const snapshotDescriptor = safeOwnPropertyDescriptor(queueDescriptor.value, 'getSnapshot')
  return (
    isDataDescriptor(valueDescriptor) &&
    isDataDescriptor(snapshotDescriptor) &&
    typeof snapshotDescriptor.value === 'function'
  )
}

export function countExternalStoreHooks(fiber: Fiber): number {
  try {
    let hook: MemoizedState | null = fiber.memoizedState
    let count = 0
    let visited = 0
    while (hook && visited < HOOK_WALK_LIMIT) {
      if (isExternalStoreHook(hook)) count += 1
      const next = safeOwnPropertyDescriptor(hook, 'next')
      if (!isDataDescriptor(next) || (next.value !== null && !isRecord(next.value))) return -1
      hook = next.value as MemoizedState | null
      visited += 1
    }
    // -1 is an internal incomplete sentinel; callers cannot mistake a partial count for exact order.
    return hook === null ? count : -1
  } catch {
    return -1
  }
}

function changedSnapshotFields(
  before: unknown,
  after: unknown,
  domain: 'query' | 'router' | 'external-store',
  evidence: RenderEvidenceBudget,
): string[] {
  if (!isRecord(before) || !isRecord(after) || Array.isArray(before) || Array.isArray(after)) {
    return Object.is(before, after) ? [] : ['$value']
  }
  const keys =
    domain === 'query'
      ? QUERY_SNAPSHOT_FIELDS
      : domain === 'router'
        ? ROUTER_SNAPSHOT_FIELDS
        : ([] as const)
  if (keys.length === 0) return ['$value']
  const changed: string[] = []
  let omittedChanges = false
  for (const key of keys) {
    if (!scanInputEvidence(evidence, 'external-store-fields')) break
    const beforeDescriptor = safeOwnPropertyDescriptor(before, key)
    const afterDescriptor = safeOwnPropertyDescriptor(after, key)
    if (beforeDescriptor === undefined || afterDescriptor === undefined) {
      truncateInputScan(evidence)
      continue
    }
    if (
      (beforeDescriptor && !isDataDescriptor(beforeDescriptor)) ||
      (afterDescriptor && !isDataDescriptor(afterDescriptor))
    ) {
      truncateInputScan(evidence)
      continue
    }
    if (beforeDescriptor === null && afterDescriptor === null) continue
    if (
      beforeDescriptor === null ||
      afterDescriptor === null ||
      !Object.is(beforeDescriptor.value, afterDescriptor.value)
    ) {
      if (changed.length < SNAPSHOT_FIELD_OUTPUT_LIMIT) changed.push(key)
      else omittedChanges = true
    }
  }
  if (omittedChanges) truncateInputScan(evidence)
  return changed.length > 0 ? changed : ['$value']
}

function snapshotDomain(value: unknown): 'query' | 'router' | 'external-store' {
  if (!isRecord(value)) return 'external-store'
  if (
    hasOwnDataProperty(value, 'dataUpdatedAt') &&
    hasOwnDataProperty(value, 'fetchStatus') &&
    hasOwnDataProperty(value, 'status')
  ) {
    return 'query'
  }
  const location = ownDataPropertyValue(value, 'location')
  if (
    (hasOwnDataProperty(value, 'matches') && isRecord(location)) ||
    hasOwnDataProperty(value, 'resolvedLocation') ||
    (isRecord(location) &&
      (hasOwnDataProperty(location, 'pathname') || hasOwnDataProperty(location, 'href'))) ||
    (typeof ownDataPropertyValue(value, 'pathname') === 'string' &&
      ['href', 'routeId', 'searchStr', 'params'].some((key) => hasOwnDataProperty(value, key)))
  ) {
    return 'router'
  }
  return 'external-store'
}

/** Exact selected snapshot changes. Query/Router domains are exact only with direct runtime identity. */
export function diffExternalStoreChanges(
  fiber: Fiber,
  evidence = createRenderEvidenceBudget(),
  causalIds?: { renderEventId: string; commitId: number },
  pendingSubscribers?: PendingQuerySubscriberRegistration[],
  subscriberInstance?: InstanceDescriptor,
): RenderCause[] {
  const causes: RenderCause[] = []
  let current: MemoizedState | null = fiber.memoizedState
  let previous: MemoizedState | null = fiber.alternate?.memoizedState ?? null
  let index = 0
  let externalStoreIndex = 0
  while (current && previous && index < HOOK_WALK_LIMIT) {
    if (!scanInputEvidence(evidence, 'external-store-hooks')) break
    if (isExternalStoreHook(current) || isExternalStoreHook(previous)) {
      const selectedChanged = !Object.is(current.memoizedState, previous.memoizedState)
      if (!selectedChanged) {
        current = current.next
        previous = previous.next
        index += 1
        externalStoreIndex += 1
        continue
      }
      if (!retainInputEvidence(evidence)) {
        current = current.next
        previous = previous.next
        index += 1
        externalStoreIndex += 1
        continue
      }

      const instance = subscriberInstance ?? instanceForMountedFiber(fiber, evidence.commitWork)
      const subscriberId = `subscriber:${instance.mountId}:${externalStoreIndex}`
      const domain = snapshotDomain(current.memoizedState)
      const common = {
        hookIndex: index,
        externalStoreIndex,
        subscriberId,
        selectionEqual: false as const,
        before: stateValue(previous.memoizedState, evidence),
        after: stateValue(current.memoizedState, evidence),
        changedFields: changedSnapshotFields(
          previous.memoizedState,
          current.memoizedState,
          domain,
          evidence,
        ),
        deepDiff: diffWithBudget(previous.memoizedState, current.memoizedState, evidence),
      }

      const query = queryObserverNearHook(fiber, index, current.memoizedState, evidence)
      const router = query ? null : routerStoreNearHook(fiber, index, evidence)
      const subscriber = {
        subscriberId,
        componentId: instance.fiberId,
        componentName: nameOf(fiber),
        mountId: instance.mountId,
        hookIndex: index,
        externalStoreIndex,
        observationId: getActiveObservation()?.id ?? null,
        documentCommitId: getDocumentCommitId(),
        renderEventId: causalIds?.renderEventId ?? null,
        commitId: causalIds?.commitId ?? null,
      }
      if (query?.kind === 'single') {
        stageQuerySubscriber(query.observer, subscriber, pendingSubscribers)
        const notification = queryNotificationFor(query.observer, current.memoizedState)
        if (notification && causalIds) {
          linkQueryNotificationToRender(
            query.observer,
            notification.notificationId,
            causalIds.renderEventId,
          )
        }
        causes.push({
          kind: 'query',
          evidence: notification ? 'exact' : 'inferred',
          reason: notification ? 'query-notification-delivered' : 'query-observer-result-identity',
          ...common,
          ...query.identity,
          notificationId: notification?.notificationId ?? null,
          ...(notification
            ? {
                notification: {
                  trackedFields: notification.trackedFields,
                  trackedFieldsCoverage: notification.trackedFieldsCoverage,
                  changedResultFields: notification.changedResultFields,
                  deliveryReason: notification.deliveryReason,
                  fanout: notification.fanout,
                  structuralSharing: notification.structuralSharing,
                },
              }
            : { competingCandidates: ['query-observer-result-identity'] }),
        })
      } else if (query?.kind === 'group') {
        for (const child of query.children) {
          if (!scanInputEvidence(evidence, 'query-observers')) break
          stageQuerySubscriber(child.observer, subscriber, pendingSubscribers)
        }
        causes.push({
          kind: 'query',
          evidence: 'inferred',
          reason: 'queries-observer-result-identity',
          ...common,
          observerId: queryObserverId(query.observer),
          queries: query.children.map((child) => child.identity),
          notificationId: null,
          competingCandidates: ['queries-observer-result-identity'],
        })
      } else if (router) {
        const identityMatches = routerSnapshotMatches(router, current.memoizedState)
        const notification = identityMatches
          ? routerNotificationFor(router.store, current.memoizedState)
          : null
        if (notification && causalIds) {
          linkRouterNotificationToRender(
            router.store,
            notification.notificationId,
            causalIds.renderEventId,
          )
        }
        causes.push({
          kind: 'router',
          evidence: notification ? 'exact' : 'inferred',
          reason: notification
            ? 'router-notification-delivered'
            : identityMatches
              ? 'registered-router-store'
              : 'registered-router-store-nearby',
          ...common,
          routerId: router.routerId,
          notificationId: notification?.notificationId ?? null,
          ...(!notification
            ? {
                competingCandidates: identityMatches
                  ? ['registered-router-store']
                  : ['registered-router-store-nearby', 'router-state-shape'],
              }
            : {}),
        })
      } else if (domain === 'query') {
        causes.push({
          kind: 'query',
          evidence: 'inferred',
          reason: 'query-result-shape',
          ...common,
        })
      } else if (domain === 'router') {
        causes.push({
          kind: 'router',
          evidence: 'inferred',
          reason: 'router-state-shape',
          ...common,
        })
      } else {
        causes.push({
          kind: 'external-store',
          evidence: 'inferred',
          reason: 'external-store-snapshot-changed',
          ...common,
          ...genericExternalStoreMetadata(current),
        })
      }
      externalStoreIndex += 1
    }
    current = current.next
    previous = previous.next
    index += 1
  }
  if (current || previous) truncateInputScan(evidence)
  return causes
}

function stageQuerySubscriber(
  observer: object,
  subscriber: SubscriberRegistration,
  pending: PendingQuerySubscriberRegistration[] | undefined,
): void {
  if (pending) pending.push({ observer, subscriber })
  else registerQuerySubscriber(observer, subscriber)
}

function genericExternalStoreMetadata(hook: MemoizedState): {
  storeId: string
  storeLabel: string
  selector: null
  equality: 'object-is'
  fanout: null
  notificationId: null
  competingCandidates: string[]
} {
  const queueDescriptor = safeOwnPropertyDescriptor(hook, 'queue')
  const queue =
    isDataDescriptor(queueDescriptor) && isRecord(queueDescriptor.value)
      ? queueDescriptor.value
      : null
  const snapshotDescriptor = queue ? safeOwnPropertyDescriptor(queue, 'getSnapshot') : null
  const snapshot =
    isDataDescriptor(snapshotDescriptor) && typeof snapshotDescriptor.value === 'function'
      ? snapshotDescriptor.value
      : null
  const identity = snapshot ?? queue ?? hook
  const nameDescriptor = snapshot ? safeOwnPropertyDescriptor(snapshot, 'name') : null
  const name =
    isDataDescriptor(nameDescriptor) && typeof nameDescriptor.value === 'string'
      ? nameDescriptor.value
      : ''
  return {
    storeId: externalStoreId(identity),
    storeLabel: name || 'anonymous-external-store',
    selector: null,
    equality: 'object-is',
    fanout: null,
    notificationId: null,
    competingCandidates: ['external-store-snapshot-identity-changed'],
  }
}

interface QueryObserverMatch {
  kind: 'single'
  observer: object
  identity: QueryObserverIdentity
}

interface QueriesObserverMatch {
  kind: 'group'
  observer: object
  children: { observer: object; identity: QueryObserverIdentity }[]
}

type QueryMatch = QueryObserverMatch | QueriesObserverMatch

function queryObserverNearHook(
  fiber: Fiber,
  stopIndex: number,
  snapshot: unknown,
  evidence: RenderEvidenceBudget,
): QueryMatch | null {
  const candidates: object[] = []
  let hook: MemoizedState | null = fiber.memoizedState
  let index = 0
  while (hook && index < stopIndex && index < HOOK_WALK_LIMIT) {
    if (!scanInputEvidence(evidence, 'query-observers')) break
    if (isRecord(hook.memoizedState)) candidates.push(hook.memoizedState)
    hook = hook.next
    index += 1
  }

  for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    if (!scanInputEvidence(evidence, 'query-observers')) break
    const candidate = candidates[candidateIndex]
    if (!candidate) continue
    if (isRegisteredQueryObserver(candidate) && isQueryObserver(candidate)) {
      const currentResult = callObserverMethod(candidate, 'getCurrentResult')
      if (currentResult.ok && Object.is(currentResult.value, snapshot)) {
        return {
          kind: 'single',
          observer: candidate,
          identity: queryObserverIdentity(candidate, { includeQueryKey: false }),
        }
      }
    }

    const children = registeredQueryObserverChildren(candidate, evidence)
    if (children) {
      const currentResult = callObserverMethod(candidate, 'getCurrentResult')
      if (currentResult.ok && Object.is(currentResult.value, snapshot)) {
        return { kind: 'group', observer: candidate, children }
      }
    }
  }
  return null
}

function registeredQueryObserverChildren(
  candidate: object,
  evidence: RenderEvidenceBudget,
): QueriesObserverMatch['children'] | null {
  const childObservers = callObserverMethod(candidate, 'getObservers')
  if (!childObservers.ok || !Array.isArray(childObservers.value)) return null
  const length = ownArrayLength(childObservers.value)
  if (length === null || length === 0) return null
  const complete = length <= QUERY_OBSERVER_LIMIT
  if (!complete) truncateInputScan(evidence)
  const children: QueriesObserverMatch['children'] = []
  const limit = Math.min(length, QUERY_OBSERVER_LIMIT)
  for (let index = 0; index < limit; index += 1) {
    if (!scanInputEvidence(evidence, 'query-observers')) return null
    const descriptor = safeOwnPropertyDescriptor(childObservers.value, String(index))
    if (!isDataDescriptor(descriptor) || !isRecord(descriptor.value)) {
      if (descriptor !== null) truncateInputScan(evidence)
      return null
    }
    const observer = descriptor.value
    if (!isRegisteredQueryObserver(observer) || !isQueryObserver(observer)) return null
    children.push({
      observer,
      identity: queryObserverIdentity(observer, { includeQueryKey: false }),
    })
  }
  return complete && children.length === length ? children : null
}

function routerStoreNearHook(
  fiber: Fiber,
  stopIndex: number,
  evidence: RenderEvidenceBudget,
): RegisteredRouterStore | null {
  let match: RegisteredRouterStore | null = null
  const seen = new Set<object>()
  const searchBudget = { remaining: ROUTER_PROPERTY_SCAN_LIMIT }
  let hook: MemoizedState | null = fiber.memoizedState
  let index = 0
  while (hook && index < stopIndex && index < HOOK_WALK_LIMIT) {
    if (!scanInputEvidence(evidence, 'router-store')) break
    match =
      findRouterStore(hook.memoizedState, 3, seen, evidence, searchBudget) ??
      findRouterStore(hook.queue, 2, seen, evidence, searchBudget) ??
      match
    hook = hook.next
    index += 1
  }
  return match
}

function findRouterStore(
  value: unknown,
  depth: number,
  seen: Set<object>,
  evidence: RenderEvidenceBudget,
  searchBudget: { remaining: number },
): RegisteredRouterStore | null {
  if (!scanInputEvidence(evidence, 'router-store')) return null
  if (!isRecord(value) || seen.has(value)) return null
  const direct = registeredRouterStore(value)
  if (direct) return direct
  if (depth <= 0) return null
  seen.add(value)
  if (Array.isArray(value)) {
    const length = ownArrayLength(value)
    if (length === null || length > ROUTER_PROPERTY_SCAN_LIMIT) {
      truncateInputScan(evidence)
      return null
    }
    for (let index = 0; index < length; index += 1) {
      if (searchBudget.remaining <= 0 || !scanInputEvidence(evidence, 'router-store')) {
        truncateInputScan(evidence)
        return null
      }
      searchBudget.remaining -= 1
      const descriptor = safeOwnPropertyDescriptor(value, String(index))
      if (!isDataDescriptor(descriptor)) continue
      const nested = findRouterStore(descriptor.value, depth - 1, seen, evidence, searchBudget)
      if (nested) return nested
    }
    return null
  }
  for (const key of ROUTER_STORE_CONTAINER_FIELDS) {
    if (searchBudget.remaining <= 0 || !scanInputEvidence(evidence, 'router-store')) {
      truncateInputScan(evidence)
      return null
    }
    searchBudget.remaining -= 1
    const descriptor = safeOwnPropertyDescriptor(value, key)
    if (descriptor === undefined) {
      truncateInputScan(evidence)
      return null
    }
    if (!isDataDescriptor(descriptor)) continue
    const nested = findRouterStore(descriptor.value, depth - 1, seen, evidence, searchBudget)
    if (nested) return nested
  }
  return null
}

function routerSnapshotMatches(registration: RegisteredRouterStore, snapshot: unknown): boolean {
  if (!registration.readSnapshot) return false
  try {
    return Object.is(registration.readSnapshot(), snapshot)
  } catch {
    return false
  }
}

/** Exact consumed-context value changes retained as bounded before/after evidence. */
export function diffContextChanges(
  fiber: Fiber,
  evidence = createRenderEvidenceBudget(),
): RenderCause[] {
  const causes: RenderCause[] = []
  let current = firstContextDependency(fiber)
  let previous = firstContextDependency(fiber.alternate)
  let index = 0
  while (current && previous && index < HOOK_WALK_LIMIT) {
    if (!scanInputEvidence(evidence, 'context')) break
    // Positional evidence is exact only while both dependency buffers refer to the same Context.
    if (
      current.context === previous.context &&
      !Object.is(current.memoizedValue, previous.memoizedValue)
    ) {
      if (!retainInputEvidence(evidence)) {
        current = current.next
        previous = previous.next
        index += 1
        continue
      }
      const context = current.context as object
      const displayNameDescriptor = safeOwnPropertyDescriptor(context, 'displayName')
      const displayName = isDataDescriptor(displayNameDescriptor)
        ? displayNameDescriptor.value
        : undefined
      if (displayNameDescriptor !== null && !isDataDescriptor(displayNameDescriptor)) {
        truncateInputScan(evidence)
      }
      causes.push({
        kind: 'context',
        evidence: 'exact',
        contextIndex: index,
        name:
          typeof displayName === 'string'
            ? boundedContextName(displayName, evidence)
            : `Context[${index}]`,
        before: stateValue(previous.memoizedValue, evidence),
        after: stateValue(current.memoizedValue, evidence),
        deepDiff: diffWithBudget(previous.memoizedValue, current.memoizedValue, evidence),
      })
    }
    current = current.next
    previous = previous.next
    index += 1
  }
  if (current || previous) truncateInputScan(evidence)
  return causes
}

export function firstContextDependency(
  fiber: Fiber | null | undefined,
): ContextDependency<unknown> | null {
  return fiber?.dependencies?.firstContext ?? null
}

function boundedContextName(name: string, evidence: RenderEvidenceBudget): string {
  if (name.length <= 200) return name
  truncateInputScan(evidence)
  return `${name.slice(0, 200)}…`
}
