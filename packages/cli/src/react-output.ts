import { isRecord } from './guards'
import {
  attributionSuffix,
  coverageLabel,
  coverageSuffix,
  inputAttributionSuffix,
  renderEventRetentionSuffix,
} from './react-coverage-output'
import { summarizeEffectEvents, summarizeEffects } from './react-effect-output'
import { bounded, num, preferredCount, sourceSuffix } from './react-output-utils'

export { summarizeEffectEvents, summarizeEffects } from './react-effect-output'

export const reactSummarizers: Record<string, (result: unknown) => string | null> = {
  react_get_renders: summarizeRenders,
  react_render_causes: summarizeRenderCauses,
  react_component_cohort: summarizeComponentCohort,
  react_effect_audit: summarizeEffects,
  react_effect_events: summarizeEffectEvents,
  react_get_tree: summarizeTree,
  react_dom_for_component: summarizeDom,
  react_component_for_dom: summarizeComponentForDom,
  react_find_components: summarizeFindComponents,
  react_inspect_component: summarizeInspect,
  react_error_state: summarizeErrorState,
  react_profile_report: summarizeProfile,
  react_list_overrides: summarizeListOverrides,
  react_reset_overrides: summarizeResetOverrides,
  react_renders_diff: summarizeRendersDiff,
  react_profile_snapshot: summarizeProfileSnapshot,
}

export function summarizeRenders(result: unknown): string | null {
  if (!isRecord(result)) return null
  const { summary, components } = result
  if (!isRecord(summary) || !Array.isArray(components)) return null

  const trackingOff = result.tracking === false ? ' · ! tracking off (run react_profile_start)' : ''
  const noObservedInputChangeComponents = preferredCount(
    summary.noObservedInputChangeComponents,
    summary.unnecessaryComponents,
  )
  const referenceOnlyPropComponents = preferredCount(
    summary.referenceOnlyPropComponents,
    summary.unstableComponents,
  )
  const omitted =
    typeof result.omittedByLimit === 'number'
      ? result.omittedByLimit
      : Math.max(0, num(summary.trackedComponents) - components.length)
  const lines = [
    `${num(summary.commits)} commits · ${num(summary.trackedComponents)} components · ${num(summary.totalRenders)} renders · ${num(summary.totalUpdates)} updates${referenceOnlyPropComponents > 0 ? ` · ${referenceOnlyPropComponents} reference-only prop candidates` : ''} · ${noObservedInputChangeComponents} no observed input change${omitted > 0 ? ` · ${omitted} omitted` : ''}${attributionSuffix(result.attribution)}${coverageSuffix(result.coverage)}${trackingOff}`,
  ]

  const topReferenceOnlyProps = Array.isArray(summary.topReferenceOnlyProps)
    ? summary.topReferenceOnlyProps
    : summary.topUnstableProps
  if (Array.isArray(topReferenceOnlyProps) && topReferenceOnlyProps.length > 0) {
    const props = topReferenceOnlyProps
      .filter(isRecord)
      .map((prop) => `${String(prop.name)}×${num(prop.count)}`)
      .join(', ')
    lines.push(`reference-only props: ${props}`)
  }

  const records = components.filter(isRecord)
  const width = Math.max(0, ...records.map((component) => String(component.name).length))
  for (const component of records) {
    const parts = [
      `  ${String(component.name).padEnd(width)} #${num(component.id)} ${num(component.renders)}× (${num(component.mounts)}m ${num(component.updates)}u)`,
    ]
    const noObservedInputChange = preferredCount(
      component.noObservedInputChange,
      component.unnecessary,
    )
    if (noObservedInputChange > 0) parts.push(`· ${noObservedInputChange} no observed input change`)
    const referenceOnlyPropRenders = preferredCount(
      component.referenceOnlyPropRenders,
      component.unstableRenders,
    )
    if (referenceOnlyPropRenders > 0)
      parts.push(`· ${referenceOnlyPropRenders} reference-only props`)
    if (hasMemoCacheEvidence(component)) parts.push('· memo cache')
    const assessment = renderAssessmentEvidence(component.assessment)
    if (assessment) parts.push(`· ${assessment}`)
    parts.push(`· peak self ${round(num(component.selfTime))}ms`)
    const cause = renderCausalEvidence(component.causes) ?? renderCause(component.changes)
    if (cause) parts.push(`· ↻ ${cause}`)
    lines.push(parts.join(' ') + sourceSuffix(component))
  }
  return lines.join('\n')
}

