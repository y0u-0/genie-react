import type { QueryClient } from '@tanstack/react-query'
import type { AnyRouter } from '@tanstack/react-router'

// One-method duck-type: strict enough to reject foreign context values, loose enough to survive query-core minors.
export function isQueryClient(value: unknown): value is QueryClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getQueryCache' in value &&
    typeof value.getQueryCache === 'function'
  )
}

// Two-method duck-type covering what routerCollector actually calls: subscribe on start, navigate in tools.
export function isRouter(value: unknown): value is AnyRouter {
  return (
    typeof value === 'object' &&
    value !== null &&
    'subscribe' in value &&
    typeof value.subscribe === 'function' &&
    'navigate' in value &&
    typeof value.navigate === 'function'
  )
}
