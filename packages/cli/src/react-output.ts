import { isRecord } from './guards'

export const reactSummarizers: Record<string, (result: unknown) => string | null> = {
  react_get_renders: summarizeRenders,
  react_render_causes: summarizeRenderCauses,
  react_effect_audit: summarizeEffects,
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
  const lines = [
    `${num(summary.commits)} commits · ${num(summary.trackedComponents)} components · ${num(summary.totalRenders)} renders · ${num(summary.totalUpdates)} updates · ${num(summary.unstableComponents)} unstable · ${num(summary.unnecessaryComponents)} unnecessary${trackingOff}`,
  ]

  const topUnstableProps = summary.topUnstableProps
  if (Array.isArray(topUnstableProps) && topUnstableProps.length > 0) {
    const props = topUnstableProps
      .filter(isRecord)
      .map((prop) => `${String(prop.name)}×${num(prop.count)}`)
      .join(', ')
    lines.push(`unstable props: ${props}`)
  }

  const records = components.filter(isRecord)
  const width = Math.max(0, ...records.map((component) => String(component.name).length))
  for (const component of records) {
    const parts = [
      `  ${String(component.name).padEnd(width)} #${num(component.id)} ${num(component.renders)}× (${num(component.mounts)}m ${num(component.updates)}u)`,
    ]
    if (num(component.unnecessary) > 0) parts.push(`· ${num(component.unnecessary)} unnec`)
    if (num(component.unstableRenders) > 0)
      parts.push(`· ${num(component.unstableRenders)} unstable`)
    if (component.forget === true) parts.push('· forget')
    parts.push(`· self ${round(num(component.selfTime))}ms`)
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
  switch (cause.kind) {
    case 'mount':
      return 'mount'
    case 'props':
      return `prop ${String(cause.name)}${cause.unstable === true ? ' (unstable)' : ''}`
    case 'state':
      return `${String(cause.name)} ${renderChangeValue(cause.before)}→${renderChangeValue(cause.after)}`
    case 'children':
      return 'children'
    case 'context':
      return `context ${String(cause.name)} ${renderChangeValue(cause.before)}→${renderChangeValue(cause.after)}`
    case 'query': {
      const hash = typeof cause.queryHash === 'string' ? ` ${cause.queryHash}` : ''
      return `query${hash}${changedFieldsSuffix(cause.changedFields)}`
    }
    case 'router':
      return `router${changedFieldsSuffix(cause.changedFields)}`
    case 'external-store':
      return `external store hook[${num(cause.hookIndex)}]${changedFieldsSuffix(cause.changedFields)}`
    case 'parent':
      return `parent ${String(cause.parentName)} #${num(cause.parentId)}`
    default:
      return 'unknown cause'
  }
}

function changedFieldsSuffix(fields: unknown): string {
  if (!Array.isArray(fields)) return ''
  const names = fields.filter((field): field is string => typeof field === 'string')
  return names.length > 0 ? ` changed ${names.slice(0, 5).join(',')}` : ''
}

export function summarizeRenderCauses(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.events)) return null
  const events = result.events.filter(isRecord)
  const lines = [
    `${events.length} causal render event${events.length === 1 ? '' : 's'} · ${num(result.commits)} commits`,
  ]
  for (const event of events) {
    const cause = renderCausalEvidence(event.causes) ?? 'unknown cause'
    lines.push(
      `  commit ${num(event.commitId)} · ${String(event.componentName)} #${num(event.componentId)} · ${String(event.necessity)} · ↻ ${cause}${sourceSuffix(event)}`,
    )
  }
  return lines.join('\n')
}

