import {
  _fiberRoots,
  type Fiber,
  getFiberId,
  getLatestFiber,
  SuspenseComponentTag,
  traverseFiber,
} from 'bippy'
import { nameOf } from './fiber'
import { forcedErrorBoundaries, forcedSuspenseBoundaries } from './overrides'
import { classifyFiber, type ResolvedSource } from './source'

// React's DidCapture flag is set on a boundary only during the catch commit, then cleared — transient, like fallback state, so both are recorded at commit time rather than scanned on demand.
const DID_CAPTURE = 0b1000_0000
const ERROR_LOG_LIMIT = 50

interface CaughtEntry {
  boundaryId: number
  fiber: Fiber
}

interface SuspendedEntry {
  id: number
  fiber: Fiber
}

interface ErrorLog {
  message: string | null
  stack: string | null
  throwingComponent: string | null
  boundaryName: string | null
}

const caught = new Map<number, CaughtEntry>()
const suspended = new Map<number, SuspendedEntry>()
const errorLog: ErrorLog[] = []
let captureInstalled = false
let originalConsoleError: typeof console.error | null = null
let captureConsoleError: typeof console.error | null = null

export function clearErrorState(): void {
  caught.clear()
  suspended.clear()
  errorLog.length = 0
}

/** Per-fiber commit hook: captures boundaries that caught this commit and Suspense boundaries showing a fallback (both transient, so recorded, not polled). */
export function recordErrorState(fiber: Fiber): void {
  const flags = fiber.flags
  if ((flags & DID_CAPTURE) !== 0) {
    const id = getFiberId(fiber)
    caught.set(id, { boundaryId: id, fiber })
  } else if (caught.size > 0) {
    // A previously-caught boundary that re-renders without DidCapture has recovered ("Try again").
    const id = getFiberId(fiber)
    if (caught.has(id)) caught.delete(id)
  }
  if (fiber.tag === SuspenseComponentTag) {
    const id = getFiberId(fiber)
    if (suspenseShowsFallback(fiber)) suspended.set(id, { id, fiber })
    else suspended.delete(id)
  }
}

// The fallback shows exactly when React parks a non-null memoizedState; bippy types it non-null, so the one nullable read is isolated here.
function suspenseShowsFallback(fiber: Fiber): boolean {
  return fiber.tag === SuspenseComponentTag && fiber.memoizedState != null
}

/** A recorded fiber may have unmounted since (no commit fires on unmount of a parked subtree). */
function isMounted(fiber: Fiber): boolean {
  const latest = getLatestFiber(fiber) ?? fiber
  for (const root of _fiberRoots) {
    if (traverseFiber(root.current, (node) => node === latest)) return true
  }
  return false
}

/** Patches console.error to capture React's dev boundary-error logs (message + throwing component name) alongside DidCapture; installed from hook.ts before React loads, and always calls the original. */
export function installErrorCapture(): void {
  if (captureInstalled || typeof console === 'undefined') return
  captureInstalled = true
  originalConsoleError = console.error
  captureConsoleError = (...args: unknown[]): void => {
    try {
      const parsed = parseBoundaryError(args)
      if (parsed) {
        errorLog.push(parsed)
        if (errorLog.length > ERROR_LOG_LIMIT) errorLog.shift()
      }
    } catch {
      // never let capture break the app's logging
    }
    originalConsoleError?.apply(console, args)
  }
  console.error = captureConsoleError
}

/** Restore console.error during module/HMR teardown without clobbering a later patch. */
export function uninstallErrorCapture(): void {
  if (captureConsoleError && console.error === captureConsoleError && originalConsoleError) {
    console.error = originalConsoleError
  }
  captureInstalled = false
  captureConsoleError = null
  originalConsoleError = null
}

export function parseBoundaryError(args: unknown[]): ErrorLog | null {
  const text = args.filter((arg): arg is string => typeof arg === 'string').join('\n')
  const occurred = /occurred in the <([^>\s]+)[^>]*> component/.exec(text)
  // React 18: "…the error boundary you provided, Name" — React 19: "It was handled by the <Name> error boundary."
  const boundary =
    /error boundary you provided,?\s+(\w+)/.exec(text) ??
    /handled by the <([^>\s]+)[^>]*> error boundary/.exec(text)
  if (!occurred && !boundary) return null
  const error = args.find((arg): arg is Error => arg instanceof Error)
  // React 19.2 stops passing the Error instance for derived-state-only boundaries; fall back to the "Error: msg" line in the logged text.
  const textMessage = /(?:^|\n)(?:Uncaught\s+)?(?:[A-Z][\w$]*)?Error:\s+([^\n]+)/.exec(text)?.[1]
  return {
    message: error?.message ?? textMessage ?? null,
    stack: error?.stack ?? null,
    throwingComponent: occurred?.[1] ?? null,
    boundaryName: boundary?.[1] ?? null,
  }
}

export interface CaughtError {
  boundaryId: number
  boundaryName: string
  boundarySource: ResolvedSource | null
  throwingComponent: string | null
  message: string | null
  /** The thrower's file:line is in this stack; we don't resolve it separately (its fiber is gone). */
  stack: string | null
  isLibraryBoundary: boolean
  /** True when the boundary is held in its error state by react_force_error_boundary rather than a real thrown error. */
  forced: boolean
}

