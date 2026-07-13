import { isRecord } from './guards'
import {
  attributionSuffix,
  effectCoverageLabel,
  effectCoverageSuffix,
} from './react-coverage-output'
import {
  num,
  preferredBoolean,
  preferredCount,
  preferredOptionalCount,
  sourceSuffix,
} from './react-output-utils'

export function summarizeEffects(result: unknown): string | null {
  if (!isRecord(result)) return null
  const { components } = result
  if (!Array.isArray(components)) return null

  const trackingOff = result.tracking === false ? ' · ! tracking off (run react_profile_start)' : ''
  const criteria = isRecord(result.hotnessCriteria) ? result.hotnessCriteria : null
  const minScheduleRate = criteria
    ? preferredOptionalCount(criteria.minScheduleRate, criteria.minFireRate)
    : null
  const threshold =
    criteria && minScheduleRate !== null
      ? ` · hot ≥${num(criteria.minUpdates)} updates @ ${Math.round(minScheduleRate * 100)}%`
      : ''
  const lines = [
    `${num(result.commits)} commits · ${components.length} component${components.length === 1 ? '' : 's'} with effects${threshold}${omittedByLimitSuffix(result.omittedByLimit, 200)}${effectFindingsOmittedSuffix(result.effectsOmittedByLimit)}${attributionSuffix(result.attribution)}${effectCoverageSuffix(result.coverage)}${trackingOff}`,
  ]
  for (const component of components) {
    if (!isRecord(component) || !Array.isArray(component.effects)) continue
    const head = `${String(component.name)} #${num(component.id)}`
    for (const effect of component.effects) {
      if (!isRecord(effect)) continue
      const scheduled = preferredCount(effect.scheduled, effect.fired)
      const parts = [
        `  ${head} [${num(effect.index)}] ${String(effect.kind)} deps=${String(effect.depsMode)}(${num(effect.depCount)}) scheduled ${scheduled}/${num(effect.updates)}`,
      ]
      const hotness = isRecord(effect.hotness) ? effect.hotness : null
      if (hotness?.label === 'hot') parts.push('HOT')
      else if (hotness?.label === 'insufficient-data')
        parts.push(`sample ${num(hotness.samples)}/${num(hotness.minUpdates)}`)
      else if (
        !hotness &&
        preferredBoolean(effect.schedulesEveryUpdate, effect.firesEveryUpdate) === true
      )
        parts.push('EVERY')
      parts.push(
        preferredBoolean(effect.cleanupFunctionObserved, effect.hasCleanup) === true
          ? 'cleanup function observed'
          : 'no cleanup function observed',
      )
      if (typeof effect.note === 'string' && effect.note.length > 0)
        parts.push(`· ! ${effect.note}`)
      const provenance = isRecord(effect.provenance) ? effect.provenance : null
      const evidence = provenanceEvidence(provenance)
      if (provenance?.ownership === 'library')
        parts.push(
          typeof provenance.packageName === 'string'
            ? `· lib:${provenance.packageName}/${evidence}`
            : `· library/${evidence}`,
        )
      else if (provenance?.ownership === 'app') parts.push(`· app/${evidence}`)
      else if (provenance?.ownership === 'unknown')
        parts.push(`· owner unknown (${String(provenance.reason)})`)
      else if (!provenance && effect.isLibrary === true) parts.push('· lib')
      lines.push(parts.join(' ') + sourceSuffix(effect))
    }
    const componentOmitted = num(component.effectsOmitted)
    if (componentOmitted > 0) {
      lines.push(`  ${head} · ${componentOmitted} effect findings omitted by report cap`)
    }
  }
  return lines.join('\n')
}

export function summarizeEffectEvents(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.events)) return null
  const events = result.events.filter(isRecord)
  const parts = [
    `${events.length} effect schedule${events.length === 1 ? '' : 's'}`,
    `document commit ${num(result.documentCommitId)}`,
  ]
  if (isRecord(result.observation) && typeof result.observation.id === 'string')
    parts.push(`window ${result.observation.id}`)
  const omittedByLimit = num(result.omittedByLimit)
  if (omittedByLimit > 0) {
    parts.push(
      `${eventCount(omittedByLimit)} omitted by limit (retry with a higher limit, max 500, or narrow component)`,
    )
  }
  const evictedEvents = preferredCount(result.evictedEvents, result.droppedEvents)
  if (evictedEvents > 0) {
    parts.push(
      `${eventCount(evictedEvents)} evicted from retained history (call react_clear_renders, repeat the interaction, then read sooner)`,
    )
  }
  const coverage = effectCoverageLabel(result.coverage)
  if (coverage) parts.push(coverage)
  if (result.tracking === false) parts.push('tracking off (run react_clear_renders)')

  const lines = [parts.join(' · ')]
  for (const event of events) {
    const line = [
      `  document commit ${num(event.documentCommitId)}`,
      `commit ${num(event.commitId)}`,
      `${String(event.componentName)} #${num(event.componentId)} [${num(event.effectIndex)}] ${String(event.kind)}`,
      `${String(event.phase)} scheduled`,
    ]
    if (Array.isArray(event.changedDependencySlots)) {
      const slots = event.changedDependencySlots.filter(
        (slot): slot is number => typeof slot === 'number',
      )
      if (slots.length > 0) line.push(`deps ${slots.join(',')} changed`)
    }
    const omittedSlots = num(event.changedDependencySlotsOmitted)
    if (omittedSlots > 0) line.push(`${dependencySlotCount(omittedSlots)} with changes omitted`)
    const unscannedSlots = num(event.dependencySlotsUnscanned)
    if (unscannedSlots > 0) line.push(`${dependencySlotCount(unscannedSlots)} unscanned`)
    if (isRecord(event.execution)) line.push(`execution ${humanStatus(event.execution.status)}`)
    if (isRecord(event.cleanupExecution))
      line.push(`cleanup ${humanStatus(event.cleanupExecution.status)}`)
    if (isRecord(event.consequences))
      line.push(`consequences ${humanStatus(event.consequences.status)}`)
    lines.push(line.join(' · '))
  }
  return lines.join('\n')
}

function omittedByLimitSuffix(value: unknown, maxLimit: number): string {
  const count = num(value)
  return count > 0
    ? ` · ${count} omitted by limit (retry with a higher limit, max ${maxLimit}, or narrow component)`
    : ''
}

function effectFindingsOmittedSuffix(value: unknown): string {
  const count = num(value)
  return count > 0 ? ` · ${count} effect findings omitted by report cap (narrow component)` : ''
}

function eventCount(count: number): string {
  return `${count} event${count === 1 ? '' : 's'}`
}

function dependencySlotCount(count: number): string {
  return `${count} dependency slot${count === 1 ? '' : 's'}`
}

function humanStatus(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll('-', ' ') : 'unknown'
}

function provenanceEvidence(provenance: Record<string, unknown> | null): string {
  if (
    provenance?.evidence === 'exact' ||
    provenance?.evidence === 'inferred' ||
    provenance?.evidence === 'unknown'
  ) {
    return provenance.evidence
  }
  if (provenance?.confidence === 'high') return 'exact'
  if (provenance?.confidence === 'medium') return 'inferred'
  return 'unknown'
}
