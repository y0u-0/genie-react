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

const EFFECT_WALK_LIMIT = 1000
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
  fired: number
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

export function clearEffects(): void {
  records.clear()
}

/** Records at commit time which effects will run this commit (the same `HasEffect` bit React's commit phase checks) and which dependency drove them. */
export function recordEffect(fiber: Fiber, phase: RenderPhase): void {
  if (!EFFECT_TAGS.has(fiber.tag)) return

  const id = getFiberId(fiber)
  if (phase === 'unmount') {
    records.delete(id)
    return
  }

  const effects = listEffects(fiber)
  if (effects.length === 0) return
  const prev = listEffects(fiber.alternate)

  let record = records.get(id)
  if (!record) {
    record = { id, name: getDisplayName(fiber.type) ?? 'Anonymous', stats: [], fiber }
    records.set(id, record)
  }
  record.fiber = fiber

  for (let i = 0; i < effects.length; i++) {
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
        fired: 0,
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

    if (phase === 'update') {
      stat.updates += 1
      if ((effect.tag & HOOK_HAS_EFFECT) !== 0) {
        stat.fired += 1
        stat.lastChangedDep = changedDepIndex(effect.deps, prev[i]?.deps ?? null)
        stat.lastChangedDepIsPrimitive =
          stat.lastChangedDep === null ? null : isPrimitive(effect.deps?.[stat.lastChangedDep])
      }
    }
  }
}

export interface EffectAuditQuery {
  component?: string
  limit: number
  /** Only components with an effect that re-runs every update or has no deps array. */
  onlyHot?: boolean
  /** Exclude library components (node_modules, incl. Vite pre-bundled deps). Default true. */
  appOnly?: boolean
  /** Minimum observed component updates before an effect can be classified hot. */
  minUpdates?: number
  /** Minimum observed effect fire rate across updates before it is classified hot. */
  minFireRate?: number
}

export type EffectOwnership = 'app' | 'library' | 'unknown'
export type ProvenanceConfidence = 'high' | 'medium' | 'none'
export type EffectProvenanceReason =
  | 'exact-hook-order'
  | 'no-user-effect-callsite'
  | 'library-only-hook-tree'
  | 'hook-count-mismatch'
  | 'hook-source-unresolved'
  | 'hook-inspection-unavailable'
  | 'attribution-budget-exhausted'

export interface EffectProvenance {
  ownership: EffectOwnership
  confidence: ProvenanceConfidence
  reason: EffectProvenanceReason
  hookSource: ResolvedSource | null
  packageName: string | null
}

export type EffectHotnessLabel = 'hot' | 'not-hot' | 'insufficient-data'

export interface EffectHotness {
  label: EffectHotnessLabel
  samples: number
  observedRate: number
  minUpdates: number
  minFireRate: number
  confidenceInterval: { level: number; lower: number; upper: number }
  reason: 'meets-threshold' | 'below-fire-rate' | 'below-minimum-updates'
}

export interface EffectFinding {
  index: number
  kind: EffectKind
  depsMode: DepsMode
  depCount: number
  fired: number
  updates: number
  firesEveryUpdate: boolean
  lastChangedDep: number | null
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
    confidence: 'medium' | 'none'
    reason: 'nearest-symbolicated-fiber' | 'source-unresolved'
    source: ResolvedSource | null
  }
  effects: EffectFinding[]
}

export interface EffectHotnessCriteria {
  minUpdates: number
  minFireRate: number
  confidenceLevel: number
}

const totalEffects = (findings: EffectAuditRecord[]): number =>
  findings.reduce((sum, record) => sum + record.effects.length, 0)

