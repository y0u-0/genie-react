import {
  ClassComponentTag,
  type Fiber,
  getRDTHook,
  instrument,
  type MemoizedState,
  SuspenseComponentTag,
} from 'bippy'
import { contextDependencies, hookChain, nameOf } from './fiber'

// Dev-only live overrides via the dev-renderer contract React DevTools uses; context has no renderer override, so it edits the nearest Provider's `value` prop; forced-fiber membership is always checked against both double-buffer fibers.

/** The dev-build renderer methods these overrides need, structurally compatible with bippy's ReactRenderer. */
export interface DevRenderer {
  scheduleUpdate?: (fiber: Fiber) => void
  setSuspenseHandler?: (shouldSuspend: (instance: unknown) => boolean) => void
  setErrorHandler?: (shouldError: (fiber: Fiber) => boolean) => void
  overrideHookState?: (fiber: Fiber, hookId: string, path: string[], value: unknown) => void
  overrideProps?: (fiber: Fiber, path: string[], value: unknown) => void
}

type DevCapability =
  | 'setSuspenseHandler'
  | 'setErrorHandler'
  | 'overrideHookState'
  | 'overrideProps'

function requireRenderer(capability: DevCapability): DevRenderer {
  const hook = getRDTHook()
  for (const renderer of hook?.renderers?.values() ?? []) {
    if (typeof renderer.scheduleUpdate === 'function' && typeof renderer[capability] === 'function')
      return renderer
  }
  throw new Error(
    `The React renderer does not expose ${capability} — live overrides need a development build of react-dom 18+; a production build cannot be driven.`,
  )
}

const isForced = (fibers: ReadonlySet<Fiber>, fiber: Fiber): boolean =>
  fibers.has(fiber) || (fiber.alternate !== null && fibers.has(fiber.alternate))

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Applies pre-merged props in ONE renderer call — dev `overrideProps` rebuilds `pendingProps` from `memoizedProps` on every call, so per-key calls would clobber each other. */
export function overrideFiberProps(
  fiber: Fiber,
  partial: Record<string, unknown>,
  renderer: DevRenderer = requireRenderer('overrideProps'),
): void {
  const current = isPlainObject(fiber.memoizedProps) ? fiber.memoizedProps : {}
  renderer.overrideProps?.(fiber, [], { ...current, ...partial })
}

// ── Unmount pruning ──────────────────────────────────────────────────────────

const forcedSuspense = new Set<Fiber>()
const forcedErrors = new Map<Fiber, boolean>()

let unmountPruningInstalled = false

function ensureUnmountPruning(): void {
  if (unmountPruningInstalled) return
  unmountPruningInstalled = true
  instrument({
    name: 'genie-overrides',
    onCommitFiberUnmount: (_rendererId, fiber) => dropForced(fiber),
  })
}

function dropForced(fiber: Fiber): void {
  forcedSuspense.delete(fiber)
  forcedErrors.delete(fiber)
  if (fiber.alternate) {
    forcedSuspense.delete(fiber.alternate)
    forcedErrors.delete(fiber.alternate)
  }
}

// ── Suspense fallback forcing ────────────────────────────────────────────────

const suspenseHandlerInstalled = new WeakSet<DevRenderer>()

export function findSuspenseBoundary(fiber: Fiber): Fiber | null {
  let current: Fiber | null = fiber
  while (current && current.tag !== SuspenseComponentTag) current = current.return
  return current
}

export interface BoundaryToggle {
  boundary: Fiber
  active: number
}

export function applySuspenseOverride(
  target: Fiber,
  showFallback: boolean,
  renderer: DevRenderer = requireRenderer('setSuspenseHandler'),
): BoundaryToggle {
  const boundary = findSuspenseBoundary(target)
  if (!boundary)
    throw new Error(
      `No <Suspense> boundary at or above ${nameOf(target)} — pass the id of a component rendered inside one, or a boundaryId from react_error_state.`,
    )
  if (!suspenseHandlerInstalled.has(renderer)) {
    renderer.setSuspenseHandler?.((instance) => isForced(forcedSuspense, instance as Fiber))
    suspenseHandlerInstalled.add(renderer)
  }
  if (showFallback) {
    ensureUnmountPruning()
    if (!isForced(forcedSuspense, boundary)) forcedSuspense.add(boundary)
  } else {
    if (!isForced(forcedSuspense, boundary)) return { boundary, active: forcedSuspense.size }
    forcedSuspense.delete(boundary)
    if (boundary.alternate) forcedSuspense.delete(boundary.alternate)
  }
  renderer.scheduleUpdate?.(boundary)
  return { boundary, active: forcedSuspense.size }
}

// ── Error boundary forcing ───────────────────────────────────────────────────

const errorHandlerInstalled = new WeakSet<DevRenderer>()

export function isErrorBoundaryFiber(fiber: Fiber): boolean {
  if (fiber.tag !== ClassComponentTag) return false
  const ctor = fiber.type as { getDerivedStateFromError?: unknown } | null
  const instance = fiber.stateNode as { componentDidCatch?: unknown } | null
  return (
    typeof ctor?.getDerivedStateFromError === 'function' ||
    typeof instance?.componentDidCatch === 'function'
  )
}

export function findErrorBoundary(fiber: Fiber): Fiber | null {
  let current: Fiber | null = fiber
  while (current && !isErrorBoundaryFiber(current)) current = current.return
  return current
}

const forcedErrorKeyOf = (fiber: Fiber): Fiber | null => {
  if (forcedErrors.has(fiber)) return fiber
  if (fiber.alternate && forcedErrors.has(fiber.alternate)) return fiber.alternate
  return null
}

