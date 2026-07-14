import { z } from 'zod'
import { dehydrate } from '../../protocol'
import {
  queryObservedTracking,
  querySubscriberObservationFor,
} from '../causal/external-store-registry'
import {
  callObserverMethod,
  queryObserverIdentity,
  queryObserverOptions,
} from '../causal/query-observer'
import { isDataDescriptor, safeOwnPropertyDescriptor } from '../causal/safe-object'

export const QUERY_OBSERVER_LIMIT = 100

const QUERY_RESULT_FIELDS = [
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
  'refetch',
  'status',
  'fetchStatus',
  'promise',
  'fetchNextPage',
  'fetchPreviousPage',
  'hasNextPage',
  'hasPreviousPage',
  'isFetchNextPageError',
  'isFetchingNextPage',
  'isFetchPreviousPageError',
  'isFetchingPreviousPage',
] as const

export const queryObserverSummarySchema = z.object({
  observerId: z.string(),
  identityStatus: z.enum(['current', 'transitioning']),
  notificationPolicy: z.object({
    mode: z.enum(['all', 'fields', 'auto-tracked', 'dynamic']),
    fields: z.array(z.string()).optional(),
    trackedFieldsAvailable: z.boolean(),
  }),
  deliveryEvidence: z.enum([
    'policy-explicit',
    'public-track-prop-observed',
    'unavailable-private-tracking',
  ]),
  hasSelect: z.boolean(),
  enabled: z.union([z.boolean(), z.enum(['default', 'dynamic'])]),
  currentResult: z.unknown(),
  resultFields: z.array(z.string()),
  subscriberObservationStatus: z
    .enum(['current-observation', 'previous-observation', 'no-active-observation', 'not-observed'])
    .describe(
      'Whether the component subscriber was observed in the current react_clear_renders window, only in an earlier window, before any window started, or not at all.',
    ),
  subscriber: z
    .object({
      subscriberId: z.string(),
      componentId: z.number().int(),
      componentName: z.string(),
      mountId: z.string(),
      hookIndex: z.number().int().nonnegative(),
      externalStoreIndex: z.number().int().nonnegative(),
      observationId: z
        .string()
        .nullable()
        .describe('The react_clear_renders observation where this subscriber was last seen.'),
      documentCommitId: z
        .number()
        .int()
        .nonnegative()
        .describe('The document-wide React commit where this subscriber was last seen.'),
      renderEventId: z
        .string()
        .nullable()
        .describe('The exact retained render event, or null for legacy/unjoined evidence.'),
      commitId: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .describe('The resettable profile commit for the joined render event.'),
    })
    .nullable(),
})

function knownQueryResult(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const result: Record<string, unknown> = {}
  for (const key of QUERY_RESULT_FIELDS) {
    const descriptor = safeOwnPropertyDescriptor(value, key)
    if (isDataDescriptor(descriptor)) result[key] = descriptor.value
  }
  return result
}

export function summarizeQueryObserver(observer: object) {
  const subscriberObservation = querySubscriberObservationFor(observer)
  const identity = queryObserverIdentity(observer)
  const observedTracking = queryObservedTracking(observer)
  const notificationPolicy =
    identity.notificationPolicy.mode === 'auto-tracked' && observedTracking.coverage === 'exact'
      ? {
          ...identity.notificationPolicy,
          fields: observedTracking.fields,
          trackedFieldsAvailable: true,
        }
      : identity.notificationPolicy
  const options = queryObserverOptions(observer)
  const current = callObserverMethod(observer, 'getCurrentResult')
  const currentResult = current.ok ? current.value : undefined
  const retainedResult = knownQueryResult(currentResult)
  const resultFields = retainedResult ? Object.keys(retainedResult) : []
  const enabledDescriptor = options ? safeOwnPropertyDescriptor(options, 'enabled') : null
  const enabled = isDataDescriptor(enabledDescriptor) ? enabledDescriptor.value : undefined
  const enabledState: boolean | 'default' | 'dynamic' =
    typeof enabled === 'boolean' ? enabled : typeof enabled === 'function' ? 'dynamic' : 'default'
  return {
    observerId: identity.observerId,
    identityStatus: identity.identityStatus,
    notificationPolicy,
    deliveryEvidence:
      identity.notificationPolicy.mode === 'all' || identity.notificationPolicy.mode === 'fields'
        ? ('policy-explicit' as const)
        : observedTracking.coverage === 'exact'
          ? ('public-track-prop-observed' as const)
          : ('unavailable-private-tracking' as const),
    hasSelect: identity.hasSelect,
    enabled: enabledState,
    currentResult: dehydrate(retainedResult, { depth: 2 }),
    resultFields,
    subscriberObservationStatus: subscriberObservation.status,
    subscriber: subscriberObservation.subscriber,
  }
}