export interface SuspendedBoundary {
  boundaryId: number
  boundaryName: string
  source: ResolvedSource | null
  isFallbackShowing: boolean
  /** True when the fallback is held open by react_toggle_suspense_fallback rather than a real pending resource. */
  forced: boolean
}

const FORCED_ERROR_MESSAGE = 'forced via react_force_error_boundary (no real error thrown)'

export interface ErrorState {
  caughtErrors: CaughtError[]
  suspended: SuspendedBoundary[]
  blankTreeHint: string | null
}

export async function getErrorState(query: {
  includeSource?: boolean
  limit?: number
}): Promise<ErrorState> {
  const includeSource = query.includeSource ?? true
  const limit = query.limit ?? 20
  const classify = (fiber: Fiber) =>
    includeSource
      ? classifyFiber(fiber)
      : Promise.resolve({ source: null, isLibrary: false } as const)

  // Evict recorded boundaries that have unmounted since (no commit fires); skipped when no roots are registered so a rootless context keeps its state.
  if (_fiberRoots.size > 0) {
    for (const [id, entry] of caught) if (!isMounted(entry.fiber)) caught.delete(id)
    for (const [id, entry] of suspended) if (!isMounted(entry.fiber)) suspended.delete(id)
  }

  // Match each caught boundary to its console-logged error by name, consuming each log once so same-named boundaries can't grab the same (or an unrelated) entry. Forced boundaries never threw, so they carry no log.
  const consumed = new Set<number>()
  const organicCaught = [...caught.values()].map((entry) => {
    const boundaryName = nameOf(entry.fiber)
    const index = errorLog.findIndex(
      (item, i) => !consumed.has(i) && item.boundaryName === boundaryName,
    )
    if (index >= 0) consumed.add(index)
    return {
      fiber: entry.fiber,
      boundaryId: entry.boundaryId,
      boundaryName,
      log: index >= 0 ? errorLog[index] : null,
      forced: false,
    }
  })
  const caughtIds = new Set(caught.keys())
  const forcedCaught = dedupeByBoundaryId(forcedErrorBoundaries(), caughtIds).map((entry) => ({
    ...entry,
    boundaryName: nameOf(entry.fiber),
    log: null as ErrorLog | null,
    forced: true,
  }))

  const caughtErrors: CaughtError[] = await Promise.all(
    [...organicCaught, ...forcedCaught]
      .slice(0, limit)
      .map(async ({ fiber, boundaryId, boundaryName, log, forced }) => {
        const { source, isLibrary } = await classify(fiber)
        return {
          boundaryId,
          boundaryName,
          boundarySource: source,
          throwingComponent: log?.throwingComponent ?? null,
          message: log?.message ?? (forced ? FORCED_ERROR_MESSAGE : null),
          stack: log?.stack ?? null,
          isLibraryBoundary: isLibrary,
          forced,
        }
      }),
  )

  const suspendedIds = new Set(suspended.keys())
  const forcedSuspended = dedupeByBoundaryId(forcedSuspenseBoundaries(), suspendedIds)
  const suspendedList: SuspendedBoundary[] = await Promise.all(
    [
      ...[...suspended.values()].map((entry) => ({
        fiber: entry.fiber,
        boundaryId: entry.id,
        forced: false,
      })),
      ...forcedSuspended.map((entry) => ({ ...entry, forced: true })),
    ]
      .slice(0, limit)
      .map(async ({ fiber, boundaryId, forced }) => ({
        boundaryId,
        boundaryName: nameOf(fiber),
        source: (await classify(fiber)).source,
        isFallbackShowing: true,
        forced,
      })),
  )

  return { caughtErrors, suspended: suspendedList, blankTreeHint: hintFrom(caughtErrors) }
}

// Forced boundaries are appended after organic ones, so a real thrown error always wins the hint; a forced-only state gets its own reset guidance.
function hintFrom(caughtErrors: CaughtError[]): string | null {
  const first = caughtErrors[0]
  if (!first) return null
  if (first.forced)
    return `error boundary <${first.boundaryName}> is held in its error state by react_force_error_boundary (no real error) — call react_reset_overrides to release it`
  const at = first.boundarySource
    ? ` at ${first.boundarySource.file}:${first.boundarySource.line}`
    : ''
  const what = first.message ? `"${first.message}"` : 'an error'
  const by = first.throwingComponent ? ` thrown by <${first.throwingComponent}>` : ''
  return `error boundary <${first.boundaryName}>${at} caught ${what}${by} — the subtree below it did not render`
}

// Forced fibers can arrive as both current and alternate buffers; collapse by boundary id and drop any already reported organically.
function dedupeByBoundaryId(
  fibers: Fiber[],
  exclude: Set<number>,
): { fiber: Fiber; boundaryId: number }[] {
  const seen = new Set<number>()
  const out: { fiber: Fiber; boundaryId: number }[] = []
  for (const fiber of fibers) {
    const boundaryId = getFiberId(fiber)
    if (exclude.has(boundaryId) || seen.has(boundaryId)) continue
    seen.add(boundaryId)
    out.push({ fiber, boundaryId })
  }
  return out
}
