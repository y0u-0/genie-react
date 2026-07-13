import {
  type Effect,
  type Fiber,
  ForwardRefTag,
  FunctionComponentTag,
  getDisplayName,
  getFiberId,
  type RenderPhase,
  SimpleMemoComponentTag,
} from 'bippy'
import type { HooksNode } from 'bippy/source'
import { type CommitWorkBudget, consumeCommitWork } from './commit-budget'
import {
  clearEffectEvents,
  type PreparedEffectSchedule,
  prepareEffectSchedule,
  publishEffectSchedule,
} from './effect-events'
import type { InstanceDescriptor } from './instance-identity'
import {
  classifyFibersWithinBudget,
  type EffectSourceResolution,
  type FiberClassification,
  isLibraryFile,
  type ResolvedSource,
  resolveEffectSourceResolutionBeforeDeadline,
  sourceLabel,
} from './source'

// React's ReactHookEffectTags, stable across 16.8+/18/19 (bippy doesn't re-export them): HasEffect = will run this commit; the kind bit is fixed per effect.
const HOOK_HAS_EFFECT = 0b0001
const HOOK_INSERTION = 0b0010
const HOOK_LAYOUT = 0b0100
const HOOK_PASSIVE = 0b1000

const EFFECT_WALK_LIMIT = 100
const EFFECT_DEP_SCAN_LIMIT = 200
const EFFECT_REPORT_LIMIT = 500
const EFFECT_SOURCE_ATTRIBUTION_LIMIT = 80
const EFFECT_SOURCE_ATTRIBUTION_BUDGET_MS = 500
const DEFAULT_HOT_MIN_UPDATES = 3
const DEFAULT_HOT_MIN_FIRE_RATE = 1
const HOTNESS_CONFIDENCE_LEVEL = 0.95
const UNCLASSIFIED_FIBER: FiberClassification = { source: null, isLibrary: false }

// Fibers that own a hook effect list; MemoComponentTag wraps an inner fiber that carries the effects as one of these tags, so it's not listed.
const EFFECT_TAGS = new Set<number>([FunctionComponentTag, ForwardRefTag, SimpleMemoComponentTag])

export type EffectKind = 'effect' | 'layout' | 'insertion'
export type DepsMode = 'none' | 'empty' | 'list'

interface EffectStat {
  index: number
  kind: EffectKind
  depsMode: DepsMode
  depCount: number
  updates: number
  scheduled: number
  hasCleanup: boolean
  lastChangedDep: number | null
  /** Whether the last changed dep held a primitive — a value that legitimately changed, not an unstable reference. */
  lastChangedDepIsPrimitive: boolean | null
}

interface EffectRecord {
  id: number
  name: string
  stats: EffectStat[]
  /** The live fiber, kept so source/library classification can run async at report time. */
  fiber: Fiber
}

const records = new Map<number, EffectRecord>()
let truncatedEffectLists = 0

export function clearEffects(): void {
  records.clear()
  truncatedEffectLists = 0
  clearEffectEvents()
}

export interface EffectScheduleObservation {
  scheduled: number
  complete: boolean
}

export interface PreparedEffectObservation {
  observation: EffectScheduleObservation
  publish: (instance?: InstanceDescriptor) => void
}

/** Records at commit time which effects will run this commit (the same `HasEffect` bit React's commit phase checks) and which dependency drove them. */
export function recordEffect(
  fiber: Fiber,
  phase: RenderPhase,
  profileCommitId = 0,
  budget?: CommitWorkBudget,
): EffectScheduleObservation {
  const prepared = prepareEffect(fiber, phase, profileCommitId, budget)
  prepared.publish()
  return prepared.observation
}

