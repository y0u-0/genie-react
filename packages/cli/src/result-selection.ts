import { isRecord } from './guards'

const MAX_COUNTED_PATHS = 1_000_000

export interface SelectionEnvelope {
  schemaVersion: '1.0'
  status: 'ok'
  selection: {
    expression: string
    matchedPathCount: number
    matchedPaths: string[]
    omittedPathCount: number
  }
  result: unknown
}

export class ResultSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResultSelectionError'
  }
}

interface Match {
  path: string
  value: unknown
}

/** Select nested output with RFC 6901 JSON Pointer or a dotted path with `*` / `[*]`. */
export function selectResult(result: unknown, expression: string): SelectionEnvelope {
  const segments = parseSelection(expression)
  const matches = selectMatches([{ path: '', value: result }], segments)
  if (matches.length === 0) {
    const available = isRecord(result)
      ? Object.keys(result)
          .sort()
          .slice(0, 30)
          .map((key) => `/${escapePointer(key)}`)
      : []
    throw new ResultSelectionError(
      `Selection ${JSON.stringify(expression)} matched no paths. Available top-level paths: ${available.join(', ') || '(none)'}. Use an RFC 6901 path such as /components/0/name or a wildcard path such as components[*].name.`,
    )
  }
  const matchedPaths = matches.map(({ path }) => path || '/')
  const selectedLeaves = matches.reduce(
    (count, match) => Math.min(MAX_COUNTED_PATHS, count + countLeafPaths(match.value)),
    0,
  )
  const totalLeaves = countLeafPaths(result)
  return {
    schemaVersion: '1.0',
    status: 'ok',
    selection: {
      expression,
      matchedPathCount: matches.length,
      matchedPaths: matchedPaths.slice(0, 200),
      omittedPathCount: Math.max(0, totalLeaves - selectedLeaves),
    },
    result:
      matches.length === 1
        ? matches[0]?.value
        : matches.map((match) => ({ path: match.path || '/', value: match.value })),
  }
}

export function renderBoundedJson(value: unknown, maxBytes?: number): string {
  const serialized = JSON.stringify(value)
  if (maxBytes === undefined || Buffer.byteLength(serialized, 'utf8') + 1 <= maxBytes) {
    return serialized
  }
  const originalBytes = Buffer.byteLength(serialized, 'utf8') + 1
  const envelope = {
    schemaVersion: '1.0',
    status: 'truncated',
    reason: 'max-bytes',
    maxBytes,
    originalBytes,
    omittedPathCount: countLeafPaths(value),
    topLevelPaths: isRecord(value)
      ? Object.keys(value)
          .sort()
          .slice(0, 20)
          .map((key) => `/${escapePointer(key)}`)
      : [],
    message: 'The result exceeded --max-bytes; use --select or a smaller tool limit.',
  }
  const bounded = JSON.stringify(envelope)
  if (Buffer.byteLength(bounded, 'utf8') + 1 > maxBytes) {
    throw new ResultSelectionError('--max-bytes is too small for the truncation envelope.')
  }
  return bounded
}

export function renderBoundedText(text: string, maxBytes?: number): string {
  if (maxBytes === undefined || Buffer.byteLength(text, 'utf8') + 1 <= maxBytes) return text
  return renderBoundedJson(
    {
      output: text,
      omittedPathCount: text === '' ? 0 : text.split('\n').length,
    },
    maxBytes,
  )
}

function parseSelection(expression: string): string[] {
  const trimmed = expression.trim()
  if (!trimmed) throw new ResultSelectionError('--select requires a non-empty path.')
  if (trimmed === '/') return ['']
  if (trimmed.startsWith('/')) {
    return trimmed
      .slice(1)
      .split('/')
      .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
  }

  const source = trimmed.replace(/^\$\.?/, '')
  const segments: string[] = []
  let cursor = 0
  while (cursor < source.length) {
    if (source[cursor] === '.') {
      cursor += 1
      continue
    }
    if (source[cursor] === '[') {
      const close = source.indexOf(']', cursor + 1)
      if (close < 0)
        throw new ResultSelectionError(`Invalid selection ${JSON.stringify(expression)}.`)
      const segment = source.slice(cursor + 1, close)
      if (!/^\d+$|^\*$/.test(segment)) {
        throw new ResultSelectionError(
          `Invalid bracket segment ${JSON.stringify(segment)}; use a numeric index or * wildcard.`,
        )
      }
      segments.push(segment)
      cursor = close + 1
      continue
    }
    const nextDot = source.indexOf('.', cursor)
    const nextBracket = source.indexOf('[', cursor)
    const boundaries = [nextDot, nextBracket].filter((index) => index >= 0)
    const end = boundaries.length > 0 ? Math.min(...boundaries) : source.length
    const segment = source.slice(cursor, end)
    if (!segment) throw new ResultSelectionError(`Invalid selection ${JSON.stringify(expression)}.`)
    segments.push(segment)
    cursor = end
  }
  return segments
}

function selectMatches(matches: Match[], segments: string[]): Match[] {
  let current = matches
  for (const segment of segments) {
    const next: Match[] = []
    for (const match of current) {
      if (segment === '*') {
        if (Array.isArray(match.value)) {
          for (const [index, value] of match.value.entries()) {
            next.push({ path: `${match.path}/${index}`, value })
          }
        } else if (isRecord(match.value)) {
          for (const [key, value] of Object.entries(match.value)) {
            next.push({ path: `${match.path}/${escapePointer(key)}`, value })
          }
        }
        continue
      }
      if (Array.isArray(match.value) && /^\d+$/.test(segment)) {
        const index = Number(segment)
        if (index < match.value.length)
          next.push({ path: `${match.path}/${index}`, value: match.value[index] })
        continue
      }
      if (isRecord(match.value) && Object.hasOwn(match.value, segment)) {
        next.push({
          path: `${match.path}/${escapePointer(segment)}`,
          value: match.value[segment],
        })
      }
    }
    current = next
  }
  return current
}

function countLeafPaths(value: unknown): number {
  let count = 0
  const stack = [value]
  while (stack.length > 0 && count < MAX_COUNTED_PATHS) {
    const current = stack.pop()
    if (Array.isArray(current)) {
      if (current.length === 0) count += 1
      else stack.push(...current)
    } else if (isRecord(current)) {
      const values = Object.values(current)
      if (values.length === 0) count += 1
      else stack.push(...values)
    } else {
      count += 1
    }
  }
  return count
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}
