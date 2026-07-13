import {
  ClassComponentTag,
  didFiberRender,
  type Fiber,
  type FiberRoot,
  getFiberId,
  getTimings,
  hasMemoCache,
  instrument,
  isCompositeFiber,
  type MemoizedState,
  type Props,
  type RenderPhase,
  SuspenseComponentTag,
  traverseRenderedFibers,
  type Unsubscribe,
} from 'bippy'
import type { ToolOutput } from '../../protocol'
import type { reactRendersDiffContract } from './contracts'
import { clearEffects, recordEffect } from './effect-tracker'
import { clearErrorState, recordErrorState } from './error-tracker'
import { classifyHook, isStatefulHook, nameOf, noteCommit, noteCommittedRoot } from './fiber'
import { isRefreshCommit, noteExcludedRefreshCommit } from './refresh-tracker'
import {
  diffContextChanges,
  diffExternalStoreChanges,
  emptyCauseCounts,
  HOOK_WALK_LIMIT,
  type RenderCause,
  type RenderCauseCounts,
  type RenderCauseEvent,
  type RenderNecessity,
  stateValue,
} from './render-causes'
import { isSafeRenderer, supportedCommitHandler } from './safe-instrumentation'
import {
  classifyFibersWithinBudget,
  clearSourceCache,
  type FiberClassification,
  type ResolvedSource,
  sourceLabel,
} from './source'

export interface PropRenderChange {
  name: string
  kind: 'props'
  unstable: boolean
}

interface StateRenderChangeBase {
  name: string
  kind: 'state'
  unstable: false
  /** Depth- and size-bounded values safe for the agent-facing wire. */
  before: unknown
  after: unknown
}

export interface HookStateRenderChange extends StateRenderChangeBase {
  hook: {
    /** Flat position in the component's complete hook chain. */
    index: number
    /** Position among useState/useReducer hooks only; matches react_override_hook_state. */
    stateIndex: number
    kind: 'state' | 'reducer'
  }
}

export interface ClassStateRenderChange extends StateRenderChangeBase {
  name: 'class state'
}

export type StateRenderChange = HookStateRenderChange | ClassStateRenderChange
export type RenderChange = PropRenderChange | StateRenderChange
export type {
  RenderCause,
  RenderCauseCounts,
  RenderCauseKind,
  RenderNecessity,
} from './render-causes'
export { diffContextChanges, diffExternalStoreChanges } from './render-causes'

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
  latestCommitId: number
  causes: RenderCause[]
  causeCounts: RenderCauseCounts
  necessity: RenderNecessity
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
interface RetainedRenderCauseEvent {
  commitId: number
  componentId: number
  componentName: string
  causes: RenderCause[]
  necessity: RenderNecessity
}

const recentCauseEvents: RetainedRenderCauseEvent[] = []
let commits = 0
let installed = false
let instrumentation: Unsubscribe | null = null
// Stop is intentionally a soft flag: the commit handler stays wired so the client's liveness heartbeat continues while profiling is paused.
let paused = false
let skippedCommitFibers = 0

const COMMIT_FIBER_ANALYSIS_LIMIT = 250
const DID_CAPTURE = 0b1000_0000
const REPORT_SOURCE_CLASSIFY_LIMIT = 120
const REPORT_SOURCE_CLASSIFY_BUDGET_MS = 500
const UNCLASSIFIED_FIBER: FiberClassification = { source: null, isLibrary: false }
const RECENT_CAUSE_EVENT_LIMIT = 1_000

export interface CommitAnalysisBudget {
  processed: number
  skipped: number
  limit: number
}

export function createCommitAnalysisBudget(
  limit = COMMIT_FIBER_ANALYSIS_LIMIT,
): CommitAnalysisBudget {
  return { processed: 0, skipped: 0, limit }
}

let commitListener: (() => void) | null = null

/** Register a per-commit callback (the client's liveness pump). Called on every commit — even while paused — because a committing thread is alive regardless of whether we record it. */
export function setCommitListener(listener: (() => void) | null): void {
  commitListener = listener
}

