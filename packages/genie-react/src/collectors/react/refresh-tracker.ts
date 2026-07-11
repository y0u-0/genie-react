import {
  getDisplayName,
  getRDTHook,
  onRendererInject,
  type ReactRenderer,
  toUnsubscribe,
  type Unsubscribe,
} from 'bippy'
import { instrumentReactRefresh, type ReactRefreshUpdate } from 'bippy/react-refresh'
import { type NodeId, nameOf, registerFiber } from './fiber'
import { classifyFibersWithinBudget, clearSourceCache, type ResolvedSource } from './source'

const EVENT_LIMIT = 50
const FIBER_LIMIT_PER_KIND = 100
const COMPONENT_LIMIT_PER_KIND = 100
const SOURCE_CLASSIFY_LIMIT = 120
const SOURCE_CLASSIFY_BUDGET_MS = 500
const REFRESH_QUIESCENCE_MS = 1_000

interface StoredRefreshEvent {
  sequence: number
  timestamp: number
  filePaths: string[]
  updatedComponents: string[]
  remountedComponents: string[]
  updatedFibers: ReactRefreshUpdate['updatedFibers']
  remountedFibers: ReactRefreshUpdate['staleFibers']
  counts: RefreshEventCounts
  profileCommitsExcluded: number
}

interface RefreshEventCounts {
  updatedComponents: number
  remountedComponents: number
  updatedFibers: number
  remountedFibers: number
}

export interface RefreshFiberReport {
  id: NodeId
  name: string
  source: ResolvedSource | null
  isLibrary: boolean
}

export interface RefreshEventReport {
  sequence: number
  timestamp: number
  filePaths: string[]
  updatedComponents: string[]
  remountedComponents: string[]
  preservedState: RefreshFiberReport[]
  remounted: RefreshFiberReport[]
  counts: RefreshEventCounts
  profileCommitsExcluded: number
  truncated: boolean
}

export interface RefreshEventsReport {
  events: RefreshEventReport[]
  latestSequence: number
  droppedEvents: number
  partialSources: boolean
}

const events: StoredRefreshEvent[] = []
interface WrappedRenderer {
  original: NonNullable<ReactRenderer['scheduleRefresh']>
  wrapped: NonNullable<ReactRenderer['scheduleRefresh']>
}

const wrappedRenderers = new Map<ReactRenderer, WrappedRenderer>()
let sequence = 0
let droppedEvents = 0
let refreshDepth = 0
let bundlerUpdateActive = false
let refreshTailActive = false
let refreshTailGeneration = 0
let excludedCommitsInCurrentRefresh = 0
let instrumentation: Unsubscribe | null = null
let refreshTrackingActive = false
let latestRefreshEvent: StoredRefreshEvent | null = null

/** Close after a bounded quiet window: route frameworks can finish cold SSR/module invalidation hundreds of milliseconds after Vite applies client modules. */
function scheduleRefreshTailEnd(): void {
  const generation = ++refreshTailGeneration
  setTimeout(() => {
    if (generation !== refreshTailGeneration) return
    refreshTailActive = false
    excludedCommitsInCurrentRefresh = 0
    latestRefreshEvent = null
  }, REFRESH_QUIESCENCE_MS)
}

function componentNames(types: unknown[]): string[] {
  return types
    .map((type) => getDisplayName(type))
    .filter((name): name is string => Boolean(name))
    .slice(0, COMPONENT_LIMIT_PER_KIND)
}

function recordRefresh(update: ReactRefreshUpdate): void {
  clearSourceCache()
  const event: StoredRefreshEvent = {
    sequence: ++sequence,
    timestamp: Date.now(),
    filePaths: [...new Set(update.filePaths)],
    updatedComponents: componentNames(update.updatedComponents),
    remountedComponents: componentNames(update.staleComponents),
    updatedFibers: update.updatedFibers.slice(0, FIBER_LIMIT_PER_KIND),
    remountedFibers: update.staleFibers.slice(0, FIBER_LIMIT_PER_KIND),
    counts: {
      updatedComponents: update.updatedComponents.length,
      remountedComponents: update.staleComponents.length,
      updatedFibers: update.updatedFibers.length,
      remountedFibers: update.staleFibers.length,
    },
    profileCommitsExcluded: excludedCommitsInCurrentRefresh,
  }
  events.push(event)
  latestRefreshEvent = event
  refreshTailActive = true
  if (!bundlerUpdateActive) scheduleRefreshTailEnd()
  if (events.length > EVENT_LIMIT) {
    events.shift()
    droppedEvents += 1
  }
}

function safelyRecordRefresh(update: ReactRefreshUpdate): void {
  try {
    recordRefresh(update)
  } catch {
    // A diagnostic listener must never break React Refresh.
  }
}