export function summarizeEffects(result: unknown): string | null {
  if (!isRecord(result)) return null
  const { components } = result
  if (!Array.isArray(components)) return null

  const trackingOff = result.tracking === false ? ' · ! tracking off (run react_profile_start)' : ''
  const criteria = isRecord(result.hotnessCriteria) ? result.hotnessCriteria : null
  const threshold = criteria
    ? ` · hot ≥${num(criteria.minUpdates)} updates @ ${Math.round(num(criteria.minFireRate) * 100)}%`
    : ''
  const lines = [
    `${num(result.commits)} commits · ${components.length} components with effects${threshold}${trackingOff}`,
  ]
  for (const component of components) {
    if (!isRecord(component) || !Array.isArray(component.effects)) continue
    const head = `${String(component.name)} #${num(component.id)}`
    for (const effect of component.effects) {
      if (!isRecord(effect)) continue
      const parts = [
        `  ${head} [${num(effect.index)}] ${String(effect.kind)} deps=${String(effect.depsMode)}(${num(effect.depCount)}) fired ${num(effect.fired)}/${num(effect.updates)}`,
      ]
      const hotness = isRecord(effect.hotness) ? effect.hotness : null
      if (hotness?.label === 'hot') parts.push('HOT')
      else if (hotness?.label === 'insufficient-data')
        parts.push(`sample ${num(hotness.samples)}/${num(hotness.minUpdates)}`)
      else if (!hotness && effect.firesEveryUpdate === true) parts.push('EVERY')
      parts.push(effect.hasCleanup === true ? 'cleanup' : 'no-cleanup')
      if (typeof effect.note === 'string' && effect.note.length > 0)
        parts.push(`· ! ${effect.note}`)
      const provenance = isRecord(effect.provenance) ? effect.provenance : null
      if (provenance?.ownership === 'library')
        parts.push(
          typeof provenance.packageName === 'string' ? `· lib:${provenance.packageName}` : '· lib',
        )
      else if (provenance?.ownership === 'unknown')
        parts.push(`· owner unknown (${String(provenance.reason)})`)
      else if (!provenance && effect.isLibrary === true) parts.push('· lib')
      lines.push(parts.join(' ') + sourceSuffix(effect))
    }
  }
  return lines.join('\n')
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
    .map((change) => `${String(change.name)}${change.unstable === true ? '(unstable)' : ''}`)
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
  const lines = [`${num(result.commits)} commits${trackingOff}`]
  const row = (
    label: string,
    items: unknown,
    format: (record: Record<string, unknown>) => string,
  ): void => {
    if (!Array.isArray(items) || items.length === 0) return
    lines.push(`${label}: ${items.filter(isRecord).slice(0, 5).map(format).join(', ')}`)
  }
  row(
    'slowest',
    result.slowest,
    (record) => `${String(record.name)} ${round(num(record.selfTime))}ms×${num(record.renders)}`,
  )
  row(
    're-rendered',
    result.mostRerendered,
    (record) => `${String(record.name)} ${num(record.renders)}×`,
  )
  row(
    'unnecessary',
    result.mostUnnecessary,
    (record) => `${String(record.name)} ${num(record.unnecessary)}/${num(record.renders)}`,
  )
  row(
    'unstable',
    result.mostUnstable,
    (record) => `${String(record.name)} ${num(record.unstableRenders)}/${num(record.renders)}`,
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
    `${round(num(self.before))}ms → ${round(num(self.after))}ms (${pct}) · commits ${num(commits.before)}→${num(commits.after)} · ${regressed.length} regressed · ${improved.length} improved`,
  ]
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
  return `snapshot "${result.label}" · ${num(result.commits)} commits · ${num(result.components)} components`
}

const GENERIC_BASENAMES = /^(index|main|app|page|layout|route)\.[jt]sx?$/i

function sourceSuffix(record: Record<string, unknown>): string {
  const { source } = record
  if (!isRecord(source) || typeof source.file !== 'string') return ''
  const segments = source.file.split('/').filter(Boolean)
  const base = segments.pop() || source.file
  const parent = GENERIC_BASENAMES.test(base) ? segments.pop() : undefined
  const label = parent ? `${parent}/${base}` : base
  return typeof source.line === 'number' ? ` (${label}:${source.line})` : ` (${label})`
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

function bounded(raw: string | undefined): string {
  if (!raw) return '(none)'
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
}

const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
const round = (value: number): number => Math.round(value * 10) / 10
const signed = (value: number): string => (value > 0 ? `+${round(value)}` : String(round(value)))
