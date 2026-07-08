import { type QueryClient, QueryClientContext } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useContext, useEffect } from 'react'
import { createGenieClient, sessionCollector } from '../client'
import { defaultAppCollectors } from '../collectors/defaults'
import { reactCollector } from '../collectors/react'
import { isQueryClient } from '../collectors/tanstack/guards'
import { readGenieGlobal } from '../protocol'

let started = false

export interface GenieProps {
  /** App name reported to the agent (defaults to the document title). */
  appName?: string
  /** DevTools plugin ids to surface in plugin_list before they emit any traffic. */
  plugins?: readonly string[]
  /** Explicit QueryClient for the query tools; wins over router-context and provider discovery. */
  queryClient?: QueryClient
  /** Explicit Router for the router tools; wins over `useRouter()` context discovery. */
  router?: ReturnType<typeof useRouter>
}

// useRouter's type omits `undefined`, but the Vite-plugin peer stub and the no-provider case return it; this is the single widening for that boundary.
function useOptionalRouter(): ReturnType<typeof useRouter> | undefined {
  return useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined
}

/** Reads a `QueryClient` off the router context when the app wired one in, otherwise `undefined`. */
function getRouterQueryClient(router: ReturnType<typeof useRouter>): QueryClient | undefined {
  const context: unknown = router.options.context
  if (typeof context !== 'object' || context === null || !('queryClient' in context)) {
    return undefined
  }
  return isQueryClient(context.queryClient) ? context.queryClient : undefined
}

/** One-line Genie integration: render once near the root, dev-only; auto-wires router/query collectors (explicit props win over context discovery) and joins the Vite-injected client or starts its own. */
export function Genie(props: GenieProps = {}): null {
  const { appName, plugins } = props
  const contextRouter = useOptionalRouter()
  // Provider fallback so `QueryClientProvider` alone (no router context) still surfaces the query tools; the Vite plugin stubs the context when react-query is absent.
  const providerQueryClient = useContext(QueryClientContext)

  const router = props.router ?? contextRouter
  const queryClient =
    props.queryClient ??
    (router ? getRouterQueryClient(router) : undefined) ??
    (isQueryClient(providerQueryClient) ? providerQueryClient : undefined)

  useEffect(() => {
    if (started || typeof window === 'undefined') return
    started = true

    const collectors = defaultAppCollectors({ plugins, router, queryClient })

    const existing = readGenieGlobal()
    if (existing) {
      for (const collector of collectors) existing.register(collector)
    } else {
      createGenieClient({
        appName,
        collectors: [sessionCollector(), reactCollector(), ...collectors],
      }).start()
    }
  }, [router, queryClient, appName, plugins])

  return null
}