// true forces the catch; false resets exactly once then self-clears (back to real errors only); absent returns null, which React's dev contract treats as "no override".
const shouldForceError = (fiber: Fiber): boolean | null => {
  const key = forcedErrorKeyOf(fiber)
  if (!key) return null
  const forced = forcedErrors.get(key) ?? null
  if (forced === false) forcedErrors.delete(key)
  return forced
}

const activeErrorCount = (): number => [...forcedErrors.values()].filter(Boolean).length

export function applyErrorOverride(
  target: Fiber,
  forceError: boolean,
  renderer: DevRenderer = requireRenderer('setErrorHandler'),
): BoundaryToggle {
  const boundary = findErrorBoundary(target)
  if (!boundary)
    throw new Error(
      `No error boundary at or above ${nameOf(target)} — an error boundary is a class component with getDerivedStateFromError or componentDidCatch (e.g. react-error-boundary's <ErrorBoundary>).`,
    )
  if (!errorHandlerInstalled.has(renderer)) {
    // React's dev contract also accepts null ("no override"); bippy's type is narrower than the contract.
    renderer.setErrorHandler?.(shouldForceError as (fiber: Fiber) => boolean)
    errorHandlerInstalled.add(renderer)
  }
  const key = forcedErrorKeyOf(boundary)
  if (forceError) {
    ensureUnmountPruning()
    if (key) forcedErrors.delete(key)
    forcedErrors.set(boundary, true)
  } else {
    if (!key) return { boundary, active: activeErrorCount() }
    forcedErrors.delete(key)
    forcedErrors.set(boundary, false)
  }
  renderer.scheduleUpdate?.(boundary)
  return { boundary, active: activeErrorCount() }
}

// ── Hook state ───────────────────────────────────────────────────────────────

/** Only useState/useReducer hooks carry a dispatch queue; those are the ones with an overridable value. */
export function isStateHook(hook: MemoizedState): boolean {
  const queue = (hook as { queue?: { dispatch?: unknown } | null }).queue
  return queue != null && typeof queue.dispatch === 'function'
}

export function applyHookStateOverride(
  fiber: Fiber,
  hookIndex: number,
  path: Array<string | number>,
  value: unknown,
  renderer: DevRenderer = requireRenderer('overrideHookState'),
): void {
  if (fiber.tag === ClassComponentTag)
    throw new Error(
      `${nameOf(fiber)} is a class component — it has no hooks. Use react_override_props, or target a function component.`,
    )
  const hooks = hookChain(fiber)
  const hook = hooks[hookIndex]
  if (!hook)
    throw new Error(
      hooks.length === 0
        ? `${nameOf(fiber)} has no hooks — pass a function component that uses useState/useReducer.`
        : `${nameOf(fiber)} has ${hooks.length} hooks (indices 0–${hooks.length - 1}); hook ${hookIndex} does not exist. react_inspect_component lists them.`,
    )
  if (!isStateHook(hook))
    throw new Error(
      `Hook ${hookIndex} of ${nameOf(fiber)} is not a stateful hook — only useState/useReducer values can be overridden. react_inspect_component shows which hooks hold plain values.`,
    )
  renderer.overrideHookState?.(fiber, String(hookIndex), path.map(String), value)
}

// ── Context (via the nearest Provider's value prop) ──────────────────────────

// react-reconciler WorkTag for ContextProvider — stable since React 16.3, not exported by bippy.
const CONTEXT_PROVIDER_TAG = 10

export interface ProviderMatch {
  provider: Fiber
  contextName: string
}

const contextNameOf = (context: unknown): string =>
  (context as { displayName?: string } | null)?.displayName || 'Context'

/** `<Ctx.Provider>` fibers carry the context at `type._context` (React ≤18); `<Ctx>` fibers are the context itself (React 19). */
const contextOfProviderType = (type: unknown): unknown =>
  (type as { _context?: unknown } | null)?._context ?? type

export function resolveContextProvider(fiber: Fiber, contextName?: string): ProviderMatch {
  if (fiber.tag === CONTEXT_PROVIDER_TAG)
    return { provider: fiber, contextName: contextNameOf(contextOfProviderType(fiber.type)) }

  const consumed = contextDependencies(fiber)
  const componentName = nameOf(fiber)
  if (consumed.length === 0)
    throw new Error(
      `${componentName} consumes no contexts — pass a component that reads the context (react_inspect_context shows what a component consumes), or the Provider itself.`,
    )

  const names = consumed.map((entry) => entry.name).join(', ')
  const target = contextName
    ? consumed.find((entry) => entry.name === contextName)
    : consumed.length === 1
      ? consumed[0]
      : undefined
  if (!target)
    throw new Error(
      contextName
        ? `${componentName} does not consume a context named "${contextName}". It consumes: ${names}.`
        : `${componentName} consumes ${consumed.length} contexts (${names}) — pass \`context\` to pick one.`,
    )

  let current: Fiber | null = fiber.return
  while (current) {
    if (
      current.tag === CONTEXT_PROVIDER_TAG &&
      contextOfProviderType(current.type) === target.context
    )
      return { provider: current, contextName: target.name }
    current = current.return
  }
  throw new Error(
    `No Provider for "${target.name}" above ${componentName} — the context is running on its default value, which cannot be overridden live. Render a Provider, or change the default in source.`,
  )
}

export function applyContextOverride(
  fiber: Fiber,
  contextName: string | undefined,
  value: unknown,
  renderer: DevRenderer = requireRenderer('overrideProps'),
): ProviderMatch {
  const match = resolveContextProvider(fiber, contextName)
  const currentValue = isPlainObject(match.provider.memoizedProps)
    ? match.provider.memoizedProps.value
    : undefined
  const nextValue =
    isPlainObject(value) && isPlainObject(currentValue) ? { ...currentValue, ...value } : value
  overrideFiberProps(match.provider, { value: nextValue }, renderer)
  return match
}