function renderCausalEvidence(causes: unknown): string | null {
  if (!Array.isArray(causes)) return null
  const labels = causes.filter(isRecord).slice(0, 4).map(renderCausalCause)
  if (labels.length === 0) return null
  if (causes.length > 4) labels.push(`+${causes.length - 4} more`)
  return labels.join('; ')
}

function renderCausalCause(cause: Record<string, unknown>): string {
  const evidence = evidenceSuffix(cause.evidence)
  switch (cause.kind) {
    case 'mount':
      return `mount${evidence}`
    case 'props':
      return `prop ${String(cause.name)}${cause.referenceOnly === true ? ' (reference-only)' : cause.referenceChanged === true || cause.unstable === true ? ' (reference changed)' : ''}${changedPathsSuffix(cause.deepDiff)}${evidence}`
    case 'state':
      return `${String(cause.name)} ${renderChangeValue(cause.before)}→${renderChangeValue(cause.after)}${evidence}`
    case 'children':
      return `children${evidence}`
    case 'context':
      return `context ${String(cause.name)} ${renderChangeValue(cause.before)}→${renderChangeValue(cause.after)}${evidence}`
    case 'query': {
      const hash = typeof cause.queryHash === 'string' ? ` ${bounded(cause.queryHash)}` : ''
      return `query${hash}${changedFieldsSuffix(cause.changedFields)}${changedPathsSuffix(cause.deepDiff)}${identitySuffix(cause)}${hookProvenanceSuffix(cause.hookProvenance)}${evidence}`
    }
    case 'router':
      return `router${changedFieldsSuffix(cause.changedFields)}${changedPathsSuffix(cause.deepDiff)}${identitySuffix(cause)}${hookProvenanceSuffix(cause.hookProvenance)}${evidence}`
    case 'external-store':
      return `external store hook[${num(cause.hookIndex)}]${changedFieldsSuffix(cause.changedFields)}${changedPathsSuffix(cause.deepDiff)}${identitySuffix(cause)}${hookProvenanceSuffix(cause.hookProvenance)}${evidence}`
    case 'parent':
      return `parent ${String(cause.parentName)} #${num(cause.parentId)}${evidence}`
    default:
      return `unknown cause${evidence}`
  }
}

function evidenceSuffix(value: unknown): string {
  return value === 'exact' || value === 'inferred' || value === 'unknown' ? ` (${value})` : ''
}

function changedFieldsSuffix(fields: unknown): string {
  if (!Array.isArray(fields)) return ''
  const names = fields.filter((field): field is string => typeof field === 'string')
  return names.length > 0 ? ` changed ${names.slice(0, 5).join(',')}` : ''
}

function changedPathsSuffix(diff: unknown): string {
  if (!isRecord(diff) || !Array.isArray(diff.changes)) return ''
  const paths = [...new Set(diff.changes.filter(isRecord).map((change) => change.path))].filter(
    (path): path is string => typeof path === 'string',
  )
  const incomplete = diff.truncated === true ? ' (incomplete)' : ''
  if (paths.length === 0) return incomplete ? ` paths unavailable${incomplete}` : ''
  const shown = paths.slice(0, 3).map((path) => path || '<root>')
  return ` paths ${shown.join(',')}${paths.length > shown.length ? `,+${paths.length - shown.length}` : ''}${incomplete}`
}

function identitySuffix(cause: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof cause.observerId === 'string') parts.push(`observer ${cause.observerId}`)
  if (typeof cause.subscriberId === 'string') parts.push(`subscriber ${cause.subscriberId}`)
  if (typeof cause.routerId === 'string') parts.push(cause.routerId)
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
}

function hookProvenanceSuffix(provenance: unknown): string {
  if (!isRecord(provenance)) return ''
  if (provenance.status === 'unavailable' && typeof provenance.reason === 'string') {
    return ` · hook source unknown (${bounded(provenance.reason)})`
  }
  if (provenance.status !== 'exact' || !isRecord(provenance.callsite)) return ''
  const source = provenance.callsite
  if (typeof source.file !== 'string') return ''
  const base = source.file.split('/').filter(Boolean).pop() || source.file
  return ` · hook ${base}${typeof source.line === 'number' ? `:${source.line}` : ''}`
}