/** Build effect stats/events without mutating shared stores; publish only with the render record. */
export function prepareEffect(
  fiber: Fiber,
  phase: RenderPhase,
  profileCommitId = 0,
  budget?: CommitWorkBudget,
): PreparedEffectObservation {
  if (!EFFECT_TAGS.has(fiber.tag)) return preparedEffect({ scheduled: 0, complete: true }, null)

  const id = getFiberId(fiber)
  if (phase === 'unmount') {
    // Traversal unmounts can be Suspense visibility changes; the DevTools unmount callback owns exact deletion.
    return preparedEffect({ scheduled: 0, complete: true }, null)
  }

  const currentList = listEffects(fiber, budget)
  let truncations = currentList.truncated ? 1 : 0
  if (currentList.effects.length === 0) {
    return preparedEffect({ scheduled: 0, complete: !currentList.truncated }, null, [], truncations)
  }
  const previousList = listEffects(fiber.alternate, budget)
  if (previousList.truncated) truncations += 1
  const effects = currentList.effects
  const prev = previousList.effects

  const existing = records.get(id)
  const record: EffectRecord = existing
    ? { ...existing, stats: existing.stats.map((stat) => (stat ? { ...stat } : stat)) }
    : { id, name: getDisplayName(fiber.type) ?? 'Anonymous', stats: [], fiber }
  record.fiber = fiber
  let scheduledCount = 0
  const schedules: PreparedEffectSchedule[] = []

  for (let i = 0; i < effects.length; i++) {
    if (!consumeCommitWork(budget, 'effects')) {
      truncations += 1
      return preparedEffect(
        { scheduled: scheduledCount, complete: false },
        record,
        schedules,
        truncations,
      )
    }
    const effect = effects[i]
    if (!effect) continue
    const kind = effectKind(effect.tag)
    if (!kind) continue
    const depsMode = depsModeOf(effect.deps)
    const depCount = Array.isArray(effect.deps) ? effect.deps.length : 0

    let stat = record.stats[i]
    if (!stat) {
      stat = {
        index: i,
        kind,
        depsMode,
        depCount,
        updates: 0,
        scheduled: 0,
        hasCleanup: false,
        lastChangedDep: null,
        lastChangedDepIsPrimitive: null,
      }
      record.stats[i] = stat
    } else {
      stat.kind = kind
      stat.depsMode = depsMode
      stat.depCount = depCount
    }

    // Turns true once a previous run returned a cleanup — React 18.3+/19 store it at `effect.inst.destroy`, older React at `effect.destroy`.
    if (hasCleanupFn(effect)) stat.hasCleanup = true

    const scheduled = (effect.tag & HOOK_HAS_EFFECT) !== 0
    if (scheduled) {
      scheduledCount += 1
      const prepared = prepareEffectSchedule({
        fiber,
        profileCommitId,
        phase,
        effectIndex: i,
        kind,
        dependencies: effect.deps,
        previousDependencies: prev[i]?.deps ?? null,
        budget,
      })
      if (prepared) schedules.push(prepared)
    }

    if (phase === 'update') {
      stat.updates += 1
      if (scheduled) {
        stat.scheduled += 1
        stat.lastChangedDep = changedDepIndex(effect.deps, prev[i]?.deps ?? null, budget)
        stat.lastChangedDepIsPrimitive =
          stat.lastChangedDep === null
            ? null
            : dependencyIsPrimitive(effect.deps, stat.lastChangedDep)
      }
    }
  }
  return preparedEffect(
    {
      scheduled: scheduledCount,
      complete: !currentList.truncated && !previousList.truncated,
    },
    record,
    schedules,
    truncations,
  )
}

function preparedEffect(
  observation: EffectScheduleObservation,
  record: EffectRecord | null,
  schedules: PreparedEffectSchedule[] = [],
  truncations = 0,
): PreparedEffectObservation {
  let published = false
  return {
    observation,
    publish(instance) {
      if (published) return
      published = true
      truncatedEffectLists += truncations
      if (record) records.set(record.id, record)
      for (const schedule of schedules) publishEffectSchedule(schedule, instance)
    },
  }
}

/** Remove an effect owner only after React's exact onCommitFiberUnmount callback. */
export function removeEffectRecord(fiber: Fiber): void {
  if (EFFECT_TAGS.has(fiber.tag)) records.delete(getFiberId(fiber))
}

/** Exact commit-time count of this component's effects scheduled by React. */
export function scheduledEffectCount(fiber: Fiber): number {
  if (!EFFECT_TAGS.has(fiber.tag)) return 0
  return listEffects(fiber).effects.filter(
    (effect) => effectKind(effect.tag) !== null && (effect.tag & HOOK_HAS_EFFECT) !== 0,
  ).length
}

export function getEffectTrackingCoverage(): { truncatedEffectLists: number } {
  return { truncatedEffectLists }
}