/** Installs commit-time instrumentation (idempotent) and (re)enables tracking; the DevTools hook must already be present before React loads, or no commits are delivered. */
export function startRenderTracking(): boolean {
  paused = false
  if (installed) return true
  try {
    instrumentation = instrument({
      name: 'genie-react',
      onCommitFiberRoot: supportedCommitHandler((rendererId: number, root: FiberRoot) => {
        commitListener?.()
        noteCommit()
        noteCommittedRoot(root)
        if (!isSafeRenderer(rendererId)) return
        if (isRefreshCommit()) {
          noteExcludedRefreshCommit()
          return
        }
        if (paused) return
        commits += 1
        const budget = createCommitAnalysisBudget()
        traverseRenderedFibers(root, (fiber, phase) => {
          recordCommitFiber(fiber, phase, budget)
        })
      }),
    })
    installed = true
  } catch {
    installed = false
  }
  return installed
}

/** Module/HMR teardown only. Profiling stop must keep the lightweight commit heartbeat installed. */
export function disposeRenderTracking(): void {
  instrumentation?.()
  instrumentation = null
  installed = false
  paused = false
}

/** Pause commit recording without uninstalling instrumentation; isTracking() reports false until startRenderTracking() resumes. */
export function stopRenderTracking(): void {
  paused = true
}

export const isTracking = (): boolean => installed && !paused
export const getCommitCount = (): number => commits
export const getSkippedCommitFiberCount = (): number => skippedCommitFibers

