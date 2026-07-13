import { isRecord } from './guards'

const GENERIC_BASENAMES = /^(index|main|app|page|layout|route)\.[jt]sx?$/i

export function sourceSuffix(record: Record<string, unknown>): string {
  const { source } = record
  if (!isRecord(source) || typeof source.file !== 'string') return ''
  const segments = source.file.split('/').filter(Boolean)
  const base = segments.pop() || source.file
  const parent = GENERIC_BASENAMES.test(base) ? segments.pop() : undefined
  const label = parent ? `${parent}/${base}` : base
  return typeof source.line === 'number' ? ` (${label}:${source.line})` : ` (${label})`
}

export function bounded(raw: string | undefined): string {
  if (!raw) return '(none)'
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
}

export const num = (value: unknown): number => (typeof value === 'number' ? value : 0)

export const preferredCount = (preferred: unknown, legacy: unknown): number =>
  typeof preferred === 'number' ? preferred : num(legacy)

export const preferredOptionalCount = (preferred: unknown, legacy: unknown): number | null => {
  if (typeof preferred === 'number') return preferred
  return typeof legacy === 'number' ? legacy : null
}

export const preferredBoolean = (preferred: unknown, legacy: unknown): boolean =>
  typeof preferred === 'boolean' ? preferred : legacy === true
