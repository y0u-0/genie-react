import { decode } from '@jridgewell/sourcemap-codec'
import { type Fiber, getFiberId, getLatestFiber } from 'bippy'
import {
  getFiberHooks,
  getSource,
  getSourceFromSourceMap,
  getSourceMap,
  type HookSource,
  type HooksNode,
  isSourceFile,
  normalizeFileName,
  type SourceMap,
} from 'bippy/source'

export interface ResolvedSource {
  file: string
  line: number | null
  column: number | null
  functionName: string | null
}

export interface FiberClassification {
  source: ResolvedSource | null
  isLibrary: boolean
}

export type EffectSourceResolutionStatus =
  | 'resolved'
  | 'no-user-effects'
  | 'inspection-unavailable'
  | 'deadline-exceeded'

export interface EffectSourceResolution {
  status: EffectSourceResolutionStatus
  sources: (ResolvedSource | null)[] | null
}

const cache = new Map<number, ResolvedSource>()
const pendingSource = new Map<number, Promise<ResolvedSource | null>>()
const effectSourceCache = new Map<number, (ResolvedSource | null)[]>()
const ANCESTOR_HOPS = 20
const DEFAULT_CLASSIFY_LIMIT = 120
const DEFAULT_CLASSIFY_BUDGET_MS = 500
const UNCLASSIFIED_FIBER: FiberClassification = { source: null, isLibrary: false }

export function clearSourceCache(): void {
  cache.clear()
  pendingSource.clear()
  effectSourceCache.clear()
  moduleMapCache.clear()
}

/** Fiber → definition site via bippy's `_debugStack` symbolication (React 19 dropped `_debugSource`), so async and network-bound; only successes are cached, letting a transient null (e.g. right after HMR) recover. */
export async function resolveSource(fiber: Fiber): Promise<ResolvedSource | null> {
  const id = getFiberId(fiber)
  const cached = cache.get(id)
  if (cached) return cached
  const pending = pendingSource.get(id)
  if (pending) return pending

  const lookup = (async () => {
    try {
      const source = await getSource(getLatestFiber(fiber) ?? fiber)
      if (!source?.fileName) return null
      const servedFile = normalizeFileName(source.fileName)
      const original = await toOriginalPosition(
        source.fileName,
        source.lineNumber ?? null,
        source.columnNumber ?? null,
      )
      const resolved: ResolvedSource = {
        file: preferOriginalAppFile(servedFile, original.file),
        line: original.line,
        column: original.column,
        functionName: source.functionName ?? null,
      }
      cache.set(id, resolved)
      return resolved
    } catch {
      return null
    } finally {
      pendingSource.delete(id)
    }
  })()
  pendingSource.set(id, lookup)
  return lookup
}

/** A file outside the project tree is a library. Turbopack can expose app fibers as unmapped dev chunks; dependencies still resolve to node_modules paths. */
export function isLibraryFile(file: string): boolean {
  if (file.replaceAll('\\', '/').includes('/.next/dev/server/chunks/')) return false
  return !isSourceFile(file)
}

/** App vs library by resolved source, climbing to the nearest ancestor that resolves; unresolved stays app so a missing source never silently hides a component. */
export async function classifyFiber(fiber: Fiber): Promise<FiberClassification> {
  let current: Fiber | null = fiber
  for (let hops = 0; current && hops < ANCESTOR_HOPS; hops++) {
    const source = await resolveSource(current)
    if (source) return { source, isLibrary: isLibraryFile(source.file) }
    current = current.return
  }
  return { source: null, isLibrary: false }
}

export async function classifyFiberBeforeDeadline(
  fiber: Fiber,
  timeoutMs: number,
): Promise<FiberClassification | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      classifyFiber(fiber),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs))
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Cache-only classification: exact when the fiber itself resolved before, null when unknown (never guesses via ancestors, which classifyFiber resolves differently). */
function classifyFiberFromCache(fiber: Fiber): FiberClassification | null {
  const cached = cache.get(getFiberId(fiber))
  return cached ? { source: cached, isLibrary: isLibraryFile(cached.file) } : null
}

