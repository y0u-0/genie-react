import {
  ClassComponentTag,
  type ContextDependency,
  type Fiber,
  type FiberRoot,
  getDisplayName,
  getFiberId,
  getTimings,
  hasMemoCache,
  instrument,
  isCompositeFiber,
  type MemoizedState,
  type Props,
  type RenderPhase,
  secure,
  traverseRenderedFibers,
} from 'bippy'
import { clearEffects, recordEffect } from './effect-tracker'
import { clearErrorState, recordErrorState } from './error-tracker'
import { classifyFiber, clearSourceCache, type ResolvedSource, sourceLabel } from './source'

export interface RenderChange {
  name: string
  kind: 'props' | 'state'
  unstable: boolean
}

export interface RenderRecord {
  id: number
  name: string
  renders: number
  mounts: number
  updates: number
  unnecessary: number
  unstableRenders: number
  forget: boolean
  selfTime: number
  totalTime: number
  changes: RenderChange[]
  /** The live fiber, kept so source/library classification can run async at report time. */
  fiber: Fiber
}

/** A render record enriched for the wire — the raw `fiber` handle dropped, source/library added. */
export interface RenderReport extends Omit<RenderRecord, 'fiber'> {
  source: ResolvedSource | null
  isLibrary: boolean
}

export interface RenderSummary {
  commits: number
  trackedComponents: number
  totalRenders: number
  totalUpdates: number
  unstableComponents: number
  unnecessaryComponents: number
  topUnstableProps: { name: string; count: number }[]
}

const records = new Map<number, RenderRecord>()
let commits = 0
let installed = false

/** Installs commit-time instrumentation (idempotent); the DevTools hook must already be present before React loads, or no commits are delivered. */
export function startRenderTracking(): boolean {
  if (installed) return true
  try {
    instrument(
      secure({
        name: 'genie-react',
        onCommitFiberRoot: (_rendererId: number, root: FiberRoot) => {
          commits += 1
          traverseRenderedFibers(root, (fiber, phase) => {
            recordRender(fiber, phase)
            recordEffect(fiber, phase)
            recordErrorState(fiber)
          })
        },
      }),
    )
    installed = true
  } catch {
    installed = false
  }
  return installed
}

export const isTracking = (): boolean => installed
export const getCommitCount = (): number => commits

export function clearRenders(): void {
  records.clear()
  commits = 0
  clearEffects()
  clearErrorState()
  clearSourceCache()
}

export interface RenderQuery {
  component?: string
  limit: number
  sort: 'renders' | 'unnecessary' | 'unstable' | 'selfTime'
  /** Exclude library components (node_modules, incl. Vite pre-bundled deps). Default true. */
  appOnly?: boolean
}

/** Classifies the component-filtered records (source + app/library), dropping library when appOnly. */
async function selectRecords(
  query: RenderQuery,
): Promise<{ record: RenderRecord; report: RenderReport }[]> {
  let list = [...records.values()]
  if (query.component) {
    const needle = query.component.toLowerCase()
    list = list.filter((record) => record.name.toLowerCase().includes(needle))
  }

  const appOnly = query.appOnly ?? true
  const classified = await Promise.all(
    list.map(async (record) => {
      const { source, isLibrary } = await classifyFiber(record.fiber)
      const { fiber: _fiber, ...rest } = record
      const name = rest.name === 'Anonymous' ? (sourceLabel(source) ?? rest.name) : rest.name
      return { record, report: { ...rest, name, source, isLibrary } satisfies RenderReport }
    }),
  )
  return appOnly ? classified.filter((entry) => !entry.report.isLibrary) : classified
}

export async function getRenders(query: RenderQuery): Promise<RenderReport[]> {
  const selected = await selectRecords(query)
  selected.sort((a, b) => {
    const x = a.report
    const y = b.report
    if (query.sort === 'selfTime') return y.selfTime - x.selfTime
    if (query.sort === 'unnecessary') return y.unnecessary - x.unnecessary
    if (query.sort === 'unstable') return y.unstableRenders - x.unstableRenders
    return y.renders - x.renders
  })
  return selected.slice(0, query.limit).map((entry) => entry.report)
}

