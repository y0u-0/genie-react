import { dehydrate } from '../../protocol'
import { registerQueryObserver } from './external-store-registry'
import { isDataDescriptor, safeOwnPropertyDescriptor } from './safe-object'

export interface QueryNotificationPolicy {
  mode: 'all' | 'fields' | 'auto-tracked' | 'dynamic'
  fields?: string[]
  trackedFieldsAvailable: boolean
}

export interface QueryObserverIdentity {
  observerId: string
  queryHash?: string
  queryKey?: unknown
  identityStatus: 'current' | 'transitioning'
  notificationPolicy: QueryNotificationPolicy
  hasSelect: boolean
}

export interface QueryObserverIdentityOptions {
  /** Query keys can contain arbitrary app objects; commit-time callers omit them. */
  includeQueryKey?: boolean
}

export function isQueryObserver(value: object): boolean {
  return (
    queryObserverOptions(value) !== null &&
    observerMethod(value, 'getCurrentResult') !== null &&
    observerMethod(value, 'getCurrentQuery') !== null &&
    observerMethod(value, 'subscribe') !== null
  )
}

export function queryObserverIdentity(
  observer: object,
  identityOptions: QueryObserverIdentityOptions = {},
): QueryObserverIdentity {
  const observerId = registerQueryObserver(observer)
  const options = queryObserverOptions(observer)
  const currentQuery = callObserverMethod(observer, 'getCurrentQuery')
  const query = currentQuery.ok && isRecord(currentQuery.value) ? currentQuery.value : null
  const optionHash = options ? dataPropertyValue(options, 'queryHash') : undefined
  const currentHash = query ? dataPropertyValue(query, 'queryHash') : undefined
  const current =
    typeof optionHash === 'string' && typeof currentHash === 'string' && optionHash === currentHash
  const queryKey = query ? dataPropertyValue(query, 'queryKey') : undefined
  const notifyOnChangeProps = options
    ? dataPropertyValue(options, 'notifyOnChangeProps')
    : undefined
  const select = options ? dataPropertyValue(options, 'select') : undefined

  return {
    observerId,
    ...(current
      ? {
          queryHash: currentHash,
          ...(identityOptions.includeQueryKey === false
            ? {}
            : { queryKey: dehydrate(queryKey, { depth: 3 }) }),
        }
      : {}),
    identityStatus: current ? 'current' : 'transitioning',
    notificationPolicy: queryNotificationPolicy(notifyOnChangeProps),
    hasSelect: typeof select === 'function',
  }
}

export function queryObserverOptions(observer: object): Record<string, unknown> | null {
  const options = dataPropertyValue(observer, 'options')
  return isRecord(options) ? options : null
}

export function queryNotificationPolicy(value: unknown): QueryNotificationPolicy {
  if (value === 'all') return { mode: 'all', trackedFieldsAvailable: true }
  if (Array.isArray(value)) {
    const fields: string[] = []
    const length = arrayLength(value)
    const limit = Math.min(length ?? 0, 100)
    for (let index = 0; index < limit; index += 1) {
      const descriptor = safeOwnPropertyDescriptor(value, String(index))
      if (isDataDescriptor(descriptor) && typeof descriptor.value === 'string') {
        fields.push(descriptor.value)
      }
    }
    return {
      mode: 'fields',
      fields,
      trackedFieldsAvailable: length !== null && length <= 100,
    }
  }
  if (typeof value === 'function') return { mode: 'dynamic', trackedFieldsAvailable: false }
  return { mode: 'auto-tracked', trackedFieldsAvailable: false }
}

export function callObserverMethod(
  object: object,
  name: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    const method = observerMethod(object, name)
    if (!method) return { ok: false }
    return { ok: true, value: method.call(object) }
  } catch {
    return { ok: false }
  }
}

const METHOD_PROTOTYPE_LIMIT = 8

function observerMethod(object: object, name: string): ((...args: unknown[]) => unknown) | null {
  let current: object | null = object
  for (let depth = 0; current && depth < METHOD_PROTOTYPE_LIMIT; depth += 1) {
    const descriptor = safeOwnPropertyDescriptor(current, name)
    if (descriptor === undefined) return null
    if (descriptor !== null) {
      return isDataDescriptor(descriptor) && typeof descriptor.value === 'function'
        ? (descriptor.value as (...args: unknown[]) => unknown)
        : null
    }
    try {
      current = Object.getPrototypeOf(current) as object | null
    } catch {
      return null
    }
  }
  return null
}

function dataPropertyValue(object: object, name: string): unknown {
  const descriptor = safeOwnPropertyDescriptor(object, name)
  return isDataDescriptor(descriptor) ? descriptor.value : undefined
}

function arrayLength(value: unknown[]): number | null {
  const descriptor = safeOwnPropertyDescriptor(value, 'length')
  return isDataDescriptor(descriptor) && typeof descriptor.value === 'number'
    ? Math.max(0, Math.floor(descriptor.value))
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