export interface EffectAuditQuery {
  component?: string
  limit: number
  /** Only components with an effect scheduled at the configured hot rate. */
  onlyHot?: boolean
  /** Exclude library components (node_modules, incl. Vite pre-bundled deps). Default true. */
  appOnly?: boolean
  /** Exact library provenance package to retain; callers must disable appOnly. */
  packageName?: string
  /** Minimum observed component updates before an effect can be classified hot. */
  minUpdates?: number
  /** Minimum observed effect fire rate across updates before it is classified hot. */
  minFireRate?: number
  /** Preferred name for the minimum observed schedule rate. */
  minScheduleRate?: number
  /** Internal guard: false means live Fiber attribution advanced while this report awaited source maps. */
  isAttributionCurrent?: () => boolean
  /** Internal dependency injection for a hook tree retained without re-running the component. */
  getRetainedHookTree?: (fiber: Fiber) => HooksNode[] | null
}

export type EffectOwnership = 'app' | 'library' | 'unknown'
export type ProvenanceEvidence = 'exact' | 'inferred' | 'unknown'
export type EffectProvenanceReason =
  | 'exact-hook-order'
  | 'no-user-effect-callsite'
  | 'library-only-hook-tree'
  | 'hook-count-mismatch'
  | 'hook-source-unresolved'
  | 'hook-inspection-unavailable'
  | 'inspection-truncated'
  | 'shadow-render-disabled'
  | 'attribution-budget-exhausted'
  | 'report-state-advanced'

export interface EffectProvenance {
  ownership: EffectOwnership
  evidence: ProvenanceEvidence
  reason: EffectProvenanceReason
  hookSource: ResolvedSource | null
  packageName: string | null
  hookAncestry: EffectHookAncestryFrame[]
}

export interface EffectHookAncestryFrame {
  name: string
  source: ResolvedSource | null
  ownership: EffectOwnership
  packageName: string | null
}

export type EffectHotnessLabel = 'hot' | 'not-hot' | 'insufficient-data'
export type EffectScheduleReason =
  | 'meets-threshold'
  | 'below-schedule-rate'
  | 'below-minimum-updates'

export interface EffectHotness {
  label: EffectHotnessLabel
  samples: number
  observedRate: number
  minUpdates: number
  minScheduleRate: number
  /** Legacy alias for minScheduleRate. */
  minFireRate: number
  confidenceInterval: { level: number; lower: number; upper: number }
  scheduleReason: EffectScheduleReason
  /** Legacy alias whose below-fire-rate value means below schedule rate, not execution. */
  reason: 'meets-threshold' | 'below-fire-rate' | 'below-minimum-updates'
}

export interface EffectFinding {
  index: number
  kind: EffectKind
  depsMode: DepsMode
  depCount: number
  scheduled: number
  schedulesEveryUpdate: boolean
  /** Legacy aliases retained for wire compatibility; both mean scheduled, not executed. */
  fired: number
  updates: number
  firesEveryUpdate: boolean
  lastChangedDep: number | null
  cleanupFunctionObserved: boolean
  /** Legacy alias for cleanupFunctionObserved. */
  hasCleanup: boolean
  note?: string
  /** This effect's own call-site (the `useEffect` call), or null when it cannot be attributed. */
  source: ResolvedSource | null
  /** True when the effect was created inside a library hook (node_modules), not your component. */
  isLibrary: boolean
  provenance: EffectProvenance
  hotness: EffectHotness
}

export interface EffectAuditRecord {
  id: number
  name: string
  source: ResolvedSource | null
  isLibrary: boolean
  componentProvenance: {
    ownership: EffectOwnership
    evidence: 'inferred' | 'unknown'
    reason: 'nearest-symbolicated-fiber' | 'source-unresolved'
    source: ResolvedSource | null
  }
  effects: EffectFinding[]
  effectsOmitted: number
}

export interface EffectHotnessCriteria {
  minUpdates: number
  minScheduleRate: number
  /** Legacy alias for minScheduleRate. */
  minFireRate: number
  confidenceLevel: number
}

const totalEffects = (findings: EffectAuditRecord[]): number =>
  findings.reduce((sum, record) => sum + record.effects.length, 0)

