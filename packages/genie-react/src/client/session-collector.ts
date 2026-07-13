import type { AppInfo } from '../protocol'
import { defineCollector, type GenieCollector } from './collector'

const REACT_DETECT_POLL_MS = 500
const REACT_DETECT_GIVE_UP_MS = 15_000

/** Always-on collector reporting app + React info; no tools — the bridge answers `devtools_status` from its hello payload. */
export function sessionCollector(): GenieCollector {
  return defineCollector({
    meta: { id: 'session', title: 'Session', description: 'App and React runtime info' },
    capabilities: ['session'],
    appInfo: () => {
      const info: Partial<AppInfo> = {}
      if (typeof location !== 'undefined') info.url = location.href
      const reactVersion = detectReactVersion()
      if (reactVersion) info.reactVersion = reactVersion
      return info
    },
    // The script-tag client says hello before React loads, so re-hello once a renderer shows up.
    start: (context) => {
      if (detectReactVersion()) return
      const startedAt = Date.now()
      const timer = setInterval(() => {
        const found = detectReactVersion() !== undefined
        if (!found && Date.now() - startedAt < REACT_DETECT_GIVE_UP_MS) return
        clearInterval(timer)
        if (found) context.refreshTools()
      }, REACT_DETECT_POLL_MS)
      return () => clearInterval(timer)
    },
  })
}

interface DevtoolsHook {
  renderers?: Map<number, { version?: string }>
}

function detectReactVersion(): string | undefined {
  const hook = getReactDevtoolsHook()
  if (!hook?.renderers) return undefined
  for (const renderer of hook.renderers.values()) {
    if (renderer.version) return renderer.version
  }
  return undefined
}

// The DevTools-injected hook is untyped from our side; the one cast to the shape we read is isolated here.
function getReactDevtoolsHook(): DevtoolsHook | undefined {
  return (globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevtoolsHook })
    .__REACT_DEVTOOLS_GLOBAL_HOOK__
}