// Cache hits are free and bypass the budget, so repeated reads warm the whole set ~limit fibers per call until partial goes false; only network-bound resolutions spend limit/budgetMs.
export async function classifyFibersWithinBudget(
  fibers: Fiber[],
  options: { limit?: number; budgetMs?: number } = {},
): Promise<{ classes: FiberClassification[]; partial: boolean }> {
  const classes = fibers.map(() => UNCLASSIFIED_FIBER)
  const startedAt = Date.now()
  const limit = options.limit ?? DEFAULT_CLASSIFY_LIMIT
  // While the off-call warmer is draining, the call keeps only a token budget: return fast and partial instead of re-spending the full budget the warmer will cover anyway.
  const budgetMs = warmupRunning
    ? WARMING_CALL_BUDGET_MS
    : (options.budgetMs ?? DEFAULT_CLASSIFY_BUDGET_MS)
  let resolved = 0
  let partial = false

  for (let index = 0; index < fibers.length; index += 1) {
    const fiber = fibers[index]
    if (!fiber) continue
    const fromCache = classifyFiberFromCache(fiber)
    if (fromCache) {
      classes[index] = fromCache
      continue
    }
    const remaining = budgetMs - (Date.now() - startedAt)
    if (resolved >= limit || remaining <= 0) {
      partial = true
      continue
    }
    resolved += 1
    const result = await classifyFiberBeforeDeadline(fiber, remaining)
    if (result === null) {
      partial = true
      continue
    }
    classes[index] = result
  }

  return { classes, partial }
}

const WARMUP_CHUNK = 24
const WARMUP_GAP_MS = 50
const WARMING_CALL_BUDGET_MS = 100

let warmupQueue: Fiber[] = []
let warmupRunning = false

/** Continue classifying a partial read's leftovers off the call path, in small paced chunks, so repeated reads stop paying the in-call budget once the set warms. */
export function scheduleClassificationWarmup(fibers: Fiber[]): void {
  warmupQueue = fibers.filter((fiber) => !cache.has(getFiberId(fiber)))
  if (warmupRunning || warmupQueue.length === 0) return
  warmupRunning = true
  void (async () => {
    try {
      while (warmupQueue.length > 0) {
        const chunk = warmupQueue.splice(0, WARMUP_CHUNK)
        await Promise.all(chunk.map((fiber) => classifyFiber(fiber).catch(() => null)))
        await new Promise((resolve) => setTimeout(resolve, WARMUP_GAP_MS))
      }
    } finally {
      warmupRunning = false
    }
  })()
}

/** A stable display identity for an otherwise-anonymous fiber, e.g. `cmdk.js:1998`. */
export function sourceLabel(source: ResolvedSource | null): string | null {
  if (!source) return null
  const base = source.file.split('/').pop() || source.file
  return source.line != null ? `${base}:${source.line}` : base
}

const EFFECT_HOOK_NAMES = new Set(['Effect', 'LayoutEffect', 'InsertionEffect'])

// Effect nodes are matched by name, not leaf-ness (bundled dev builds nest frames beneath them): recurse only through non-effect containers and stop at the effect itself — its subHooks are implementation, not more user effects.
function collectEffectCallSites(nodes: HooksNode[], out: HookSource[]): void {
  for (const node of nodes) {
    if (EFFECT_HOOK_NAMES.has(node.name)) {
      if (node.hookSource) out.push(node.hookSource)
    } else {
      collectEffectCallSites(node.subHooks, out)
    }
  }
}

