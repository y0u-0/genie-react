// React Native / Expo entry. No static @tanstack import, so it bundles under Metro whether or not TanStack is installed.
import { useEffect } from 'react'
import {
  createGenieClient,
  type GenieClient,
  type GenieCollector,
  sessionCollector,
} from '../client'
import { defaultAppCollectors } from '../collectors/defaults'
import { reactCollector } from '../collectors/react'
import '../collectors/react/hook'
import { queryCollector, routerCollector } from '../collectors/tanstack'
import { isQueryClient, isRouter } from '../collectors/tanstack/guards'

export interface StartGenieOptions {
  /** Hub WebSocket URL (required; RN has no location to derive it from). iOS sim: ws://localhost:4390/__genie/ws, Android emulator: ws://10.0.2.2:4390/__genie/ws, device: ws://<LAN-IP>:4390/__genie/ws. */
  url: string
  appName?: string
  plugins?: readonly string[]
  /** Pass your TanStack QueryClient to enable the query_* tools — on any later call/render too; it registers onto the running client. */
  queryClient?: unknown
  /** Pass your TanStack Router to enable the router_* tools — on any later call/render too; it registers onto the running client. */
  router?: unknown
}

let client: GenieClient | null = null
let startedUrl: string | null = null
let routerWired = false
let queryWired = false

// Typed `unknown` so the public surface never references @tanstack types; duck-checked here instead, with a loud skip on mismatch.
function tanstackCollectors(options: StartGenieOptions): GenieCollector[] {
  const collectors: GenieCollector[] = []
  if (options.router !== undefined && !routerWired) {
    if (isRouter(options.router)) {
      collectors.push(routerCollector(options.router))
      routerWired = true
    } else {
      console.warn(
        '[genie] `router` does not look like a TanStack Router (no subscribe/navigate) — router tools skipped.',
      )
    }
  }
  if (options.queryClient !== undefined && !queryWired) {
    if (isQueryClient(options.queryClient)) {
      collectors.push(queryCollector(options.queryClient))
      queryWired = true
    } else {
      console.warn(
        '[genie] `queryClient` does not look like a TanStack QueryClient (no getQueryCache) — query tools skipped.',
      )
    }
  }
  return collectors
}

/** Start Genie in a React Native / Expo app. Call once, as early as possible; later calls register newly provided TanStack instances onto the running client. */
export function startGenie(options: StartGenieOptions): GenieClient {
  if (client) {
    if (options.url !== startedUrl) {
      console.warn(`[genie] already connected to ${startedUrl} — new url ${options.url} ignored.`)
    }
    for (const collector of tanstackCollectors(options)) client.registerCollector(collector)
    return client
  }
  const collectors: GenieCollector[] = [
    sessionCollector(),
    reactCollector(),
    ...defaultAppCollectors({ plugins: options.plugins }),
    ...tanstackCollectors(options),
  ]
  client = createGenieClient({ url: options.url, appName: options.appName, collectors })
  startedUrl = options.url
  client.start()
  return client
}

export type GenieProps = StartGenieOptions

/** Component form of startGenie for wiring near the root. Renders nothing; a queryClient/router that appears on a later render still gets its tools. */
export function Genie(props: GenieProps): null {
  const { url, appName, plugins, queryClient, router } = props
  useEffect(() => {
    startGenie({ url, appName, plugins, queryClient, router })
  }, [url, appName, plugins, queryClient, router])
  return null
}
