import { decode } from '@jridgewell/sourcemap-codec'
import { type Fiber, getDisplayName, getFiberId, getLatestFiber } from 'bippy'
import {
  formatOwnerStack,
  getSourceFromSourceMap,
  getSourceMap,
  type HookSource,
  type HooksNode,
  isSourceFile,
  normalizeFileName,
  parseStack,
  type SourceMap,
  symbolicateStack,
} from 'bippy/source'
import { isDataDescriptor, safeOwnPropertyDescriptor } from '../causal/safe-object'

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

export type SourceAttribution =
  | { role: 'usage-or-definition-fallback'; evidence: 'inferred' }
  | { role: 'unavailable'; evidence: 'unknown' }

export type EffectSourceResolutionStatus =
  | 'resolved'
  | 'no-user-effects'
  | 'inspection-unavailable'
  | 'inspection-truncated'
  | 'shadow-render-disabled'
  | 'deadline-exceeded'
  | 'report-state-advanced'

export interface EffectSourceResolution {
  status: EffectSourceResolutionStatus
  sources: (ResolvedSource | null)[] | null
  callsites: ResolvedEffectCallsite[] | null
}

export interface ResolvedHookAncestryFrame {
  name: string
  source: ResolvedSource | null
}

export interface ResolvedEffectCallsite {
  source: ResolvedSource | null
  hookAncestry: ResolvedHookAncestryFrame[]
}

export type ExternalStoreSourceResolutionStatus =
  | 'resolved'
  | 'no-external-stores'
  | 'inspection-unavailable'
  | 'inspection-truncated'
  | 'shadow-render-disabled'
  | 'deadline-exceeded'
  | 'report-state-advanced'

export interface ResolvedExternalStoreCallsite {
  callsite: ResolvedSource | null
  primitiveSource: ResolvedSource | null
  hookAncestry: ResolvedHookAncestryFrame[]
}

export interface ExternalStoreSourceResolution {
  status: ExternalStoreSourceResolutionStatus
  hooks: ResolvedExternalStoreCallsite[] | null
}

const cache = new Map<number, ResolvedSource>()
const pendingSource = new Map<number, Promise<ResolvedSource | null>>()
let cacheGeneration = 0
const ANCESTOR_HOPS = 20
const DEFAULT_CLASSIFY_LIMIT = 120
const DEFAULT_CLASSIFY_BUDGET_MS = 500
const UNCLASSIFIED_FIBER: FiberClassification = { source: null, isLibrary: false }

export function clearSourceCache(): void {
  cacheGeneration += 1
  cache.clear()
  pendingSource.clear()
  moduleMapCache.clear()
  warmupQueue = []
  activeWarmup = null
}

/** Fiber → JSX usage site or definition fallback. Symbolication is async; only successes are cached so a transient null can recover. */
export async function resolveSource(fiber: Fiber): Promise<ResolvedSource | null> {
  const generation = cacheGeneration
  const id = getFiberId(fiber)
  const cached = cache.get(id)
  if (cached) return cached
  const pending = pendingSource.get(id)
  if (pending) return pending

  let lookup!: Promise<ResolvedSource | null>
  lookup = (async () => {
    try {
      const source = await safeFiberSource(getLatestFiber(fiber) ?? fiber)
      if (generation !== cacheGeneration) return null
      if (!source?.fileName) return null
      const servedFile = normalizeFileName(source.fileName)
      const original = await toOriginalPosition(
        source.fileName,
        source.lineNumber ?? null,
        source.columnNumber ?? null,
        generation,
      )
      if (generation !== cacheGeneration) return null
      const position = selectSourcePosition(
        servedFile,
        source.lineNumber ?? null,
        source.columnNumber ?? null,
        original,
      )
      const resolved: ResolvedSource = {
        ...position,
        functionName: source.functionName ?? null,
      }
      if (generation === cacheGeneration) cache.set(id, resolved)
      return resolved
    } catch {
      return null
    } finally {
      if (pendingSource.get(id) === lookup) pendingSource.delete(id)
    }
  })()
  pendingSource.set(id, lookup)
  return lookup
}

interface SafeFiberSource {
  fileName: string
  lineNumber?: number | null
  columnNumber?: number | null
  functionName?: string | null
}