export function summarizeRenderCauses(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.events)) return null
  const events = result.events.filter(isRecord)
  const lines = [
    `${events.length} causal render event${events.length === 1 ? '' : 's'} · ${num(result.commits)} commits${num(result.omittedByLimit) > 0 ? ` · ${num(result.omittedByLimit)} omitted` : ''}${attributionSuffix(result.attribution)}${renderEventRetentionSuffix(result.renderEventRetention)}${coverageSuffix(result.coverage)}`,
  ]
  for (const event of events) {
    const cause = renderCausalEvidence(event.causes) ?? 'unknown cause'
    const evidence =
      renderAssessmentEvidence(event.assessment) ?? renderLegacyNecessity(event.necessity)
    lines.push(
      `  commit ${num(event.commitId)} · ${String(event.componentName)} #${num(event.componentId)} · ${evidence} · ↻ ${cause}${sourceSuffix(event)}`,
    )
  }
  return lines.join('\n')
}

function renderAssessmentEvidence(assessment: unknown): string | null {
  if (!isRecord(assessment)) return null

  let input: string
  switch (assessment.inputEvidence) {
    case 'mount':
      input = 'mount'
      break
    case 'changed':
      input = 'changed'
      break
    case 'none-observed':
      input = 'no observed input change'
      break
    case 'incomplete':
      input = 'incomplete'
      break
    default:
      input = 'unknown'
  }

  const needsSafety =
    assessment.optimizationSafety === 'not-proven-safe' &&
    (assessment.inputEvidence === 'none-observed' ||
      assessment.inputEvidence === 'incomplete' ||
      input === 'unknown')
  return `input: ${input}${needsSafety ? ' · not proven safe' : ''}`
}

function renderLegacyNecessity(necessity: unknown): string {
  if (necessity === 'unnecessary') return 'no observed input change'
  if (necessity === 'necessary' || necessity === 'unknown') return necessity
  return 'unknown'
}

function hasMemoCacheEvidence(component: Record<string, unknown>): boolean {
  if (isRecord(component.compiler)) return component.compiler.memoCacheObserved === true
  return component.forget === true
}

export function summarizeComponentCohort(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.query) || !Array.isArray(result.instances)) return null
  if (typeof result.query.component !== 'string') return null

  const target = bounded(JSON.stringify(result.query.component))
  if (result.status === 'not-started') {
    return `${target} · measurement not started · run react_clear_renders`
  }

  const status = cohortStatus(result.status)
  const parts = [
    target,
    status,
    `${num(result.matched)} matched`,
    `${num(result.mountedUpdated)} updated`,
    `${num(result.mountedIdle)} mounted idle`,
    `${num(result.mountedUnknown)} mounted unknown`,
    `${num(result.unmounted)} unmounted`,
  ]
  if (num(result.omittedByLimit) > 0) parts.push(`${num(result.omittedByLimit)} omitted`)
  const coverage = coverageLabel(result.coverage)
  if (coverage) parts.push(coverage)

  const lines = [parts.join(' · ')]
  for (const entry of result.instances) {
    if (!isRecord(entry) || !isRecord(entry.instance)) continue
    const instance = entry.instance
    const line = [
      `  ${cohortInstanceStatus(entry.status)}`,
      cohortInstanceLabel(entry, instance),
      `mount ${String(instance.mountId)}`,
      `generation ${num(instance.mountGeneration)}${instance.mountGenerationEvidence === 'unknown' ? ' (unknown)' : ''}`,
    ]
    if (typeof instance.logicalIdentityEvidence === 'string')
      line.push(instance.logicalIdentityEvidence)
    if (typeof instance.logicalPath === 'string') line.push(bounded(instance.logicalPath))
    lines.push(line.join(' · '))
  }
  return lines.join('\n')
}

function cohortStatus(value: unknown): string {
  switch (value) {
    case 'mounted-idle':
      return 'mounted idle'
    case 'updated':
      return 'updated'
    case 'unmounted':
      return 'unmounted'
    case 'mixed':
      return 'mixed'
    case 'absent':
      return 'absent'
    default:
      return 'unknown'
  }
}

function cohortInstanceStatus(value: unknown): string {
  if (value === 'mounted-updated') return 'updated'
  if (value === 'mounted-idle') return 'mounted idle'
  if (value === 'mounted-unknown') return 'mounted unknown'
  if (value === 'unmounted') return 'unmounted'
  return 'unknown'
}

