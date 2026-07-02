import { decode } from '@jridgewell/sourcemap-codec'
import { type Fiber, getFiberId, getLatestFiber } from 'bippy'
import {
  getFiberHooks,
  getSource,
  getSourceFromSourceMap,
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

const cache = new Map<number, ResolvedSource>()
const effectSourceCache = new Map<number, (ResolvedSource | null)[]>()
const ANCESTOR_HOPS = 20

export function clearSourceCache(): void {
  cache.clear()
  effectSourceCache.clear()
  moduleMapCache.clear()
}

/** Fiber → definition site via bippy's `_debugStack` symbolication (React 19 dropped `_debugSource`), so async and network-bound; only successes are cached, letting a transient null (e.g. right after HMR) recover. */
export async function resolveSource(fiber: Fiber): Promise<ResolvedSource | null> {
  const id = getFiberId(fiber)
  const cached = cache.get(id)
  if (cached) return cached

  try {
    const source = await getSource(getLatestFiber(fiber) ?? fiber)
    if (!source?.fileName) return null
    const { line, column } = await toOriginalPosition(
      source.fileName,
      source.lineNumber ?? null,
      source.columnNumber ?? null,
    )
    const resolved: ResolvedSource = {
      file: normalizeFileName(source.fileName),
      line,
      column,
      functionName: source.functionName ?? null,
    }
    cache.set(id, resolved)
    return resolved
  } catch {
    return null
  }
}

/** A file outside the project tree (under node_modules, incl. Vite's pre-bundled deps) is a library. */
export function isLibraryFile(file: string): boolean {
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
): Promise<{ line: number | null; column: number | null }> {
  if (typeof line !== 'number' || typeof column !== 'number') return { line, column }
  const map = await inlineSourceMap(servedUrl)
  const original = map ? getSourceFromSourceMap(map, line, column) : null
  if (original && typeof original.lineNumber === 'number') {
    return { line: original.lineNumber, column: original.columnNumber ?? column }
  }
  return { line, column }
}

// File + library classification come from the served URL, never the map's own `sources` (which can point a bundled dep outside node_modules); only line/column are mapped back.
async function resolveHookSource(hook: HookSource): Promise<ResolvedSource | null> {
  if (!hook.fileName) return null
  const file = normalizeFileName(hook.fileName)
  if (!file) return null
  const { line, column } = await toOriginalPosition(
    hook.fileName,
    hook.lineNumber ?? null,
    hook.columnNumber ?? null,
  )
  return { file, line, column, functionName: hook.functionName ?? null }
}

/** Each user effect's own call-site, in hook order, via bippy's hook inspector (a shadow render). null = inspection unavailable, don't attribute; [] = inspected but no user effects, so commit-list entries are internal noise; a non-empty array aligns 1:1 with the commit list only when lengths match. */
export async function resolveEffectSources(
  fiber: Fiber,
): Promise<(ResolvedSource | null)[] | null> {
  const target = getLatestFiber(fiber) ?? fiber
  const id = getFiberId(target)
  const cached = effectSourceCache.get(id)
  if (cached) return cached

  const callSites: HookSource[] = []
  try {
    collectEffectCallSites(getFiberHooks(target), callSites)
  } catch {
    return null
  }
  if (callSites.length === 0) return []

  const resolved = await Promise.all(callSites.map(resolveHookSource))
  if (resolved.some((source) => source !== null)) effectSourceCache.set(id, resolved)
  return resolved
}
