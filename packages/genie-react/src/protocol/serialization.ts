import superjson from 'superjson'
import {
  DEFAULT_INSPECT_DEPTH,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_PREVIEW_STRING_LENGTH,
} from './constants'
import { errorMessage } from './errors'

/** Wire codec is superjson: bridge frames and dehydrated payloads rely on `Date`/`Map`/`Set`/`BigInt`/`undefined` surviving. */
export function encodeFrame(value: unknown): string {
  return superjson.stringify(value)
}

export function decodeFrame(raw: string): unknown {
  return superjson.parse(raw)
}

export const DEHYDRATED = '__genie_dehydrated__' as const

// Pollution-vector keys superjson refuses to reconstruct — including one would discard the whole payload.
const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export type DehydratedKind =
  | 'object'
  | 'array'
  | 'map'
  | 'set'
  | 'function'
  | 'symbol'
  | 'circular'
  | 'react-element'
  | 'dom-node'
  | 'promise'
  | 'getter-error'
  | 'not-found'
  | 'truncated'

/** Placeholder for values too deep/large/circular to serialize; `path` is absolute from the root so the subtree can be re-requested. */
export interface DehydratedNode {
  readonly [DEHYDRATED]: true
  kind: DehydratedKind
  preview: string
  size?: number
  path: ReadonlyArray<string | number>
}

export interface DehydrateOptions {
  depth?: number
  maxStringLength?: number
  maxEntries?: number
  path?: ReadonlyArray<string | number>
}

export function isDehydratedNode(value: unknown): value is DehydratedNode {
  return (
    typeof value === 'object' && value !== null && DEHYDRATED in value && value[DEHYDRATED] === true
  )
}

const REACT_ELEMENT_TYPES = new Set<symbol>([
  Symbol.for('react.element'),
  Symbol.for('react.transitional.element'),
])

interface ReactElementLike {
  $$typeof: symbol
  type?: unknown
}

function isReactElement(value: object): value is ReactElementLike {
  const marker = '$$typeof' in value ? value.$$typeof : undefined
  return typeof marker === 'symbol' && REACT_ELEMENT_TYPES.has(marker)
}

const DomNode = (globalThis as { Node?: new (...args: never[]) => object }).Node

interface DomNodeLike {
  nodeName?: string
  id?: string
}

function isDomNode(value: object): value is DomNodeLike {
  return typeof DomNode === 'function' && value instanceof DomNode
}

export function previewValue(
  value: unknown,
  maxStringLength = DEFAULT_PREVIEW_STRING_LENGTH,
): string {
  switch (typeof value) {
    case 'string':
      return value.length > maxStringLength
        ? `${JSON.stringify(value.slice(0, maxStringLength))}…(${value.length})`
        : JSON.stringify(value)
    case 'number':
    case 'boolean':
      return String(value)
    case 'bigint':
      return `${value}n`
    case 'symbol':
      return value.toString()
    case 'undefined':
      return 'undefined'
    case 'function':
      return `ƒ ${value.name || 'anonymous'}()`
    case 'object': {
      if (value === null) return 'null'
      if (Array.isArray(value)) return `Array(${value.length})`
      if (value instanceof Date) return value.toISOString()
      if (value instanceof Map) return `Map(${value.size})`
      if (value instanceof Set) return `Set(${value.size})`
      if (value instanceof RegExp) return value.toString()
      if (isReactElement(value)) return reactElementPreview(value)
      if (isDomNode(value)) return domNodePreview(value)
      const ctor = value.constructor?.name
      return ctor && ctor !== 'Object' ? `${ctor} {…}` : '{…}'
    }
    default:
      return String(value)
  }
}

function reactElementPreview(value: ReactElementLike): string {
  return `<${componentName(value.type)} />`
}

function componentName(type: unknown): string {
  if (typeof type === 'string') return type
  if (typeof type === 'function' || (typeof type === 'object' && type !== null)) {
    const displayName = 'displayName' in type ? type.displayName : undefined
    const name = 'name' in type ? type.name : undefined
    const label = displayName ?? name
    if (label != null) return String(label)
  }
  return 'Component'
}

function domNodePreview(value: DomNodeLike): string {
  const tag = value.nodeName?.toLowerCase() ?? 'node'
  return value.id ? `<${tag} #${value.id}>` : `<${tag}>`
}

function dehydratedNode(
  kind: DehydratedKind,
  preview: string,
  path: ReadonlyArray<string | number>,
  size?: number,
): DehydratedNode {
  return { [DEHYDRATED]: true, kind, preview, path, ...(size === undefined ? {} : { size }) }
}