function cohortInstanceLabel(
  entry: Record<string, unknown>,
  instance: Record<string, unknown>,
): string {
  const name = String(entry.componentName)
  if (typeof instance.key === 'string')
    return `${name} key=${bounded(JSON.stringify(instance.key))}`
  if (typeof instance.siblingIndex === 'number') return `${name} index=${instance.siblingIndex}`
  return name
}

export function summarizeDom(result: unknown): string | null {
  if (!isRecord(result)) return null
  const { elements, name, total } = result
  if (!Array.isArray(elements)) return null

  const count = num(total)
  const lines = [`${String(name)} → ${count} DOM element${count === 1 ? '' : 's'}`]
  for (const element of elements) {
    if (!isRecord(element)) continue
    const parts = [`  ${String(element.selector)}`]
    if (typeof element.role === 'string') parts.push(`· role=${element.role}`)
    if (typeof element.text === 'string' && element.text.length > 0)
      parts.push(`· ${JSON.stringify(element.text)}`)
    lines.push(parts.join(' '))
  }
  return lines.join('\n')
}

export function summarizeTree(result: unknown): string | null {
  if (!isRecord(result)) return null
  const { nodes } = result
  if (!Array.isArray(nodes)) return null

  const byId = new Map<number, Record<string, unknown>>()
  for (const node of nodes) {
    if (isRecord(node) && typeof node.id === 'number') byId.set(node.id, node)
  }

  const truncated =
    result.truncated === true && typeof result.truncatedBy === 'string'
      ? ` · truncated by ${result.truncatedBy}`
      : ''
  const root = typeof result.rootId === 'number' ? `#${result.rootId}` : '#none'
  const lines = [`${nodes.length}/${num(result.total)} nodes · root ${root}${truncated}`]

  for (const node of nodes) {
    if (!isRecord(node)) continue
    const label = node.kind === 'host' ? `<${String(node.name)}>` : String(node.name)
    const key = typeof node.key === 'string' && node.key.length > 0 ? ` key=${node.key}` : ''
    lines.push(`${'  '.repeat(depthOf(node, byId))}${label}${key}`)
  }
  return lines.join('\n')
}

function depthOf(
  node: Record<string, unknown>,
  byId: Map<number, Record<string, unknown>>,
): number {
  let depth = 0
  let parentId = node.parentId
  const seen = new Set<number>()
  while (typeof parentId === 'number' && byId.has(parentId) && !seen.has(parentId)) {
    seen.add(parentId)
    depth++
    parentId = byId.get(parentId)?.parentId
  }
  return depth
}

function renderCause(changes: unknown): string | null {
  if (!Array.isArray(changes)) return null
  const records = changes.filter(isRecord)
  if (records.length === 0) return null

  const propNames = records
    .filter((change) => change.kind === 'props')
    .map(
      (change) =>
        `${String(change.name)}${change.referenceOnly === true ? '(reference-only)' : change.referenceChanged === true || change.unstable === true ? '(reference changed)' : ''}`,
    )
  const stateChanges = records.filter((change) => change.kind === 'state')

  const segments: string[] = []
  if (propNames.length > 0) segments.push(`props: ${propNames.join(', ')}`)
  for (const change of stateChanges) {
    if ('before' in change && 'after' in change) {
      segments.push(
        `${String(change.name)} ${renderChangeValue(change.before)}→${renderChangeValue(change.after)}`,
      )
    } else if (!segments.includes('state')) {
      segments.push('state')
    }
  }
  return segments.length > 0 ? segments.join(' · ') : null
}

function renderChangeValue(value: unknown): string {
  if (isRecord(value) && value.__genie_dehydrated__ === true && typeof value.preview === 'string') {
    return value.preview
  }
  if (Array.isArray(value) || isRecord(value)) return recordPreview(value)
  if (value === undefined) return 'undefined'
  return bounded(JSON.stringify(value))
}

export function summarizeFindComponents(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.matches)) return null
  const matches = result.matches.filter(isRecord)
  if (matches.length === 0) return 'No components found.'
  const lines = [`${matches.length} match${matches.length === 1 ? '' : 'es'}`]
  for (const match of matches) {
    lines.push(`  ${String(match.name)} #${num(match.id)} — ${String(match.path)}`)
  }
  return lines.join('\n')
}