/** The audited components plus the count of library-origin effects appOnly hid — for react_effect_audit's filteredNote. */
export async function getEffectAuditReport(query: EffectAuditQuery): Promise<{
  components: EffectAuditRecord[]
  omittedByLimit: number
  effectsOmittedByLimit: number
  libraryEffectsHidden: number
  hotnessCriteria: EffectHotnessCriteria
  packageFilter?: {
    packageName: string
    matchedEffects: number
    excludedEffects: number
    unknownPackageEffects: number
  }
}> {
  let list = snapshotEffectRecords()
  if (query.component) {
    const needle = query.component.toLowerCase()
    list = list.filter((record) => record.name.toLowerCase().includes(needle))
  }

  const appOnly = query.appOnly ?? true
  const minScheduleRate = query.minScheduleRate ?? query.minFireRate ?? DEFAULT_HOT_MIN_FIRE_RATE
  const hotnessCriteria: EffectHotnessCriteria = {
    minUpdates: query.minUpdates ?? DEFAULT_HOT_MIN_UPDATES,
    minScheduleRate,
    minFireRate: minScheduleRate,
    confidenceLevel: HOTNESS_CONFIDENCE_LEVEL,
  }
  const [{ classes: resolvedClasses }, resolvedEffectSourcesByIndex] = await Promise.all([
    classifyFibersWithinBudget(
      list.map((record) => record.fiber),
      {
        limit: EFFECT_SOURCE_ATTRIBUTION_LIMIT,
        budgetMs: EFFECT_SOURCE_ATTRIBUTION_BUDGET_MS,
      },
    ),
    resolveEffectSourcesWithinBudget(list, query.getRetainedHookTree),
  ])
  const attributionCurrent = query.isAttributionCurrent?.() !== false
  const classes = attributionCurrent ? resolvedClasses : list.map(() => UNCLASSIFIED_FIBER)
  const effectSourcesByIndex = attributionCurrent
    ? resolvedEffectSourcesByIndex
    : list.map(staleReportResolution)
  const all: EffectAuditRecord[] = list.map((record, index) => {
    const { source, isLibrary } = classes[index] ?? UNCLASSIFIED_FIBER
    const name = record.name === 'Anonymous' ? (sourceLabel(source) ?? record.name) : record.name
    const stats = record.stats.filter(Boolean)
    const effectSourceResolution = effectSourcesByIndex[index] ?? budgetExceededResolution()
    const componentOwnership: EffectOwnership = source ? (isLibrary ? 'library' : 'app') : 'unknown'
    return {
      id: record.id,
      name,
      source,
      isLibrary,
      componentProvenance: {
        ownership: componentOwnership,
        evidence: source ? 'inferred' : 'unknown',
        reason: source ? 'nearest-symbolicated-fiber' : 'source-unresolved',
        source,
      },
      effects: stats.map((stat, position) => {
        const provenance = effectProvenance(effectSourceResolution, stats.length, position)
        return {
          ...toFinding(stat, hotnessCriteria),
          source: provenance.hookSource,
          isLibrary: provenance.ownership === 'library',
          provenance,
        }
      }),
      effectsOmitted: 0,
    }
  })

  let findings = all
  let libraryEffectsHidden = 0
  let packageFilter:
    | {
        packageName: string
        matchedEffects: number
        excludedEffects: number
        unknownPackageEffects: number
      }
    | undefined
  if (query.packageName !== undefined) {
    const allEffects = all.flatMap((record) => record.effects)
    const unknownPackageEffects = allEffects.filter(
      (effect) => effect.provenance.packageName === null,
    ).length
    findings = all
      .map((record) => ({
        ...record,
        effects: record.effects.filter(
          (effect) => effect.provenance.packageName === query.packageName,
        ),
        effectsOmitted: record.effectsOmitted,
      }))
      .filter((record) => record.effects.length > 0)
    const matchedEffects = totalEffects(findings)
    packageFilter = {
      packageName: query.packageName,
      matchedEffects,
      excludedEffects: allEffects.length - matchedEffects,
      unknownPackageEffects,
    }
  }
  if (appOnly) {
    findings = all
      .map((record) => ({
        ...record,
        effects: record.effects.filter((effect) => effect.provenance.ownership !== 'library'),
        effectsOmitted: record.effectsOmitted,
      }))
      .filter(
        (record) =>
          record.effects.length > 0 &&
          (record.componentProvenance.ownership !== 'library' ||
            record.effects.some((effect) => effect.provenance.ownership === 'app')),
      )
    libraryEffectsHidden = totalEffects(all) - totalEffects(findings)
  }
  if (query.onlyHot) {
    findings = findings
      .map((record) => ({
        ...record,
        effects: record.effects.filter((effect) => effect.hotness.label === 'hot'),
        effectsOmitted: record.effectsOmitted,
      }))
      .filter((record) => record.effects.length > 0)
  }
  findings.sort((a, b) => score(b) - score(a))
  const omittedByLimit = Math.max(0, findings.length - query.limit)
  const selected = findings.slice(0, query.limit)
  let remainingEffects = EFFECT_REPORT_LIMIT
  let effectsOmittedByLimit = 0
  const components = selected.map((record) => {
    const effects = record.effects.slice(0, remainingEffects)
    const effectsOmitted = record.effectsOmitted + record.effects.length - effects.length
    remainingEffects -= effects.length
    effectsOmittedByLimit += effectsOmitted
    return { ...record, effects, effectsOmitted }
  })
  return {
    components,
    omittedByLimit,
    effectsOmittedByLimit,
    libraryEffectsHidden,
    hotnessCriteria,
    ...(packageFilter === undefined ? {} : { packageFilter }),
  }
}

