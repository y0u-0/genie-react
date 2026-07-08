import type { QueryClient } from '@tanstack/react-query'
import type { AnyRouter } from '@tanstack/react-router'
import type { GenieCollector } from '../client'
import { pluginPassthroughCollector } from './devtools-passthrough'
import { memoryCollector } from './memory'
import { perfCollector } from './perf'
import { queryCollector, routerCollector } from './tanstack'

export interface DefaultCollectorOptions {
  plugins?: readonly string[]
  queryClient?: QueryClient
  router?: AnyRouter
}

/** Every collector wired beyond the session/react core — the single list the web and native entries share, so a new default ships to both platforms at once. */
export function defaultAppCollectors(options: DefaultCollectorOptions): GenieCollector[] {
  const collectors: GenieCollector[] = [
    memoryCollector(),
    perfCollector(),
    pluginPassthroughCollector({ plugins: options.plugins }),
  ]
  if (options.router) collectors.push(routerCollector(options.router))
  if (options.queryClient) collectors.push(queryCollector(options.queryClient))
  return collectors
}
