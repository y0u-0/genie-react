import { GENIE_GLOBAL_KEY } from './constants'

/** Registry the client publishes on `globalThis[GENIE_GLOBAL_KEY]`; collectors are `unknown` here so core stays the dependency base. */
export interface GenieRegistry {
  register: (collector: unknown) => void
}

declare global {
  var __GENIE_REACT_AGENT__: GenieRegistry | undefined
}

/** Runtime guard for the published registry, so a foreign value on the global can't masquerade as one. */
export function isGenieRegistry(value: unknown): value is GenieRegistry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'register' in value &&
    typeof value.register === 'function'
  )
}

/** Reads the client-published registry off the global, or `undefined` when no app has mounted yet. */
export function readGenieGlobal(): GenieRegistry | undefined {
  const value: unknown = globalThis[GENIE_GLOBAL_KEY]
  return isGenieRegistry(value) ? value : undefined
}

export interface RegisterGenieCollectorOptions {
  /** Stop waiting when the script-tag client has not loaded after this long. */
  timeoutMs?: number
  /** Delay between client-readiness checks. */
  retryMs?: number
}

/** Register now when the script-tag client is ready, or keep trying for a bounded time. */
export function registerGenieCollector(
  collector: unknown,
  options: RegisterGenieCollectorOptions = {},
): () => void {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 15_000)
  const retryMs = Math.max(1, options.retryMs ?? 100)
  const deadline = Date.now() + timeoutMs
  let stopped = false
  let retry: ReturnType<typeof setTimeout> | undefined

  const attempt = () => {
    if (stopped) return
    const registry = readGenieGlobal()
    if (registry) {
      registry.register(collector)
      return
    }
    if (Date.now() < deadline) retry = setTimeout(attempt, retryMs)
  }

  attempt()
  return () => {
    stopped = true
    if (retry) clearTimeout(retry)
  }
}
