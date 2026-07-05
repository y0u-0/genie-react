// React Native / Expo entry. No static @tanstack import, so it bundles under Metro whether or not TanStack is installed.
import { useEffect } from 'react'
import {
  createGenieClient,
  type GenieClient,
  type GenieCollector,
  sessionCollector,
} from '../client'
import { pluginPassthroughCollector } from '../collectors/devtools-passthrough'
import { memoryCollector } from '../collectors/memory'
import { perfCollector } from '../collectors/perf'
import { reactCollector } from '../collectors/react'
import '../collectors/react/hook'
import { queryCollector, routerCollector } from '../collectors/tanstack'

export interface StartGenieOptions {
  /** Hub WebSocket URL (required; RN has no location to derive it from). iOS sim: ws://localhost:4390/__genie/ws, Android emulator: ws://10.0.2.2:4390/__genie/ws, device: ws://<LAN-IP>:4390/__genie/ws. */
  url: string
  appName?: string
  plugins?: readonly string[]
  /** Pass your TanStack QueryClient to enable the query_* tools. */
  queryClient?: unknown
  /** Pass your TanStack Router to enable the router_* tools. */
  router?: unknown
}

let client: GenieClient | null = null

/** Start Genie in a React Native / Expo app. Call once, as early as possible. Idempotent. */
export function startGenie(options: StartGenieOptions): GenieClient {
  if (client) return client

  const collectors: GenieCollector[] = [
    sessionCollector(),
    reactCollector(),
    memoryCollector(),
    perfCollector(),
    pluginPassthroughCollector({ plugins: options.plugins }),
  ]
  if (options.queryClient) {
    collectors.push(queryCollector(options.queryClient as Parameters<typeof queryCollector>[0]))
  }
  if (options.router) {
    collectors.push(routerCollector(options.router as Parameters<typeof routerCollector>[0]))
  }

  client = createGenieClient({ url: options.url, appName: options.appName, collectors })
  client.start()
  return client
}

export type GenieProps = StartGenieOptions

/** Component form of startGenie for wiring near the root. Starts once, renders nothing. */
export function Genie(props: GenieProps): null {
  useEffect(() => {
    startGenie(props)
  }, [props])
  return null
}