/** The audited components plus the count of library-origin effects appOnly hid — for react_effect_audit's filteredNote. */
export async function getEffectAuditReport(query: EffectAuditQuery): Promise<{
  components: EffectAuditRecord[]
  libraryEffectsHidden: number
  hotnessCriteria: EffectHotnessCriteria
}> {
  let list = [...records.values()]
  if (query.component) {
    const needle = query.component.toLowerCase()
    list = list.filter((record) => record.name.toLowerCase().includes(needle))
  }

  const appOnly = query.appOnly ?? true
  const hotnessCriteria: EffectHotnessCriteria = {
    minUpdates: query.minUpdates ?? DEFAULT_HOT_MIN_UPDATES,
    minFireRate: query.minFireRate ?? DEFAULT_HOT_MIN_FIRE_RATE,
    confidenceLevel: HOTNESS_CONFIDENCE_LEVEL,
  }
  const { classes } = await classifyFibersWithinBudget(
    list.map((record) => record.fiber),
    { limit: EFFECT_SOURCE_ATTRIBUTION_LIMIT, budgetMs: EFFECT_SOURCE_ATTRIBUTION_BUDGET_MS },
  )
  const effectSourcesByIndex = await resolveEffectSourcesWithinBudget(list)
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
        confidence: source ? 'medium' : 'none',
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
    }
  })

  let findings = all
  let libraryEffectsHidden = 0
  if (appOnly) {
    findings = all
      .map((record) => ({
        ...record,
        effects: record.effects.filter((effect) => effect.provenance.ownership !== 'library'),
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
      }))
      .filter((record) => record.effects.length > 0)
  }
  findings.sort((a, b) => score(b) - score(a))
  return {
    components: findings.slice(0, query.limit),
    libraryEffectsHidden,
    hotnessCriteria,
  }
}

async function resolveEffectSourcesWithinBudget(
  recordsToAttribute: EffectRecord[],
): Promise<EffectSourceResolution[]> {
  const sources = recordsToAttribute.map(budgetExceededResolution)
  const startedAt = Date.now()
  const limit = Math.min(recordsToAttribute.length, EFFECT_SOURCE_ATTRIBUTION_LIMIT)

  for (let index = 0; index < limit; index += 1) {
    const remaining = EFFECT_SOURCE_ATTRIBUTION_BUDGET_MS - (Date.now() - startedAt)
    if (remaining <= 0) break

    const record = recordsToAttribute[index]
    if (!record) break
    sources[index] = await resolveEffectSourceResolutionBeforeDeadline(record.fiber, remaining)
  }

  return sources
}

// Surface re-run/loop smells first, then the most active effects.
function score(record: EffectAuditRecord): number {
  let total = 0
  for (const effect of record.effects) {
    if (effect.hotness.label === 'hot') total += 1_000_000
    total += effect.fired
  }
  return total
}

function toFinding(
  stat: EffectStat,
  criteria: EffectHotnessCriteria,
): Omit<EffectFinding, 'source' | 'isLibrary' | 'provenance'> {
  const firesEveryUpdate = stat.updates > 0 && stat.fired === stat.updates
  const hotness = classifyHotness(stat, criteria)
  return {
    index: stat.index,
    kind: stat.kind,
    depsMode: stat.depsMode,
    depCount: stat.depCount,
    fired: stat.fired,
    updates: stat.updates,
    firesEveryUpdate,
    lastChangedDep: stat.lastChangedDep,
    hasCleanup: stat.hasCleanup,
    note: noteFor(stat, hotness),
    hotness,
  }
}

function noteFor(stat: EffectStat, hotness: EffectHotness): string | undefined {
  if (hotness.label !== 'hot') return undefined
  const hookName = stat.kind === 'layout' ? 'useLayoutEffect' : 'useEffect'
  if (stat.depsMode === 'none' && stat.fired > 0) {
    return `no dependency array — this ${hookName} runs after every render (ran on ${stat.fired}/${stat.updates} updates); add a deps array if it should not`
  }
  if (stat.depsMode === 'list') {
    const slot =
      stat.lastChangedDep === null ? 'a dependency' : `dependency [${stat.lastChangedDep}]`
    // A changed primitive is a real value change (maybe intended); only reference churn is fixable with memoization.
    return stat.lastChangedDepIsPrimitive
      ? `re-runs on ${stat.fired}/${stat.updates} updates — ${slot} changes value; intended for state that changes per interaction, a loop smell if this effect also sets that state`
      : `re-runs on ${stat.fired}/${stat.updates} updates — ${slot} changes reference (likely unstable); stabilize it with useMemo/useCallback or drop it from deps`
  }
  return undefined
}

