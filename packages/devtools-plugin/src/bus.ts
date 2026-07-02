// TanStack DevTools' event-client API is alpha and in flux, so we tap its underlying bus channels instead; every operation degrades to a no-op when no bus (or DOM) is present.

const GLOBAL_CHANNEL = 'tanstack-devtools-global'
const DISPATCH_CHANNEL = 'tanstack-dispatch-event'

export interface DevtoolsBusEvent {
  type: string
  payload?: unknown
  pluginId?: string
}

declare global {
  /** Injected by @tanstack/devtools-event-bus; `undefined` when no DevTools bus (or DOM) is present. */
  var __TANSTACK_EVENT_TARGET__: EventTarget | undefined
}

/** Runtime guard so a foreign `detail` on the bus channel can't masquerade as a plugin event. */
function isDevtoolsBusEvent(value: unknown): value is DevtoolsBusEvent {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  )
}

function resolveBusTarget(): EventTarget | null {
  try {
    const injected = globalThis.__TANSTACK_EVENT_TARGET__
    if (injected && typeof injected.addEventListener === 'function') return injected
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      return window
    }
  } catch {
    return null
  }
  return null
}

export function subscribeToDevtoolsBus(onEvent: (event: DevtoolsBusEvent) => void): () => void {
  const target = resolveBusTarget()
  if (!target) return () => {}

  const handler = (event: Event) => {
    try {
      // `in`-narrowing reads `detail` even off cross-realm CustomEvents, where `instanceof` fails.
      const detail: unknown = 'detail' in event ? event.detail : undefined
      if (isDevtoolsBusEvent(detail)) onEvent(detail)
    } catch {}
  }

  try {
    target.addEventListener(GLOBAL_CHANNEL, handler)
  } catch {
    return () => {}
  }

  return () => {
    try {
      target.removeEventListener(GLOBAL_CHANNEL, handler)
    } catch {}
  }
}

/** Only the genuine injected bus — never the window fallback — so emits can't falsely report success. */
function resolveRealBus(): EventTarget | null {
  try {
    const injected = globalThis.__TANSTACK_EVENT_TARGET__
    if (injected && typeof injected.dispatchEvent === 'function') return injected
  } catch {
    return null
  }
  return null
}

export function emitToDevtoolsBus(event: DevtoolsBusEvent): boolean {
  // The boolean means a real bus was present — not dispatchEvent's return, which is true even with no listeners.
  const target = resolveRealBus()
  if (!target || typeof CustomEvent === 'undefined') return false
  try {
    target.dispatchEvent(new CustomEvent(DISPATCH_CHANNEL, { detail: event }))
    return true
  } catch {
    return false
  }
}

export function pluginIdFromEvent(event: DevtoolsBusEvent): string {
  if (event.pluginId) return event.pluginId
  const separator = event.type.indexOf(':')
  return separator > 0 ? event.type.slice(0, separator) : 'unknown'
}