export function summarizeComponentForDom(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.components)) return null
  const matched = num(result.matched)
  const components = result.components.filter(isRecord)
  const lines = [
    `${JSON.stringify(String(result.selector))} → ${matched} element${matched === 1 ? '' : 's'} · ${components.length} component${components.length === 1 ? '' : 's'}`,
  ]
  for (const component of components) {
    const parts = [
      `  ${String(component.name)} #${num(component.id)} (${String(component.kind)}) <${String(component.tag)}>`,
    ]
    if (component.isLibrary === true) parts.push('· lib')
    lines.push(parts.join(' ') + sourceSuffix(component))
  }
  return lines.join('\n')
}

const MAX_HOOK_LINES = 16

export function summarizeInspect(result: unknown): string | null {
  if (!isRecord(result) || typeof result.name !== 'string' || !('props' in result)) return null
  const lines = [`${result.name} #${num(result.id)} · ${String(result.kind)}`]
  lines.push(`  props: ${recordPreview(result.props)}`)
  if (result.state !== undefined) lines.push(`  state: ${recordPreview(result.state)}`)
  if (Array.isArray(result.hooks)) {
    const hooks = result.hooks.filter(isRecord)
    lines.push(`  hooks: ${hooks.length}`)
    for (const hook of hooks.slice(0, MAX_HOOK_LINES)) {
      const ordinal = typeof hook.stateIndex === 'number' ? ` stateIndex ${hook.stateIndex}` : ''
      const value = 'value' in hook ? ` = ${recordPreview(hook.value)}` : ''
      lines.push(`    [${num(hook.index)}] ${String(hook.kind)}${ordinal}${value}`)
    }
    if (hooks.length > MAX_HOOK_LINES) lines.push(`    +${hooks.length - MAX_HOOK_LINES} more`)
  }
  return lines.join('\n')
}

export function summarizeErrorState(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.caughtErrors) || !Array.isArray(result.suspended))
    return null
  const caught = result.caughtErrors.filter(isRecord)
  const suspended = result.suspended.filter(isRecord)
  if (caught.length === 0 && suspended.length === 0) {
    return 'no caught errors · nothing suspended'
  }
  const lines = [`${caught.length} caught · ${suspended.length} suspended`]
  for (const entry of caught) {
    const parts = [
      `  ${String(entry.boundaryName)} #${num(entry.boundaryId)} caught ${entry.message == null ? '(no message)' : JSON.stringify(entry.message)}`,
    ]
    if (typeof entry.throwingComponent === 'string') parts.push(`from ${entry.throwingComponent}`)
    if (entry.isLibraryBoundary === true) parts.push('· lib boundary')
    lines.push(parts.join(' ') + sourceSuffix({ source: entry.boundarySource }))
  }
  for (const entry of suspended) {
    const state =
      entry.isFallbackShowing === true ? 'fallback SHOWING' : 'suspended (fallback hidden)'
    lines.push(
      `  ${String(entry.boundaryName)} #${num(entry.boundaryId)} ${state}${sourceSuffix(entry)}`,
    )
  }
  if (typeof result.blankTreeHint === 'string' && result.blankTreeHint.length > 0) {
    lines.push(`hint: ${result.blankTreeHint}`)
  }
  return lines.join('\n')
}

export function summarizeProfile(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.slowest)) return null
  const trackingOff = result.tracking === false ? ' · ! tracking off (run react_profile_start)' : ''
  const lines = [
    `${num(result.commits)} commits${attributionSuffix(result.attribution)}${coverageSuffix(result.coverage)}${inputAttributionSuffix(result.coverage)}${trackingOff}`,
  ]
  const row = (
    label: string,
    items: unknown,
    format: (record: Record<string, unknown>) => string,
  ): void => {
    if (!Array.isArray(items) || items.length === 0) return
    lines.push(`${label}: ${items.filter(isRecord).slice(0, 5).map(format).join(', ')}`)
  }
  row(
    'slowest (peak)',
    result.slowest,
    (record) => `${String(record.name)} ${round(num(record.selfTime))}ms×${num(record.renders)}`,
  )
  row(
    're-rendered',
    result.mostRerendered,
    (record) => `${String(record.name)} ${num(record.renders)}×`,
  )
  row(
    'no observed input change',
    result.mostUnnecessary,
    (record) =>
      `${String(record.name)} ${preferredCount(record.noObservedInputChange, record.unnecessary)}/${num(record.renders)}`,
  )
  const referenceOnly = Array.isArray(result.mostReferenceOnly)
    ? result.mostReferenceOnly
    : result.mostUnstable
  row(
    'reference-only props',
    referenceOnly,
    (record) =>
      `${String(record.name)} ${preferredCount(record.referenceOnlyPropRenders, record.unstableRenders)}/${num(record.renders)}`,
  )
  return lines.join('\n')
}