const INLINE_SOURCE_MAP_RE =
  /\/\/[#@]\s*sourceMappingURL=data:application\/json;(?:[^,]*?;)?base64,([A-Za-z0-9+/=]+)/

const moduleMapCache = new Map<string, SourceMap | null>()

// bippy's symbolicator only fetches external map URLs; Vite inlines the map in dev, so decode it ourselves to recover original (not served/transformed) lines.
async function inlineSourceMap(url: string): Promise<SourceMap | null> {
  if (moduleMapCache.has(url)) return moduleMapCache.get(url) ?? null
  let map: SourceMap | null = null
  try {
    const response = await fetch(url)
    const encoded = response.ok ? (await response.text()).match(INLINE_SOURCE_MAP_RE)?.[1] : null
    if (encoded) {
      const raw = JSON.parse(atob(encoded)) as { mappings?: unknown; sources?: unknown }
      if (typeof raw.mappings === 'string' && Array.isArray(raw.sources)) {
        map = { ...(raw as object), mappings: decode(raw.mappings) } as SourceMap
      }
    }
  } catch {
    map = null
  }
  moduleMapCache.set(url, map)
  return map
}

// Maps a served line/column to the original via the module's inline map; returns the input unchanged when none exists, so callers keep a served-coordinate fallback.
async function toOriginalPosition(
  servedUrl: string,
  line: number | null,
  column: number | null,
): Promise<{ file: string | null; line: number | null; column: number | null }> {
  if (typeof line !== 'number' || typeof column !== 'number') return { file: null, line, column }
  // Vite inlines the map (our decoder); Next/Turbopack serve an external sourceMappingURL (bippy's fetcher).
  const map = (await inlineSourceMap(servedUrl)) ?? (await externalSourceMap(servedUrl))
  const original = map ? getSourceFromSourceMap(map, line, column) : null
  if (original && typeof original.lineNumber === 'number') {
    return {
      file: original.fileName ? normalizeFileName(original.fileName) : null,
      line: original.lineNumber,
      column: original.columnNumber ?? column,
    }
  }
  return { file: null, line, column }
}

async function externalSourceMap(url: string): Promise<SourceMap | null> {
  try {
    return await getSourceMap(url)
  } catch {
    return null
  }
}

// Classification prefers the served URL; the map's original file is trusted only when the served URL is an opaque bundle chunk (Next/Turbopack) AND the original classifies as app source — so a dep bundled into an app chunk stays library.
async function resolveHookSource(hook: HookSource): Promise<ResolvedSource | null> {
  if (!hook.fileName) return null
  const served = normalizeFileName(hook.fileName)
  if (!served) return null
  const original = await toOriginalPosition(
    hook.fileName,
    hook.lineNumber ?? null,
    hook.columnNumber ?? null,
  )
  const file = preferOriginalAppFile(served, original.file)
  return {
    file,
    line: original.line,
    column: original.column,
    functionName: hook.functionName ?? null,
  }
}

/** Trust an app source-map target only when the served frame is an opaque/non-source chunk. */
function preferOriginalAppFile(served: string, original: string | null): string {
  return !isSourceFile(served) && original && isSourceFile(original) ? original : served
}

/** Each user effect's own call-site, in hook order, via bippy's hook inspector (a shadow render). null = inspection unavailable, don't attribute; [] = inspected but no user effects, so commit-list entries are internal noise; a non-empty array aligns 1:1 with the commit list only when lengths match. */
export async function resolveEffectSources(
  fiber: Fiber,
): Promise<(ResolvedSource | null)[] | null> {
  const resolution = await resolveEffectSourceResolution(fiber)
  return resolution.sources
}

/** Detailed hook-inspection result so callers can distinguish absence, failure, and exact attribution. */
export async function resolveEffectSourceResolution(fiber: Fiber): Promise<EffectSourceResolution> {
  const target = getLatestFiber(fiber) ?? fiber
  const id = getFiberId(target)
  const cached = effectSourceCache.get(id)
  if (cached) return { status: 'resolved', sources: cached }

  const callSites: HookSource[] = []
  try {
    collectEffectCallSites(getFiberHooks(target), callSites)
  } catch {
    return { status: 'inspection-unavailable', sources: null }
  }
  if (callSites.length === 0) return { status: 'no-user-effects', sources: [] }

  const resolved = await Promise.all(callSites.map(resolveHookSource))
  if (resolved.some((source) => source !== null)) effectSourceCache.set(id, resolved)
  return { status: 'resolved', sources: resolved }
}

export async function resolveEffectSourcesBeforeDeadline(
  fiber: Fiber,
  timeoutMs: number,
): Promise<(ResolvedSource | null)[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      resolveEffectSources(fiber),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs))
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function resolveEffectSourceResolutionBeforeDeadline(
  fiber: Fiber,
  timeoutMs: number,
): Promise<EffectSourceResolution> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      resolveEffectSourceResolution(fiber),
      new Promise<EffectSourceResolution>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: 'deadline-exceeded', sources: null }),
          Math.max(1, timeoutMs),
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