function snapshotEffectRecords(): EffectRecord[] {
  return [...records.values()].map((record) => ({
    ...record,
    stats: record.stats.map((stat) => (stat ? { ...stat } : stat)),
  }))
}

async function resolveEffectSourcesWithinBudget(
  recordsToAttribute: EffectRecord[],
  getRetainedHookTree?: (fiber: Fiber) => HooksNode[] | null,
): Promise<EffectSourceResolution[]> {
  const sources = recordsToAttribute.map(budgetExceededResolution)
  const startedAt = Date.now()
  const limit = Math.min(recordsToAttribute.length, EFFECT_SOURCE_ATTRIBUTION_LIMIT)

  for (let index = 0; index < limit; index += 1) {
    const remaining = EFFECT_SOURCE_ATTRIBUTION_BUDGET_MS - (Date.now() - startedAt)
    if (remaining <= 0) break

    const record = recordsToAttribute[index]
    if (!record) break
    let retainedHooks: HooksNode[] | null | undefined
    if (getRetainedHookTree) {
      try {
        retainedHooks = getRetainedHookTree(record.fiber)
      } catch {
        retainedHooks = null
      }
    }
    sources[index] = await resolveEffectSourceResolutionBeforeDeadline(
      record.fiber,
      remaining,
      retainedHooks,
    )
  }

  return sources
}

// Surface re-run/loop smells first, then the most active effects.
function score(record: EffectAuditRecord): number {
  let total = 0
  for (const effect of record.effects) {
    if (effect.hotness.label === 'hot') total += 1_000_000
    total += effect.scheduled
  }
  return total
}

function toFinding(
  stat: EffectStat,
  criteria: EffectHotnessCriteria,
): Omit<EffectFinding, 'source' | 'isLibrary' | 'provenance'> {
  const schedulesEveryUpdate = stat.updates > 0 && stat.scheduled === stat.updates
  const hotness = classifyHotness(stat, criteria)
  return {
    index: stat.index,
    kind: stat.kind,
    depsMode: stat.depsMode,
    depCount: stat.depCount,
    scheduled: stat.scheduled,
    schedulesEveryUpdate,
    fired: stat.scheduled,
    updates: stat.updates,
    firesEveryUpdate: schedulesEveryUpdate,
    lastChangedDep: stat.lastChangedDep,
    cleanupFunctionObserved: stat.hasCleanup,
    hasCleanup: stat.hasCleanup,
    note: noteFor(stat, hotness),
    hotness,
  }
}

function noteFor(stat: EffectStat, hotness: EffectHotness): string | undefined {
  if (hotness.label !== 'hot') return undefined
  const hookName = stat.kind === 'layout' ? 'useLayoutEffect' : 'useEffect'
  if (stat.depsMode === 'none' && stat.scheduled > 0) {
    return `no dependency array — React scheduled this ${hookName} on ${stat.scheduled}/${stat.updates} updates; add dependencies only if repeated scheduling is unintended`
  }
  if (stat.depsMode === 'list') {
    const slot =
      stat.lastChangedDep === null ? 'a dependency' : `dependency [${stat.lastChangedDep}]`
    // A changed primitive is a real value change (maybe intended); only reference churn is fixable with memoization.
    return stat.lastChangedDepIsPrimitive
      ? `scheduled on ${stat.scheduled}/${stat.updates} updates — ${slot} changes value; verify whether that synchronization is intended and whether it writes the same value`
      : `scheduled on ${stat.scheduled}/${stat.updates} updates — ${slot} changes reference; trace its producer before deciding whether to stabilize it`
  }
  return undefined
}