function wrapRenderer(renderer: ReactRenderer): void {
  if (wrappedRenderers.has(renderer) || typeof renderer.scheduleRefresh !== 'function') return
  const original = renderer.scheduleRefresh
  const wrapped: NonNullable<ReactRenderer['scheduleRefresh']> = (root, update) => {
    if (!refreshTrackingActive) return original.call(renderer, root, update)
    if (refreshDepth === 0 && !bundlerUpdateActive) excludedCommitsInCurrentRefresh = 0
    refreshDepth += 1
    try {
      return original.call(renderer, root, update)
    } finally {
      refreshDepth -= 1
    }
  }
  wrappedRenderers.set(renderer, { original, wrapped })
  renderer.scheduleRefresh = wrapped
}

function restoreRenderers(): void {
  for (const [renderer, { original, wrapped }] of wrappedRenderers) {
    // Do not overwrite a wrapper another devtool installed after Genie.
    if (renderer.scheduleRefresh === wrapped) renderer.scheduleRefresh = original
  }
  wrappedRenderers.clear()
}

/** Install refresh observation once. Bippy's listener is installed first, then wrapped so commit suppression spans its synchronous refresh. */
export function startRefreshTracking(): boolean {
  if (instrumentation) return true
  try {
    refreshTrackingActive = true
    const refresh = instrumentReactRefresh({ onRefresh: safelyRecordRefresh })
    for (const renderer of getRDTHook().renderers.values()) wrapRenderer(renderer)
    const rendererInject = onRendererInject(wrapRenderer)
    instrumentation = toUnsubscribe(() => {
      rendererInject()
      refresh()
      refreshTrackingActive = false
      restoreRenderers()
      instrumentation = null
      refreshDepth = 0
      bundlerUpdateActive = false
      refreshTailActive = false
      refreshTailGeneration += 1
      excludedCommitsInCurrentRefresh = 0
      latestRefreshEvent = null
    })
    return true
  } catch {
    refreshTrackingActive = false
    restoreRenderers()
    instrumentation = null
    bundlerUpdateActive = false
    refreshTailActive = false
    refreshTailGeneration += 1
    latestRefreshEvent = null
    return false
  }
}

export function disposeRefreshTracking(): void {
  instrumentation?.()
}

export function isRefreshCommit(): boolean {
  return refreshDepth > 0 || bundlerUpdateActive || refreshTailActive
}

export function noteExcludedRefreshCommit(): void {
  if (!isRefreshCommit()) return
  excludedCommitsInCurrentRefresh += 1
  if (refreshDepth === 0 && latestRefreshEvent) {
    latestRefreshEvent.profileCommitsExcluded += 1
  }
  if (refreshTailActive && !bundlerUpdateActive) scheduleRefreshTailEnd()
}

/** Bundler lifecycle bracket for commits that happen before renderer.scheduleRefresh (Vite/TanStack module invalidation). */
export function beginBundlerUpdate(): void {
  if (bundlerUpdateActive) return
  bundlerUpdateActive = true
  refreshTailActive = true
  refreshTailGeneration += 1
  excludedCommitsInCurrentRefresh = 0
  latestRefreshEvent = null
}

export function completeBundlerUpdate(): void {
  bundlerUpdateActive = false
  if (refreshTailActive) scheduleRefreshTailEnd()
}

export function clearRefreshEvents(): void {
  events.length = 0
  droppedEvents = 0
  latestRefreshEvent = null
}

export async function getRefreshEvents(query: {
  afterSequence?: number
  limit: number
  includeSource: boolean
}): Promise<RefreshEventsReport> {
  const selected = events
    .filter((event) => event.sequence > (query.afterSequence ?? 0))
    .slice(-query.limit)
  const fibers = selected.flatMap((event) => [...event.updatedFibers, ...event.remountedFibers])
  const classified = query.includeSource
    ? await classifyFibersWithinBudget(fibers, {
        limit: SOURCE_CLASSIFY_LIMIT,
        budgetMs: SOURCE_CLASSIFY_BUDGET_MS,
      })
    : {
        classes: fibers.map(() => ({ source: null, isLibrary: false })),
        partial: false,
      }
  let offset = 0
  const reports = selected.map((event): RefreshEventReport => {
    const toReports = (eventFibers: ReactRefreshUpdate['updatedFibers']) =>
      eventFibers.map((fiber): RefreshFiberReport => {
        const classification = classified.classes[offset++] ?? { source: null, isLibrary: false }
        return {
          id: registerFiber(fiber),
          name: nameOf(fiber),
          source: classification.source,
          isLibrary: classification.isLibrary,
        }
      })
    const preservedState = toReports(event.updatedFibers)
    const remounted = toReports(event.remountedFibers)
    return {
      sequence: event.sequence,
      timestamp: event.timestamp,
      filePaths: event.filePaths,
      updatedComponents: event.updatedComponents,
      remountedComponents: event.remountedComponents,
      preservedState,
      remounted,
      counts: event.counts,
      profileCommitsExcluded: event.profileCommitsExcluded,
      truncated:
        event.counts.updatedComponents > event.updatedComponents.length ||
        event.counts.remountedComponents > event.remountedComponents.length ||
        event.counts.updatedFibers > preservedState.length ||
        event.counts.remountedFibers > remounted.length,
    }
  })
  return {
    events: reports,
    latestSequence: sequence,
    droppedEvents,
    partialSources: classified.partial,
  }
}