function classifyHotness(stat: EffectStat, criteria: EffectHotnessCriteria): EffectHotness {
  const samples = stat.updates
  const observedRate = samples === 0 ? 0 : stat.fired / samples
  const reason =
    samples < criteria.minUpdates
      ? 'below-minimum-updates'
      : observedRate >= criteria.minFireRate
        ? 'meets-threshold'
        : 'below-fire-rate'
  const label: EffectHotnessLabel =
    reason === 'below-minimum-updates'
      ? 'insufficient-data'
      : reason === 'meets-threshold'
        ? 'hot'
        : 'not-hot'
  const [lower, upper] = wilsonInterval(stat.fired, samples)
  return {
    label,
    samples,
    observedRate: roundRate(observedRate),
    minUpdates: criteria.minUpdates,
    minFireRate: criteria.minFireRate,
    confidenceInterval: {
      level: criteria.confidenceLevel,
      lower: roundRate(lower),
      upper: roundRate(upper),
    },
    reason,
  }
}

/** 95% Wilson score interval for a binomial firing rate; stable even at 0/n and n/n. */
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
  return { status: 'deadline-exceeded', sources: null }
}

function effectProvenance(
  resolution: EffectSourceResolution,
  effectCount: number,
  position: number,
): EffectProvenance {
  if (resolution.status === 'deadline-exceeded') {
    return unknownProvenance('attribution-budget-exhausted')
  }
  if (resolution.status === 'inspection-unavailable') {
    return unknownProvenance('hook-inspection-unavailable')
  }
  if (resolution.status === 'no-user-effects') {
    return {
      ownership: 'library',
      confidence: 'medium',
      reason: 'no-user-effect-callsite',
      hookSource: null,
      packageName: null,
    }
  }

  const sources = resolution.sources ?? []
  if (sources.length === effectCount) {
    const hookSource = sources[position] ?? null
    if (!hookSource) return unknownProvenance('hook-source-unresolved')
    const ownership: EffectOwnership = isLibraryFile(hookSource.file) ? 'library' : 'app'
    return {
      ownership,
      confidence: 'high',
      reason: 'exact-hook-order',
      hookSource,
      packageName: ownership === 'library' ? packageNameFromFile(hookSource.file) : null,
    }
  }

  if (sources.length > 0 && sources.every((source) => source && isLibraryFile(source.file))) {
    return {
      ownership: 'library',
      confidence: 'medium',
      reason: 'library-only-hook-tree',
      hookSource: null,
      packageName: commonPackageName(sources),
    }
  }
  return unknownProvenance('hook-count-mismatch')
}

function unknownProvenance(reason: EffectProvenanceReason): EffectProvenance {
  return { ownership: 'unknown', confidence: 'none', reason, hookSource: null, packageName: null }
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

function listEffects(fiber: Fiber | null | undefined): Effect[] {
  const last: Effect | null = fiber?.updateQueue?.lastEffect ?? null
  const first = last?.next ?? null
  if (!first) return []
  const list: Effect[] = []
  let effect: Effect | null = first
  let guard = 0
  while (effect && guard < EFFECT_WALK_LIMIT) {
    list.push(effect)
    effect = effect.next
    guard += 1
    if (effect === first) break
  }
  return list
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

function changedDepIndex(next: unknown[] | null, prev: unknown[] | null): number | null {
  if (!Array.isArray(next) || !Array.isArray(prev)) return null
  const len = Math.min(next.length, prev.length)
  for (let i = 0; i < len; i++) {
    if (!Object.is(next[i], prev[i])) return i
  }
  return null
}
