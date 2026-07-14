import { isRecord } from './guards'

const GENERIC_BASENAMES = /^(index|main|app|page|layout|route)\.[jt]sx?$/i

export function sourceSuffix(record: Record<string, unknown>): string {
  const provenance = isRecord(record.sourceProvenance)
    ? record.sourceProvenance
    : isRecord(record.provenance)
      ? record.provenance
      : null
  const candidates: Array<{ role: string; value: unknown }> = [
    { role: 'source', value: record.source },
    { role: 'definition', value: provenance?.definitionSource },
    { role: 'allocation', value: provenance?.allocationCallsite },
    { role: 'hook owner', value: provenance?.hookDefinitionOwner },
    { role: 'hook callsite', value: provenance?.hookCallsite },
    { role: 'fallback', value: provenance?.usageOrDefinitionFallback },
  ]
  const selected = candidates.find(
    (candidate): candidate is { role: string; value: Record<string, unknown> } =>
      isRecord(candidate.value) && typeof candidate.value.file === 'string',
  )
  const source = selected?.value
  const details: string[] = []
  if (typeof provenance?.sourceMapConfidence === 'string') {
    details.push(`source-map ${provenance.sourceMapConfidence}`)
  }
  if (typeof provenance?.package === 'string') details.push(`package ${provenance.package}`)
  if (typeof provenance?.failureReason === 'string') {
    details.push(`provenance ${provenance.failureReason}`)
  }
  if (typeof record.sourceOwnership === 'string') details.push(`owner ${record.sourceOwnership}`)
  const wrappers = Array.isArray(record.wrapperAncestry)
    ? record.wrapperAncestry
        .filter(isRecord)
        .map((wrapper) =>
          typeof wrapper.name === 'string'
            ? wrapper.name
            : typeof wrapper.kind === 'string'
              ? wrapper.kind
              : null,
        )
        .filter((value): value is string => value !== null)
    : []
  if (wrappers.length > 0) details.push(`wrappers ${wrappers.join('→')}`)

  if (!source || typeof source.file !== 'string') {
    return details.length > 0 ? ` (${details.join(' · ')})` : ''
  }
  const segments = source.file.split('/').filter(Boolean)
  const base = segments.pop() || source.file
  const parent = GENERIC_BASENAMES.test(base) ? segments.pop() : undefined
  const label = parent ? `${parent}/${base}` : base
  const location = typeof source.line === 'number' ? `${label}:${source.line}` : label
  const role = selected?.role && selected.role !== 'source' ? `${selected.role} ` : ''
  return ` (${role}${location}${details.length > 0 ? ` · ${details.join(' · ')}` : ''})`
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