/** Read only React-captured debug metadata; never use bippy's component re-invocation fallback. */
async function safeFiberSource(fiber: Fiber): Promise<SafeFiberSource | null> {
  const debugSource = dataPropertyValue(fiber, '_debugSource')
  if (isRecord(debugSource)) {
    const fileName = dataPropertyValue(debugSource, 'fileName')
    const lineNumber = dataPropertyValue(debugSource, 'lineNumber')
    const columnNumber = dataPropertyValue(debugSource, 'columnNumber')
    if (typeof fileName === 'string' && typeof lineNumber === 'number') {
      return {
        fileName,
        lineNumber,
        columnNumber: typeof columnNumber === 'number' ? columnNumber : null,
        functionName: null,
      }
    }
  }

  const debugStack = dataPropertyValue(fiber, '_debugStack')
  if (!(debugStack instanceof Error)) return null
  const stack = dataPropertyValue(debugStack, 'stack')
  if (typeof stack !== 'string') return null
  const trustedStack = formatOwnerStack(stack)
  if (!trustedStack) return null
  const frame = parseStack(trustedStack).find((entry) => typeof entry.fileName === 'string')
  if (!frame?.fileName) return null
  const [symbolicated] = await symbolicateStack([frame])
  const resolved = symbolicated?.fileName ? symbolicated : frame
  return resolved.fileName
    ? {
        fileName: resolved.fileName,
        lineNumber: resolved.lineNumber ?? null,
        columnNumber: resolved.columnNumber ?? null,
        functionName: resolved.functionName ?? null,
      }
    : null
}