/** Depth- and size-caps a runtime value for the wire (and token budgets), mirroring React DevTools' dehydration. */
export function dehydrate(input: unknown, options: DehydrateOptions = {}): unknown {
  const depth = options.depth ?? DEFAULT_INSPECT_DEPTH
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const basePath = options.path ?? []

  const resolved = resolvePath(input, basePath)
  if (!resolved.found) {
    return dehydratedNode('not-found', `path not found: ${formatPath(basePath)}`, basePath)
  }

  const seen = new WeakSet<object>()

  const truncateString = (value: string): string =>
    value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…(${value.length})` : value

  const walk = (
    value: unknown,
    currentDepth: number,
    path: ReadonlyArray<string | number>,
  ): unknown => {
    if (value === null) return null
    if (typeof value === 'string') return truncateString(value)
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'undefined')
      return value
    // bigint is not JSON-serializable; dehydrated output is agent-facing JSON, so stringify it.
    if (typeof value === 'bigint') return `${value}n`
    if (typeof value === 'symbol') return dehydratedNode('symbol', value.toString(), path)
    if (typeof value === 'function') return dehydratedNode('function', previewValue(value), path)

    const obj = value
    if (seen.has(obj)) return dehydratedNode('circular', '[Circular]', path)
    if (value instanceof Date) return value
    // RegExp has no toJSON (a raw value collapses to "{}"), so emit its source form like bigint/previewValue.
    if (value instanceof RegExp) return value.toString()
    if (typeof Promise !== 'undefined' && value instanceof Promise)
      return dehydratedNode('promise', 'Promise', path)
    if (isReactElement(obj)) return dehydratedNode('react-element', reactElementPreview(obj), path)
    if (isDomNode(obj)) return dehydratedNode('dom-node', domNodePreview(obj), path)

    if (value instanceof Map) {
      if (currentDepth >= depth)
        return dehydratedNode('map', `Map(${value.size})`, path, value.size)
      seen.add(obj)
      const entries: Array<[string | number, unknown]> = []
      let i = 0
      for (const [key, entry] of value) {
        if (i >= maxEntries) {
          entries.push([
            '…',
            dehydratedNode(
              'truncated',
              `+${value.size - maxEntries} more entries`,
              path,
              value.size,
            ),
          ])
          break
        }
        const safeKey = typeof key === 'string' || typeof key === 'number' ? key : previewValue(key)
        entries.push([safeKey, walk(entry, currentDepth + 1, [...path, safeKey])])
        i++
      }
      seen.delete(obj)
      return { __type: 'Map', entries }
    }

    if (value instanceof Set) {
      if (currentDepth >= depth)
        return dehydratedNode('set', `Set(${value.size})`, path, value.size)
      seen.add(obj)
      const out: unknown[] = []
      let i = 0
      for (const entry of value) {
        if (i >= maxEntries) {
          out.push(
            dehydratedNode(
              'truncated',
              `+${value.size - maxEntries} more entries`,
              path,
              value.size,
            ),
          )
          break
        }
        out.push(walk(entry, currentDepth + 1, [...path, i]))
        i++
      }
      seen.delete(obj)
      return { __type: 'Set', values: out }
    }

    if (Array.isArray(value)) {
      if (currentDepth >= depth)
        return dehydratedNode('array', `Array(${value.length})`, path, value.length)
      seen.add(obj)
      const limit = Math.min(value.length, maxEntries)
      const out: unknown[] = []
      for (let i = 0; i < limit; i++) out.push(walk(value[i], currentDepth + 1, [...path, i]))
      if (value.length > maxEntries) {
        out.push(
          dehydratedNode(
            'truncated',
            `+${value.length - maxEntries} more items`,
            path,
            value.length,
          ),
        )
      }
      seen.delete(obj)
      return out
    }

    if (currentDepth >= depth) return dehydratedNode('object', previewValue(value), path)

    seen.add(obj)
    const keys = Object.keys(obj).filter((key) => !RESERVED_OBJECT_KEYS.has(key))
    const out: Record<string, unknown> = {}
    for (const key of keys.slice(0, Math.max(0, maxEntries))) {
      try {
        out[key] = walk((obj as Record<string, unknown>)[key], currentDepth + 1, [...path, key])
      } catch (error) {
        out[key] = dehydratedNode('getter-error', `[getter threw: ${errorMessage(error)}]`, [
          ...path,
          key,
        ])
      }
    }
    if (keys.length > maxEntries) {
      out['…'] = dehydratedNode(
        'truncated',
        `+${keys.length - maxEntries} more keys`,
        path,
        keys.length,
      )
    }
    seen.delete(obj)
    return out
  }

  return walk(resolved.value, 0, basePath)
}

type ResolveResult = { found: true; value: unknown } | { found: false }

function resolvePath(input: unknown, path: ReadonlyArray<string | number>): ResolveResult {
  let current = input
  for (const segment of path) {
    if (current == null) return { found: false }
    try {
      if (current instanceof Map) {
        if (!current.has(segment)) return { found: false }
        current = current.get(segment)
      } else if (current instanceof Set) {
        const values = [...current]
        if (typeof segment !== 'number' || segment >= values.length) return { found: false }
        current = values[segment]
      } else if (typeof current === 'object' && segment in current) {
        current = (current as Record<string | number, unknown>)[segment]
      } else {
        return { found: false }
      }
    } catch {
      // a throwing getter / Proxy trap during re-rooting — mirror the walk's graceful handling
      return { found: false }
    }
  }
  return { found: true, value: current }
}

function formatPath(path: ReadonlyArray<string | number>): string {
  return path.length === 0 ? '<root>' : path.join('.')
}