function classifyHotness(stat: EffectStat, criteria: EffectHotnessCriteria): EffectHotness {
  const samples = stat.updates
  const observedRate = samples === 0 ? 0 : stat.scheduled / samples
  const scheduleReason: EffectScheduleReason =
    samples < criteria.minUpdates
      ? 'below-minimum-updates'
      : observedRate >= criteria.minScheduleRate
        ? 'meets-threshold'
        : 'below-schedule-rate'
  const label: EffectHotnessLabel =
    scheduleReason === 'below-minimum-updates'
      ? 'insufficient-data'
      : scheduleReason === 'meets-threshold'
        ? 'hot'
        : 'not-hot'
  const [lower, upper] = wilsonInterval(stat.scheduled, samples)
  return {
    label,
    samples,
    observedRate: roundRate(observedRate),
    minUpdates: criteria.minUpdates,
    minScheduleRate: criteria.minScheduleRate,
    minFireRate: criteria.minFireRate,
    confidenceInterval: {
      level: criteria.confidenceLevel,
      lower: roundRate(lower),
      upper: roundRate(upper),
    },
    scheduleReason,
    reason: scheduleReason === 'below-schedule-rate' ? 'below-fire-rate' : scheduleReason,
  }
}

/** 95% Wilson score interval for a binomial schedule rate; stable even at 0/n and n/n. */
function wilsonInterval(successes: number, samples: number): [number, number] {
  if (samples === 0) return [0, 1]
  const z = 1.959963984540054
  const rate = successes / samples
  const zSquared = z * z
  const denominator = 1 + zSquared / samples
  const center = (rate + zSquared / (2 * samples)) / denominator
  const margin =
    (z * Math.sqrt((rate * (1 - rate) + zSquared / (4 * samples)) / samples)) / denominator
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function budgetExceededResolution(): EffectSourceResolution {
  return { status: 'deadline-exceeded', sources: null, callsites: null }
}

function staleReportResolution(): EffectSourceResolution {
  return { status: 'report-state-advanced', sources: null, callsites: null }
}

function effectProvenance(
  resolution: EffectSourceResolution,
  effectCount: number,
  position: number,
): EffectProvenance {
  if (resolution.status === 'report-state-advanced') {
    return unknownProvenance('report-state-advanced')
  }
  if (resolution.status === 'deadline-exceeded') {
    return unknownProvenance('attribution-budget-exhausted')
  }
  if (resolution.status === 'inspection-unavailable') {
    return unknownProvenance('hook-inspection-unavailable')
  }
  if (resolution.status === 'inspection-truncated') {
    return unknownProvenance('inspection-truncated')
  }
  if (resolution.status === 'shadow-render-disabled') {
    return unknownProvenance('shadow-render-disabled')
  }
  if (resolution.status === 'no-user-effects') {
    return {
      ownership: 'library',
      evidence: 'inferred',
      reason: 'no-user-effect-callsite',
      hookSource: null,
      packageName: null,
      hookAncestry: [],
    }
  }

  const sources = resolution.sources ?? []
  if (sources.length === effectCount) {
    const hookSource = sources[position] ?? null
    const hookAncestry = effectHookAncestry(resolution, position)
    if (!hookSource) return unknownProvenance('hook-source-unresolved', hookAncestry)
    const ownership: EffectOwnership = isLibraryFile(hookSource.file) ? 'library' : 'app'
    return {
      ownership,
      evidence: 'exact',
      reason: 'exact-hook-order',
      hookSource,
      packageName: ownership === 'library' ? packageNameFromFile(hookSource.file) : null,
      hookAncestry,
    }
  }

  if (sources.length > 0 && sources.every((source) => source && isLibraryFile(source.file))) {
    return {
      ownership: 'library',
      evidence: 'inferred',
      reason: 'library-only-hook-tree',
      hookSource: null,
      packageName: commonPackageName(sources),
      hookAncestry: [],
    }
  }
  return unknownProvenance('hook-count-mismatch')
}

function unknownProvenance(
  reason: EffectProvenanceReason,
  hookAncestry: EffectHookAncestryFrame[] = [],
): EffectProvenance {
  return {
    ownership: 'unknown',
    evidence: 'unknown',
    reason,
    hookSource: null,
    packageName: null,
    hookAncestry,
  }
}

function effectHookAncestry(
  resolution: EffectSourceResolution,
  position: number,
): EffectHookAncestryFrame[] {
  return (resolution.callsites?.[position]?.hookAncestry ?? []).map((frame) => {
    const ownership: EffectOwnership = frame.source
      ? isLibraryFile(frame.source.file)
        ? 'library'
        : 'app'
      : 'unknown'
    return {
      name: frame.name,
      source: frame.source,
      ownership,
      packageName:
        ownership === 'library' && frame.source ? packageNameFromFile(frame.source.file) : null,
    }
  })
}

function commonPackageName(sources: (ResolvedSource | null)[]): string | null {
  const packages = new Set(
    sources
      .map((source) => (source ? packageNameFromFile(source.file) : null))
      .filter((name): name is string => name !== null),
  )
  return packages.size === 1 ? ([...packages][0] ?? null) : null
}

function packageNameFromFile(file: string): string | null {
  const normalized = file.replaceAll('\\', '/')
  const nodeModules = normalized.lastIndexOf('/node_modules/')
  if (nodeModules < 0) return null
  const path = normalized.slice(nodeModules + '/node_modules/'.length)
  if (path.startsWith('.vite/deps/')) {
    const base = path
      .slice('.vite/deps/'.length)
      .split('/')[0]
      ?.replace(/\.[cm]?js.*$/, '')
    if (!base || base.startsWith('chunk-') || /-[A-Za-z0-9_]{8}$/.test(base)) return null
    return base.startsWith('@') ? base.replace('_', '/') : base
  }
  const [first, second] = path.split('/')
  if (!first) return null
  return first.startsWith('@') && second ? `${first}/${second}` : first
}

function listEffects(
  fiber: Fiber | null | undefined,
  budget?: CommitWorkBudget,
): {
  effects: Effect[]
  truncated: boolean
} {
  const last: Effect | null = fiber?.updateQueue?.lastEffect ?? null
  const first = last?.next ?? null
  if (!first) return { effects: [], truncated: false }
  const list: Effect[] = []
  let effect: Effect | null = first
  let guard = 0
  while (effect && guard < EFFECT_WALK_LIMIT) {
    if (!consumeCommitWork(budget, 'effect-list')) {
      return { effects: list, truncated: true }
    }
    list.push(effect)
    effect = effect.next
    guard += 1
    if (effect === first) break
  }
  return { effects: list, truncated: effect !== first }
}

function hasCleanupFn(effect: Effect): boolean {
  if (typeof effect.destroy === 'function') return true
  const inst = (effect as { inst?: { destroy?: unknown } }).inst
  return typeof inst?.destroy === 'function'
}

function effectKind(tag: number): EffectKind | null {
  if ((tag & HOOK_PASSIVE) !== 0) return 'effect'
  if ((tag & HOOK_LAYOUT) !== 0) return 'layout'
  if ((tag & HOOK_INSERTION) !== 0) return 'insertion'
  return null
}

function depsModeOf(deps: unknown[] | null): DepsMode {
  if (deps == null) return 'none'
  return deps.length === 0 ? 'empty' : 'list'
}

function isPrimitive(value: unknown): boolean {
  return (typeof value !== 'object' && typeof value !== 'function') || value === null
}

function changedDepIndex(
  next: unknown[] | null,
  prev: unknown[] | null,
  budget?: CommitWorkBudget,
): number | null {
  if (!Array.isArray(next) || !Array.isArray(prev)) return null
  const len = Math.min(next.length, prev.length, EFFECT_DEP_SCAN_LIMIT)
  for (let i = 0; i < len; i++) {
    if (!consumeCommitWork(budget, 'effect-dependencies')) return null
    try {
      if (!Object.is(next[i], prev[i])) return i
    } catch {
      return null
    }
  }
  return null
}

function dependencyIsPrimitive(dependencies: unknown[] | null, index: number): boolean | null {
  try {
    return isPrimitive(dependencies?.[index])
  } catch {
    return null
  }
}
