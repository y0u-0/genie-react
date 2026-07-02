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