function dataPropertyValue(value: object, key: PropertyKey): unknown {
  const descriptor = safeOwnPropertyDescriptor(value, key)
  return isDataDescriptor(descriptor) ? descriptor.value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A file outside the project tree is a library. Turbopack can expose app fibers as unmapped dev chunks; dependencies still resolve to node_modules paths. */
export function isLibraryFile(file: string): boolean {
  if (file.replaceAll('\\', '/').includes('/.next/dev/server/chunks/')) return false
  return !isSourceFile(file)
}

/** App vs library by resolved source, climbing to the nearest ancestor that resolves; unresolved stays app so a missing source never silently hides a component. */
export async function classifyFiber(fiber: Fiber): Promise<FiberClassification> {
  const generation = cacheGeneration
  let current: Fiber | null = fiber
  for (let hops = 0; current && hops < ANCESTOR_HOPS; hops++) {
    if (generation !== cacheGeneration) return UNCLASSIFIED_FIBER
    const source = await resolveSource(current)
    if (generation !== cacheGeneration) return UNCLASSIFIED_FIBER
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
  const budgetMs =
    activeWarmup !== null
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
interface WarmupRun {
  generation: number
}

let activeWarmup: WarmupRun | null = null

/** Continue classifying a partial read's leftovers off the call path, in small paced chunks, so repeated reads stop paying the in-call budget once the set warms. */
export function scheduleClassificationWarmup(fibers: Fiber[]): void {
  const generation = cacheGeneration
  warmupQueue = fibers.filter((fiber) => !cache.has(getFiberId(fiber)))
  if (activeWarmup?.generation === generation || warmupQueue.length === 0) return
  const run: WarmupRun = { generation }
  activeWarmup = run
  void (async () => {
    try {
      while (activeWarmup === run && run.generation === cacheGeneration && warmupQueue.length > 0) {
        const chunk = warmupQueue.splice(0, WARMUP_CHUNK)
        await Promise.all(chunk.map((fiber) => classifyFiber(fiber).catch(() => null)))
        if (activeWarmup !== run || run.generation !== cacheGeneration) break
        await new Promise((resolve) => setTimeout(resolve, WARMUP_GAP_MS))
      }
    } finally {
      if (activeWarmup === run) activeWarmup = null
    }
  })()
}

/** A stable display identity for an otherwise-anonymous fiber, e.g. `cmdk.js:1998`. */
export function sourceLabel(source: ResolvedSource | null): string | null {
  if (!source) return null
  const base = source.file.split('/').pop() || source.file
  return source.line != null ? `${base}:${source.line}` : base
}

/** Bippy does not expose which source fallback won, so never label this as a definition site. */
export function sourceAttributionForSource(source: ResolvedSource | null): SourceAttribution {
  if (!source) return { role: 'unavailable', evidence: 'unknown' }
  return { role: 'usage-or-definition-fallback', evidence: 'inferred' }
}

const EFFECT_HOOK_NAMES = new Set(['Effect', 'LayoutEffect', 'InsertionEffect'])
const EXTERNAL_STORE_HOOK_NAMES = new Set(['SyncExternalStore'])
const HOOK_ANCESTRY_LIMIT = 12
const HOOK_NODE_LIMIT = 1_000
const HOOK_CALLSITE_LIMIT = 100

interface PrimitiveCallsiteNode {
  source: HookSource | null
  hookAncestry: { name: string; source: HookSource | null }[]
}

interface PrimitiveCallsiteCollection {
  callsites: PrimitiveCallsiteNode[]
  truncated: boolean
}

interface HookTreeFrame {
  nodes: HooksNode[]
  index: number
  ancestry: PrimitiveCallsiteNode['hookAncestry']
}

function collectPrimitiveCallSites(
  nodes: HooksNode[],
  names: ReadonlySet<string>,
): PrimitiveCallsiteCollection {
  const callsites: PrimitiveCallsiteNode[] = []
  const stack: HookTreeFrame[] = [{ nodes, index: 0, ancestry: [] }]
  let visited = 0

  while (stack.length > 0) {
    const frame = stack.at(-1)
    if (!frame) break
    if (frame.index >= frame.nodes.length) {
      stack.pop()
      continue
    }
    if (visited >= HOOK_NODE_LIMIT) return { callsites, truncated: true }

    const node = frame.nodes[frame.index]
    frame.index += 1
    if (!node) continue
    visited += 1
    if (names.has(node.name)) {
      if (callsites.length >= HOOK_CALLSITE_LIMIT) return { callsites, truncated: true }
      callsites.push({
        source: node.hookSource,
        hookAncestry: frame.ancestry.slice(-HOOK_ANCESTRY_LIMIT),
      })
      continue
    }
    if (node.subHooks.length === 0) continue
    stack.push({
      nodes: node.subHooks,
      index: 0,
      ancestry: [...frame.ancestry, { name: node.name, source: node.hookSource }].slice(
        -HOOK_ANCESTRY_LIMIT,
      ),
    })
  }

  return { callsites, truncated: false }
}

function withoutComponentRoot(
  ancestry: PrimitiveCallsiteNode['hookAncestry'],
  fiber: Fiber,
): PrimitiveCallsiteNode['hookAncestry'] {
  const componentName = getDisplayName(fiber.type)
  return componentName && ancestry[0]?.name === componentName ? ancestry.slice(1) : ancestry
}

const INLINE_SOURCE_MAP_RE =
  /\/\/[#@]\s*sourceMappingURL=data:application\/json;(?:[^,]*?;)?base64,([A-Za-z0-9+/=]+)/

const moduleMapCache = new Map<string, SourceMap | null>()

// bippy's symbolicator only fetches external map URLs; Vite inlines the map in dev, so decode it ourselves to recover original (not served/transformed) lines.
async function inlineSourceMap(url: string, generation: number): Promise<SourceMap | null> {
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
  if (generation === cacheGeneration) moduleMapCache.set(url, map)
  return map
}

// Maps a served line/column to the original via the module's inline map; returns the input unchanged when none exists, so callers keep a served-coordinate fallback.
async function toOriginalPosition(
  servedUrl: string,
  line: number | null,
  column: number | null,
  generation = cacheGeneration,
): Promise<{ file: string | null; line: number | null; column: number | null }> {
  if (typeof line !== 'number' || typeof column !== 'number') return { file: null, line, column }
  // Vite inlines the map (our decoder); Next/Turbopack serve an external sourceMappingURL (bippy's fetcher).
  const map = (await inlineSourceMap(servedUrl, generation)) ?? (await externalSourceMap(servedUrl))
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
async function resolveHookSource(
  hook: HookSource | null,
  generation: number,
): Promise<ResolvedSource | null> {
  try {
    if (!hook?.fileName || generation !== cacheGeneration) return null
    const served = normalizeFileName(hook.fileName)
    if (!served) return null
    const original = await toOriginalPosition(
      hook.fileName,
      hook.lineNumber ?? null,
      hook.columnNumber ?? null,
      generation,
    )
    if (generation !== cacheGeneration) return null
    return {
      ...selectSourcePosition(served, hook.lineNumber ?? null, hook.columnNumber ?? null, original),
      functionName: hook.functionName ?? null,
    }
  } catch {
    return null
  }
}

/** File and coordinates are one unit: never pair a rejected source-map file with its line. */
function selectSourcePosition(
  servedFile: string,
  servedLine: number | null,
  servedColumn: number | null,
  original: { file: string | null; line: number | null; column: number | null },
): Pick<ResolvedSource, 'file' | 'line' | 'column'> {
  if (
    original.file !== null &&
    isSourceFile(original.file) &&
    (!isSourceFile(servedFile) || isAppBundleEntry(servedFile))
  ) {
    return { file: original.file, line: original.line, column: original.column }
  }
  return { file: servedFile, line: servedLine, column: servedColumn }
}

function isAppBundleEntry(file: string): boolean {
  return /\/(?:assets|static)\/[^/]+\.(?:js|mjs|cjs)$/i.test(file)
}

/** Resolve a supplied hook tree only. Automatic reports omit `inspectedHooks` because obtaining it with bippy would re-run the application component. */
export async function resolveEffectSources(
  fiber: Fiber,
  inspectedHooks?: HooksNode[] | null,
): Promise<(ResolvedSource | null)[] | null> {
  const resolution = await resolveEffectSourceResolution(fiber, inspectedHooks)
  return resolution.sources
}

/** `undefined` means automatic shadow rendering is disabled; `null` means an explicit inspector failed. */
export async function resolveEffectSourceResolution(
  fiber: Fiber,
  inspectedHooks?: HooksNode[] | null,
): Promise<EffectSourceResolution> {
  if (inspectedHooks === undefined) {
    return { status: 'shadow-render-disabled', sources: null, callsites: null }
  }
  if (inspectedHooks === null) {
    return { status: 'inspection-unavailable', sources: null, callsites: null }
  }

  const generation = cacheGeneration
  const target = getLatestFiber(fiber) ?? fiber
  let collection: PrimitiveCallsiteCollection
  try {
    collection = collectPrimitiveCallSites(inspectedHooks, EFFECT_HOOK_NAMES)
  } catch {
    return { status: 'inspection-unavailable', sources: null, callsites: null }
  }
  if (collection.truncated) {
    return { status: 'inspection-truncated', sources: null, callsites: null }
  }
  if (collection.callsites.length === 0) {
    return { status: 'no-user-effects', sources: [], callsites: [] }
  }

  const resolved = await Promise.all(
    collection.callsites.map(
      async (callsite): Promise<ResolvedEffectCallsite> => ({
        source: await resolveHookSource(callsite.source, generation),
        hookAncestry: await Promise.all(
          withoutComponentRoot(callsite.hookAncestry, target).map(async (frame) => ({
            name: frame.name,
            source: await resolveHookSource(frame.source, generation),
          })),
        ),
      }),
    ),
  )
  if (generation !== cacheGeneration) {
    return { status: 'report-state-advanced', sources: null, callsites: null }
  }
  return {
    status: 'resolved',
    sources: resolved.map((callsite) => callsite.source),
    callsites: resolved,
  }
}

export async function resolveEffectSourcesBeforeDeadline(
  fiber: Fiber,
  timeoutMs: number,
  inspectedHooks?: HooksNode[] | null,
): Promise<(ResolvedSource | null)[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      resolveEffectSources(fiber, inspectedHooks),
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
  inspectedHooks?: HooksNode[] | null,
): Promise<EffectSourceResolution> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      resolveEffectSourceResolution(fiber, inspectedHooks),
      new Promise<EffectSourceResolution>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: 'deadline-exceeded', sources: null, callsites: null }),
          Math.max(1, timeoutMs),
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Resolve a supplied hook tree only; automatic reports return `shadow-render-disabled`. */
export async function resolveExternalStoreSourceResolution(
  fiber: Fiber,
  inspectedHooks?: HooksNode[] | null,
): Promise<ExternalStoreSourceResolution> {
  if (inspectedHooks === undefined) return { status: 'shadow-render-disabled', hooks: null }
  if (inspectedHooks === null) return { status: 'inspection-unavailable', hooks: null }

  const generation = cacheGeneration
  const target = getLatestFiber(fiber) ?? fiber
  let collection: PrimitiveCallsiteCollection
  try {
    collection = collectPrimitiveCallSites(inspectedHooks, EXTERNAL_STORE_HOOK_NAMES)
  } catch {
    return { status: 'inspection-unavailable', hooks: null }
  }
  if (collection.truncated) return { status: 'inspection-truncated', hooks: null }
  if (collection.callsites.length === 0) return { status: 'no-external-stores', hooks: [] }

  const resolved = await Promise.all(
    collection.callsites.map(async (entry): Promise<ResolvedExternalStoreCallsite> => {
      const primitiveSource = await resolveHookSource(entry.source, generation)
      const hookAncestry = await Promise.all(
        withoutComponentRoot(entry.hookAncestry, target).map(async (frame) => ({
          name: frame.name,
          source: await resolveHookSource(frame.source, generation),
        })),
      )
      return {
        callsite:
          hookAncestry.find((frame) => frame.source !== null && !isLibraryFile(frame.source.file))
            ?.source ??
          hookAncestry.find((frame) => frame.source !== null)?.source ??
          primitiveSource,
        primitiveSource,
        hookAncestry,
      }
    }),
  )
  if (generation !== cacheGeneration) return { status: 'report-state-advanced', hooks: null }
  return { status: 'resolved', hooks: resolved }
}

export async function resolveExternalStoreSourceResolutionBeforeDeadline(
  fiber: Fiber,
  timeoutMs: number,
  inspectedHooks?: HooksNode[] | null,
): Promise<ExternalStoreSourceResolution> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      resolveExternalStoreSourceResolution(fiber, inspectedHooks),
      new Promise<ExternalStoreSourceResolution>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: 'deadline-exceeded', hooks: null }),
          Math.max(1, timeoutMs),
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