/** Aggregate stats across tracked components (app-only by default, so library noise is excluded). */
export async function getRenderSummary(appOnly = true): Promise<RenderSummary> {
  let list = [...records.values()]
  if (appOnly) {
    const flags = await Promise.all(list.map((record) => classifyFiber(record.fiber)))
    list = list.filter((_, index) => !flags[index]?.isLibrary)
  }

  let totalRenders = 0
  let totalUpdates = 0
  let unstableComponents = 0
  let unnecessaryComponents = 0
  const unstablePropCounts = new Map<string, number>()

  for (const record of list) {
    totalRenders += record.renders
    totalUpdates += record.updates
    if (record.unstableRenders > 0) unstableComponents += 1
    if (record.unnecessary > 0) unnecessaryComponents += 1
    for (const change of record.changes) {
      if (change.kind === 'props' && change.unstable) {
        unstablePropCounts.set(change.name, (unstablePropCounts.get(change.name) ?? 0) + 1)
      }
    }
  }

  const topUnstableProps = [...unstablePropCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return {
    commits,
    trackedComponents: list.length,
    totalRenders,
    totalUpdates,
    unstableComponents,
    unnecessaryComponents,
    topUnstableProps,
  }
}

export function recordRender(fiber: Fiber, phase: RenderPhase): void {
  if (!isCompositeFiber(fiber)) return

  const id = getFiberId(fiber)
  // Evict on unmount so the map tracks live components and does not grow for the page's lifetime.
  if (phase === 'unmount') {
    records.delete(id)
    return
  }

  let record = records.get(id)
  if (!record) {
    record = {
      id,
      name: getDisplayName(fiber.type) ?? 'Anonymous',
      renders: 0,
      mounts: 0,
      updates: 0,
      unnecessary: 0,
      unstableRenders: 0,
      forget: hasMemoCache(fiber),
      selfTime: 0,
      totalTime: 0,
      changes: [],
      fiber,
    }
    records.set(id, record)
  }

  record.fiber = fiber
  record.renders += 1
  const timings = getTimings(fiber)
  record.selfTime = Math.max(record.selfTime, timings.selfTime)
  record.totalTime = Math.max(record.totalTime, timings.totalTime)

  if (phase === 'mount') {
    record.mounts += 1
    return
  }

  record.updates += 1
  const propChanges = diffProps(fiber)
  const stateDidChange = stateChanged(fiber)
  const childrenDidChange = childrenChanged(fiber)
  const changes = stateDidChange
    ? [
        ...propChanges,
        { name: '(state/hooks)', kind: 'state', unstable: false } satisfies RenderChange,
      ]
    : propChanges
  record.changes = changes
  // A render is unnecessary only when none of props/state/children/context changed — new children or context are legitimate reasons.
  if (changes.length === 0 && !childrenDidChange && !contextChanged(fiber)) {
    record.unnecessary += 1
  }
  // A render driven solely by unstable-reference props (no state/children change) would be skipped under React.memo + stable refs — the most common wasted render.
  if (
    propChanges.length > 0 &&
    propChanges.every((change) => change.unstable) &&
    !stateDidChange &&
    !childrenDidChange
  ) {
    record.unstableRenders += 1
  }
}

export function childrenChanged(fiber: Fiber): boolean {
  const next: Props | null = fiber.memoizedProps
  const prev: Props | null = fiber.alternate?.memoizedProps ?? null
  if (!next || !prev || typeof next !== 'object' || typeof prev !== 'object') return false
  return !Object.is(prev.children, next.children)
}

export function diffProps(fiber: Fiber): RenderChange[] {
  const next: Props | null = fiber.memoizedProps
  const prev: Props | null = fiber.alternate?.memoizedProps ?? null
  if (!next || !prev || typeof next !== 'object' || typeof prev !== 'object') return []

  const changes: RenderChange[] = []
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (key === 'children') continue
    if (!Object.is(prev[key], next[key])) {
      changes.push({ name: key, kind: 'props', unstable: isUnstable(prev[key], next[key]) })
    }
  }
  return changes
}

/** A non-primitive prop whose reference changed is "unstable" — a new value every render that defeats memo. */
function isUnstable(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false
  const ta = typeof a
  const tb = typeof b
  return (ta === 'object' || ta === 'function') && (tb === 'object' || tb === 'function')
}

export function stateChanged(fiber: Fiber): boolean {
  // Class components store state directly on memoizedState (a fresh object per setState, no hook list) — compare by reference, not by walking a chain that isn't there.
  if (fiber.tag === ClassComponentTag) {
    return !Object.is(fiber.memoizedState, fiber.alternate?.memoizedState ?? null)
  }

  // Function components: walk the hook linked-list and compare each hook's memoizedState.
  let cur: MemoizedState | null = fiber.memoizedState
  let alt: MemoizedState | null = fiber.alternate?.memoizedState ?? null
  let guard = 0
  while (cur && alt && guard < HOOK_WALK_LIMIT) {
    if (!Object.is(cur.memoizedState, alt.memoizedState)) return true
    cur = cur.next
    alt = alt.next
    guard += 1
  }
  return false
}

/** A consumed context whose value changed is a legitimate reason to re-render (not "unnecessary"). */
export function contextChanged(fiber: Fiber): boolean {
  let cur = firstContextDependency(fiber)
  let prev = firstContextDependency(fiber.alternate)
  let guard = 0
  while (cur && prev && guard < HOOK_WALK_LIMIT) {
    if (!Object.is(cur.memoizedValue, prev.memoizedValue)) return true
    cur = cur.next
    prev = prev.next
    guard += 1
  }
  return false
}

/** Reads the head of a fiber's context-dependency list (React stores it on `dependencies`). */
function firstContextDependency(
  fiber: Fiber | null | undefined,
): ContextDependency<unknown> | null {
  return fiber?.dependencies?.firstContext ?? null
}

const HOOK_WALK_LIMIT = 1000