export function summarizeListOverrides(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.overrides)) return null
  const overrides = result.overrides.filter(isRecord)
  const total = num(result.total)
  if (total === 0 && overrides.length === 0) return 'no active overrides'
  const lines = [`${total} active override${total === 1 ? '' : 's'}`]
  for (const override of overrides) {
    const id = override.componentId == null ? '' : ` #${num(override.componentId)}`
    const unmounted = override.mounted === false ? ' (unmounted)' : ''
    lines.push(
      `  [${String(override.kind)}] ${String(override.componentName)}${id} — ${String(override.detail)}${unmounted}`,
    )
  }
  return lines.join('\n')
}

export function summarizeResetOverrides(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.cleared)) return null
  const cleared = result.cleared.filter(isRecord)
  const lines = [
    `cleared ${cleared.length} override${cleared.length === 1 ? '' : 's'} · ${num(result.remaining)} remaining`,
  ]
  for (const entry of cleared) {
    lines.push(
      `  [${String(entry.kind)}] ${String(entry.componentName)} — ${String(entry.outcome)}`,
    )
  }
  return lines.join('\n')
}

export function summarizeRendersDiff(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.selfTimeMs) || !isRecord(result.commits)) return null
  const self = result.selfTimeMs
  const commits = result.commits
  const regressed = Array.isArray(result.regressed) ? result.regressed.filter(isRecord) : []
  const improved = Array.isArray(result.improved) ? result.improved.filter(isRecord) : []
  const pct = self.pct === null ? 'n/a' : `${num(self.pct) > 0 ? '+' : ''}${round(num(self.pct))}%`
  const lines = [
    `window self ${round(num(self.before))}ms → ${round(num(self.after))}ms (${pct}) · commits ${num(commits.before)}→${num(commits.after)} · ${regressed.length} regressed · ${improved.length} improved`,
  ]
  if (isRecord(result.coverage)) {
    const baselineCoverage = coverageLabel(result.coverage.baseline)
    const currentCoverage = coverageLabel(result.coverage.current)
    if (baselineCoverage) lines.push(`  baseline ${baselineCoverage}`)
    if (currentCoverage) lines.push(`  current ${currentCoverage}`)
  }
  const clears = num(result.clearsSinceBaseline)
  if (clears > 0)
    lines.push(
      `  counters cleared ${clears}× since baseline — session-vs-session compare; "removed" = not re-rendered since the clear`,
    )
  const line = (entry: Record<string, unknown>): string =>
    `  ${String(entry.name)} ${signed(num(entry.deltaMs))}ms`
  for (const entry of regressed.slice(0, 5)) lines.push(line(entry))
  for (const entry of improved.slice(0, 5)) lines.push(line(entry))
  return lines.join('\n')
}

export function summarizeProfileSnapshot(result: unknown): string | null {
  if (!isRecord(result) || typeof result.label !== 'string') return null
  return `snapshot "${result.label}" · ${num(result.commits)} commits · ${num(result.components)} components${coverageSuffix(result.coverage)}`
}

function recordPreview(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[0 items]'
    const first = value[0]
    const firstPreview = isRecord(first)
      ? `{${Object.keys(first).slice(0, 6).join(', ')}}`
      : bounded(JSON.stringify(first))
    return `[${value.length} items] first: ${firstPreview}`
  }
  if (!isRecord(value)) {
    return value === undefined ? '(none)' : bounded(JSON.stringify(value))
  }
  const keys = Object.keys(value)
  if (keys.length === 0) return '{}'
  const parts = keys.slice(0, 8).map((key) => {
    const entry = value[key]
    const primitive =
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean'
    return primitive ? `${key}=${JSON.stringify(entry)}` : key
  })
  if (keys.length > 8) parts.push(`+${keys.length - 8} more`)
  return parts.join(', ')
}

const round = (value: number): number => Math.round(value * 10) / 10
const signed = (value: number): string => (value > 0 ? `+${round(value)}` : String(round(value)))