export function clearRenders(): void {
  records.clear()
  recentCauseEvents.length = 0
  commits = 0
  skippedCommitFibers = 0
  clears++
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

/** Classifies the component-filtered records (source + app/library); reports how many library components appOnly dropped so callers can disclose the filter. */
async function selectRecords(
  query: RenderQuery,
): Promise<{ kept: { record: RenderRecord; report: RenderReport }[]; libraryHidden: number }> {
  let list = [...records.values()]
  if (query.component) {
    const needle = query.component.toLowerCase()
    list = list.filter((record) => record.name.toLowerCase().includes(needle))
  }

  const appOnly = query.appOnly ?? true
  const classes = await classifyRecordsWithinBudget(list)
  const classified = list.map((record, index) => {
    const { source, isLibrary } = classes[index] ?? UNCLASSIFIED_FIBER
    const { fiber: _fiber, ...rest } = record
    const name = rest.name === 'Anonymous' ? (sourceLabel(source) ?? rest.name) : rest.name
    return { record, report: { ...rest, name, source, isLibrary } satisfies RenderReport }
  })
  if (!appOnly) return { kept: classified, libraryHidden: 0 }
  const kept = classified.filter((entry) => !entry.report.isLibrary)
  return { kept, libraryHidden: classified.length - kept.length }
}

async function classifyRecordsWithinBudget(
  recordsToClassify: RenderRecord[],
): Promise<FiberClassification[]> {
  const { classes } = await classifyFibersWithinBudget(
    recordsToClassify.map((record) => record.fiber),
    { limit: REPORT_SOURCE_CLASSIFY_LIMIT, budgetMs: REPORT_SOURCE_CLASSIFY_BUDGET_MS },
  )
  return classes
}

function sortReports(
  entries: { record: RenderRecord; report: RenderReport }[],
  sort: RenderQuery['sort'],
): { record: RenderRecord; report: RenderReport }[] {
  return [...entries].sort((a, b) => {
    const x = a.report
    const y = b.report
    if (sort === 'selfTime') return y.selfTime - x.selfTime
    if (sort === 'unnecessary') return y.unnecessary - x.unnecessary
    if (sort === 'unstable') return y.unstableRenders - x.unstableRenders
    return y.renders - x.renders
  })
}

export async function getRenders(query: RenderQuery): Promise<RenderReport[]> {
  const { kept } = await selectRecords(query)
  return sortReports(kept, query.sort)
    .slice(0, query.limit)
    .map((entry) => entry.report)
}

/** Like getRenders, plus the count of library components appOnly hid — for react_get_renders' filteredNote. */
export async function getRendersReport(
  query: RenderQuery,
): Promise<{ components: RenderReport[]; libraryHidden: number }> {
  const { kept, libraryHidden } = await selectRecords(query)
  const components = sortReports(kept, query.sort)
    .slice(0, query.limit)
    .map((entry) => entry.report)
  return { components, libraryHidden }
}

export interface RenderCauseQuery {
  commit?: number
  afterCommit?: number
  component?: string
  limit: number
  appOnly?: boolean
}

/** Recent commit-scoped causes, newest first. Source classification reuses live records and never retains old fiber graphs. */
export async function getRenderCauseEventsReport(query: RenderCauseQuery): Promise<{
  events: RenderCauseEvent[]
  libraryHidden: number
}> {
  const needle = query.component?.toLowerCase()
  const selected = recentCauseEvents
    .filter((event) => query.commit === undefined || event.commitId === query.commit)
    .filter((event) => query.afterCommit === undefined || event.commitId > query.afterCommit)
    .filter((event) => !needle || event.componentName.toLowerCase().includes(needle))
    .slice(-query.limit)
    .reverse()

  const liveRecords = [
    ...new Map(
      selected
        .map((event) => records.get(event.componentId))
        .filter((record): record is RenderRecord => record !== undefined)
        .map((record) => [record.id, record]),
    ).values(),
  ]
  const classes = await classifyRecordsWithinBudget(liveRecords)
  const classById = new Map<number, FiberClassification>()
  liveRecords.forEach((record, index) => {
    classById.set(record.id, classes[index] ?? UNCLASSIFIED_FIBER)
  })

  const classified = selected.map((event) => {
    const classification = classById.get(event.componentId) ?? UNCLASSIFIED_FIBER
    return {
      event: {
        ...event,
        source: classification.source,
        isLibrary: classification.isLibrary,
      } satisfies RenderCauseEvent,
      isLibrary: classification.isLibrary,
    }
  })
  if (query.appOnly === false) {
    return { events: classified.map(({ event }) => event), libraryHidden: 0 }
  }
  return {
    events: classified.filter(({ isLibrary }) => !isLibrary).map(({ event }) => event),
    libraryHidden: classified.filter(({ isLibrary }) => isLibrary).length,
  }
}

/** Classify once, sort/slice per leaderboard — react_profile_report's four views without 4× classification passes. */
export async function getRendersLeaderboards(limit: number): Promise<{
  slowest: RenderReport[]
  mostRerendered: RenderReport[]
  mostUnnecessary: RenderReport[]
  mostUnstable: RenderReport[]
}> {
  const { kept } = await selectRecords({ limit, sort: 'renders' })
  const top = (sort: RenderQuery['sort']): RenderReport[] =>
    sortReports(kept, sort)
      .slice(0, limit)
      .map((entry) => entry.report)
  return {
    slowest: top('selfTime'),
    mostRerendered: top('renders'),
    mostUnnecessary: top('unnecessary'),
    mostUnstable: top('unstable'),
  }
}

/** Aggregate stats across tracked components (app-only by default, so library noise is excluded). */
export async function getRenderSummary(appOnly = true): Promise<RenderSummary> {
  let list = [...records.values()]
  if (appOnly) {
    const flags = await classifyRecordsWithinBudget(list)
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

// ── Snapshots + diff (regression verdict) ────────────────────────────────────

export interface ComponentAggregate {
  name: string
  source: string | null
  renders: number
  mounts: number
  updates: number
  selfTime: number
  totalTime: number
  unnecessary: number
  unstableRenders: number
}

interface Snapshot {
  commits: number
  clears: number
  components: ComponentAggregate[]
}

const snapshots = new Map<string, Snapshot>()

// Counts clearRenders() calls so a diff can say whether its baseline predates a counter reset (session-vs-session compare) or shares the session (additive compare).
let clears = 0

// Join key: components with a resolved source disambiguate by name+file:line (two same-named components stay distinct); unresolved ones fall back to name alone.
const aggregateKey = (aggregate: { name: string; source: string | null }): string =>
  aggregate.source ? `${aggregate.name}@${aggregate.source}` : aggregate.name

/** Current per-component aggregates with a resolved source label, app-filtered by default — the shape snapshots store and diffs read on the live side. */
async function currentAggregates(appOnly = true): Promise<ComponentAggregate[]> {
  const list = [...records.values()]
  const classified = await classifyRecordsWithinBudget(list)
  const out: ComponentAggregate[] = []
  list.forEach((record, index) => {
    const { source, isLibrary } = classified[index] ?? { source: null, isLibrary: false }
    if (appOnly && isLibrary) return
    const label = sourceLabel(source)
    out.push({
      name: record.name === 'Anonymous' ? (label ?? record.name) : record.name,
      source: label,
      renders: record.renders,
      mounts: record.mounts,
      updates: record.updates,
      selfTime: record.selfTime,
      totalTime: record.totalTime,
      unnecessary: record.unnecessary,
      unstableRenders: record.unstableRenders,
    })
  })
  return out
}

/** Store the current aggregates under `label` (overwriting a prior snapshot of the same label) so a later react_renders_diff can measure change against it. */
export async function takeSnapshot(
  label: string,
): Promise<{ label: string; commits: number; components: number }> {
  const components = await currentAggregates()
  snapshots.set(label, { commits, clears, components })
  return { label, commits, components: components.length }
}

export const snapshotLabels = (): string[] => [...snapshots.keys()]

type RendersDiff = ToolOutput<typeof reactRendersDiffContract>
type RenderDelta = RendersDiff['regressed'][number]

const round1 = (n: number): number => Math.round(n * 10) / 10

// pct is delta/before*100 to 1dp; null when before is 0 (no baseline cost to divide by — an honest "undefined ratio", not a fabricated 100%).
const pctChange = (before: number, delta: number): number | null =>
  before === 0 ? null : round1((delta / before) * 100)

const toDelta = (
  name: string,
  source: string | null,
  before: ComponentAggregate,
  after: ComponentAggregate,
): RenderDelta => ({
  name,
  ...(source ? { source } : {}),
  deltaMs: round1(after.selfTime - before.selfTime),
  before: { renders: before.renders, selfTime: round1(before.selfTime) },
  after: { renders: after.renders, selfTime: round1(after.selfTime) },
})

/** Compare a stored snapshot against the current live aggregates: total self-time change plus per-component regressions/improvements past a threshold, and components that appeared/vanished. */
export async function rendersDiff(baseline: string, thresholdMs: number): Promise<RendersDiff> {
  const snapshot = snapshots.get(baseline)
  if (!snapshot)
    throw new Error(
      snapshots.size === 0
        ? `No snapshot named "${baseline}" — take one with react_profile_snapshot first (no snapshots stored yet).`
        : `No snapshot named "${baseline}". Stored labels: ${snapshotLabels().join(', ')}.`,
    )

  const after = await currentAggregates()
  const beforeByKey = new Map(snapshot.components.map((c) => [aggregateKey(c), c]))
  const afterByKey = new Map(after.map((c) => [aggregateKey(c), c]))

  const regressed: RenderDelta[] = []
  const improved: RenderDelta[] = []
  const added: { name: string; renders: number; selfTime: number }[] = []
  const removed: { name: string }[] = []

  for (const [key, afterAgg] of afterByKey) {
    const beforeAgg = beforeByKey.get(key)
    if (!beforeAgg) {
      added.push({
        name: afterAgg.name,
        renders: afterAgg.renders,
        selfTime: round1(afterAgg.selfTime),
      })
      continue
    }
    const delta = afterAgg.selfTime - beforeAgg.selfTime
    if (delta > thresholdMs)
      regressed.push(toDelta(afterAgg.name, afterAgg.source, beforeAgg, afterAgg))
    else if (delta < -thresholdMs)
      improved.push(toDelta(afterAgg.name, afterAgg.source, beforeAgg, afterAgg))
  }
  for (const [key, beforeAgg] of beforeByKey) {
    if (!afterByKey.has(key)) removed.push({ name: beforeAgg.name })
  }

  const byMagnitude = (a: RenderDelta, b: RenderDelta): number =>
    Math.abs(b.deltaMs) - Math.abs(a.deltaMs)
  regressed.sort(byMagnitude)
  improved.sort(byMagnitude)

  const beforeSelf = snapshot.components.reduce((sum, c) => sum + c.selfTime, 0)
  const afterSelf = after.reduce((sum, c) => sum + c.selfTime, 0)
  const selfDelta = afterSelf - beforeSelf

  return {
    baseline,
    commits: { before: snapshot.commits, after: commits },
    clearsSinceBaseline: clears - snapshot.clears,
    selfTimeMs: {
      before: round1(beforeSelf),
      after: round1(afterSelf),
      delta: round1(selfDelta),
      pct: pctChange(beforeSelf, selfDelta),
    },
    regressed,
    improved,
    added,
    removed,
  }
}

export function clearSnapshots(): void {
  snapshots.clear()
}

function shouldAnalyzeCommitFiber(fiber: Fiber): boolean {
  return (
    isCompositeFiber(fiber) ||
    fiber.tag === SuspenseComponentTag ||
    ((fiber.flags ?? 0) & DID_CAPTURE) !== 0
  )
}

export function recordCommitFiber(
  fiber: Fiber,
  phase: RenderPhase,
  budget: CommitAnalysisBudget,
): boolean {
  if (!shouldAnalyzeCommitFiber(fiber)) return false
  if (budget.processed >= budget.limit) {
    budget.skipped += 1
    skippedCommitFibers += 1
    return false
  }
  budget.processed += 1
  recordRender(fiber, phase)
  recordEffect(fiber, phase)
  recordErrorState(fiber)
  return true
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
      name: nameOf(fiber),
      renders: 0,
      mounts: 0,
      updates: 0,
      unnecessary: 0,
      unstableRenders: 0,
      forget: hasMemoCache(fiber),
      selfTime: 0,
      totalTime: 0,
      changes: [],
      latestCommitId: commits,
      causes: [],
      causeCounts: emptyCauseCounts(),
      necessity: 'unknown',
      fiber,
    }
    records.set(id, record)
  }

  record.fiber = fiber
  record.renders += 1
  const timings = getTimings(fiber)
  record.selfTime = Math.max(record.selfTime, timings.selfTime)
  record.totalTime = Math.max(record.totalTime, timings.totalTime)
  record.latestCommitId = commits

  if (phase === 'mount') {
    record.mounts += 1
    const causes: RenderCause[] = [{ kind: 'mount', evidence: 'exact' }]
    record.causes = causes
    record.necessity = 'necessary'
    retainCauseEvent(record, causes, record.necessity)
    return
  }

  record.updates += 1
  const propChanges = diffProps(fiber)
  const stateChanges = diffStateChanges(fiber)
  const contextChanges = diffContextChanges(fiber)
  const externalStoreChanges = diffExternalStoreChanges(fiber)
  const stateDidChange = stateChanges.length > 0
  const childrenDidChange = childrenChanged(fiber)
  const changes: RenderChange[] = [...propChanges, ...stateChanges]
  record.changes = changes
  const observableCauses: RenderCause[] = [
    ...propChanges.map(
      (change): RenderCause => ({
        kind: 'props',
        evidence: 'exact',
        name: change.name,
        unstable: change.unstable,
      }),
    ),
    ...stateChanges.map(
      (change): RenderCause => ({
        kind: 'state',
        evidence: 'exact',
        name: change.name,
        before: change.before,
        after: change.after,
        ...('hook' in change ? { hook: change.hook } : {}),
      }),
    ),
    ...(childrenDidChange ? ([{ kind: 'children', evidence: 'exact' }] as const) : []),
    ...contextChanges,
    ...externalStoreChanges,
  ]
  const parentCause = observableCauses.length === 0 ? renderedParentCause(fiber) : null
  const causes: RenderCause[] =
    observableCauses.length > 0
      ? observableCauses
      : parentCause
        ? [parentCause]
        : [{ kind: 'unknown', evidence: 'unknown', reason: 'no-observable-fiber-input-change' }]
  const necessity: RenderNecessity =
    observableCauses.length > 0 ? 'necessary' : parentCause ? 'unknown' : 'unnecessary'
  record.causes = causes
  record.necessity = necessity
  retainCauseEvent(record, causes, necessity)
  // A render is unnecessary only when none of props/state/children/context changed — new children or context are legitimate reasons.
  if (
    changes.length === 0 &&
    !childrenDidChange &&
    contextChanges.length === 0 &&
    externalStoreChanges.length === 0
  ) {
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

export function diffProps(fiber: Fiber): PropRenderChange[] {
  const next: Props | null = fiber.memoizedProps
  const prev: Props | null = fiber.alternate?.memoizedProps ?? null
  if (!next || !prev || typeof next !== 'object' || typeof prev !== 'object') return []

  const changes: PropRenderChange[] = []
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

function retainCauseEvent(
  record: RenderRecord,
  causes: RenderCause[],
  necessity: RenderNecessity,
): void {
  for (const cause of causes) record.causeCounts[cause.kind] += 1
  recentCauseEvents.push({
    commitId: commits,
    componentId: record.id,
    componentName: record.name,
    causes: structuredClone(causes),
    necessity,
  })
  if (recentCauseEvents.length > RECENT_CAUSE_EVENT_LIMIT) recentCauseEvents.shift()
}

function renderedParentCause(fiber: Fiber): RenderCause | null {
  let parent = fiber.return
  while (parent && !isCompositeFiber(parent)) parent = parent.return
  if (!parent) return null
  try {
    if (!didFiberRender(parent)) return null
  } catch {
    return null
  }
  return {
    kind: 'parent',
    evidence: 'inferred',
    parentId: getFiberId(parent),
    parentName: nameOf(parent),
    reason: 'nearest-rendered-ancestor',
  }
}

/** Reports changed useState/useReducer slots in one guarded hook-chain pass; derived hook internals are excluded because they cannot schedule a render. */
export function diffStateChanges(fiber: Fiber): StateRenderChange[] {
  // Class components store state directly on memoizedState (a fresh object per setState, no hook list) — compare by reference, not by walking a chain that isn't there.
  if (fiber.tag === ClassComponentTag) {
    const before = fiber.alternate?.memoizedState ?? null
    const after = fiber.memoizedState
    return Object.is(before, after)
      ? []
      : [
          {
            name: 'class state',
            kind: 'state',
            unstable: false,
            before: stateValue(before),
            after: stateValue(after),
          },
        ]
  }

  const changes: StateRenderChange[] = []
  let cur: MemoizedState | null = fiber.memoizedState
  let alt: MemoizedState | null = fiber.alternate?.memoizedState ?? null
  let index = 0
  let stateIndex = 0
  while (cur && alt && index < HOOK_WALK_LIMIT) {
    const currentStateful = isStatefulHook(cur)
    const previousStateful = isStatefulHook(alt)
    if (currentStateful || previousStateful) {
      if (!Object.is(cur.memoizedState, alt.memoizedState)) {
        const classified = classifyHook(currentStateful ? cur : alt)
        const kind = classified === 'reducer' ? 'reducer' : 'state'
        changes.push({
          name: `${kind}[${stateIndex}]`,
          kind: 'state',
          unstable: false,
          hook: { index, stateIndex, kind },
          before: stateValue(alt.memoizedState),
          after: stateValue(cur.memoizedState),
        })
      }
      stateIndex += 1
    }
    cur = cur.next
    alt = alt.next
    index += 1
  }
  return changes
}

/** Backward-compatible "any hook internals changed" predicate; detailed reports intentionally narrow to stateful hooks. */
export function stateChanged(fiber: Fiber): boolean {
  if (fiber.tag === ClassComponentTag) {
    return !Object.is(fiber.memoizedState, fiber.alternate?.memoizedState ?? null)
  }
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
  return diffContextChanges(fiber).length > 0
}
