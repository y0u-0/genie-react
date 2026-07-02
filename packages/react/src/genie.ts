import { createGenieClient, type GenieCollector, sessionCollector } from '@genie-react/client'
import { readGenieGlobal } from '@genie-react/core'
import { pluginPassthroughCollector } from '@genie-react/devtools-plugin'
import { memoryCollector } from '@genie-react/memory'
import { reactCollector } from '@genie-react/react-collector'
import { queryCollector, routerCollector } from '@genie-react/tanstack-collector'
import type { QueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'

let started = false

export interface GenieProps {
  /** App name reported to the agent (defaults to the document title). */
  appName?: string
}

// useRouter's type omits `undefined`, but the Vite-plugin peer stub and the no-provider case return it; this is the single widening for that boundary.
function useOptionalRouter(): ReturnType<typeof useRouter> | undefined {
  return useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined
}

// One-method duck-type: strict enough to reject foreign context values, loose enough to survive query-core minors.
function isQueryClient(value: unknown): value is QueryClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getQueryCache' in value &&
    typeof value.getQueryCache === 'function'
  )
}

/** Reads a `QueryClient` off the router context when the app wired one in, otherwise `undefined`. */
function getRouterQueryClient(router: ReturnType<typeof useRouter>): QueryClient | undefined {
  const context: unknown = router.options.context
  if (typeof context !== 'object' || context === null || !('queryClient' in context)) {
    return undefined
  }
  return isQueryClient(context.queryClient) ? context.queryClient : undefined
}

/** One-line Genie integration: render once near the root, dev-only; auto-wires router/query collectors and joins the Vite-injected client or starts its own. */
export function Genie({ appName }: GenieProps = {}): null {
  const router = useOptionalRouter()

  useEffect(() => {
    if (started || typeof window === 'undefined') return
    started = true

    const collectors: GenieCollector[] = [memoryCollector(), pluginPassthroughCollector()]
    if (router) {
      collectors.push(routerCollector(router))
      const queryClient = getRouterQueryClient(router)
      if (queryClient) collectors.push(queryCollector(queryClient))
    }

    const existing = readGenieGlobal()
    if (existing) {
      for (const collector of collectors) existing.register(collector)
    } else {
      createGenieClient({
        appName,
        collectors: [sessionCollector(), reactCollector(), ...collectors],
      }).start()
    }
  }, [router, appName])

  return null
}
