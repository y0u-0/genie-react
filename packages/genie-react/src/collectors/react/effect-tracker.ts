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
  classifyFiber,
  isLibraryFile,
  type ResolvedSource,
  resolveEffectSources,
  sourceLabel,
} from './source'

// React's ReactHookEffectTags, stable across 16.8+/18/19 (bippy doesn't re-export them): HasEffect = will run this commit; the kind bit is fixed per effect.
const HOOK_HAS_EFFECT = 0b0001
const HOOK_INSERTION = 0b0010
const HOOK_LAYOUT = 0b0100
const HOOK_PASSIVE = 0b1000

const EFFECT_WALK_LIMIT = 1000

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
}

export interface EffectAuditRecord {
  id: number
  name: string
  source: ResolvedSource | null
  isLibrary: boolean
  effects: EffectFinding[]
}

export async function getEffectAudit(query: EffectAuditQuery): Promise<EffectAuditRecord[]> {
  let list = [...records.values()]
  if (query.component) {
    const needle = query.component.toLowerCase()
    list = list.filter((record) => record.name.toLowerCase().includes(needle))
  }

  const appOnly = query.appOnly ?? true
  let findings: EffectAuditRecord[] = await Promise.all(
    list.map(async (record) => {
      const { source, isLibrary } = await classifyFiber(record.fiber)
      const name = record.name === 'Anonymous' ? (sourceLabel(source) ?? record.name) : record.name
      const stats = record.stats.filter(Boolean)
      const effectSources = await resolveEffectSources(record.fiber)
      // Internal hooks (useSyncExternalStore, useActionState) push commit-list effects the inspector never reports: map 1:1 only when lengths match; inspected with no app effect ⇒ the whole list is library/internal noise; otherwise attribution is unsafe.
      const aligned = effectSources !== null && effectSources.length === stats.length
      const noAppEffect =
        effectSources !== null &&
        !effectSources.some((src) => src !== null && !isLibraryFile(src.file))
      return {
        id: record.id,
        name,
        source,
        isLibrary,
        effects: stats.map((stat, position) => {
          const effectSource = aligned && effectSources ? effectSources[position] : null
          return {
            ...toFinding(stat),
            source: effectSource ?? null,
            isLibrary: effectSource ? isLibraryFile(effectSource.file) : noAppEffect,
          }
        }),
      }
    }),
  )

  if (appOnly) {
    findings = findings
      .map((record) => ({ ...record, effects: record.effects.filter((e) => !e.isLibrary) }))
      .filter((record) => !record.isLibrary && record.effects.length > 0)
  }
  if (query.onlyHot) findings = findings.filter((record) => record.effects.some((e) => e.note))
  findings.sort((a, b) => score(b) - score(a))
  return findings.slice(0, query.limit)
}

// Surface re-run/loop smells first, then the most active effects.
function score(record: EffectAuditRecord): number {
  let total = 0
  for (const effect of record.effects) {
    if (effect.note) total += 1_000_000
    total += effect.fired
  }
  return total
}

function toFinding(stat: EffectStat): Omit<EffectFinding, 'source' | 'isLibrary'> {
  const firesEveryUpdate = stat.updates > 0 && stat.fired === stat.updates
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
    note: noteFor(stat, firesEveryUpdate),
  }
}

function noteFor(stat: EffectStat, firesEveryUpdate: boolean): string | undefined {
  const hookName = stat.kind === 'layout' ? 'useLayoutEffect' : 'useEffect'
  if (stat.depsMode === 'none' && stat.fired > 0) {
    return `no dependency array — this ${hookName} runs after every render (ran on ${stat.fired}/${stat.updates} updates); add a deps array if it should not`
  }
  if (stat.depsMode === 'list' && firesEveryUpdate && stat.updates > 1) {
    const slot =
      stat.lastChangedDep === null ? 'a dependency' : `dependency [${stat.lastChangedDep}]`
    // A changed primitive is a real value change (maybe intended); only reference churn is fixable with memoization.
    return stat.lastChangedDepIsPrimitive
      ? `re-runs on every update (${stat.fired}/${stat.updates}) — ${slot} changes value each commit; intended for state that changes per interaction, a loop smell if this effect also sets that state`
      : `re-runs on every update (${stat.fired}/${stat.updates}) — ${slot} changes reference each commit (likely unstable); stabilize it with useMemo/useCallback or drop it from deps`
  }
  return undefined
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
