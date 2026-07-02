import {
  type BridgeStatusMessage,
  devtoolsStatusContract,
  devtoolsWaitContract,
  errorMessage,
} from 'genie-react/protocol'
import { GenieAgentLink } from './agent-link'
import { resolveBridgeUrl } from './discovery'
import { isRecord } from './guards'

// The CLI's tool-calling surface: connects to the bridge as the `agent` role — straight from a shell, no separate server.

export interface AgentOptions {
  cwd?: string
  /** Override the bridge URL (else resolved from GENIE_BRIDGE_URL → .genie/bridge.json → default). */
  url?: string
  /** How long to wait for an app to connect before giving up, in ms. */
  waitMs?: number
  /** Print raw JSON (compact, machine-first) instead of the per-tool summary. */
  json?: boolean
  /** Target a specific app session when several tabs are connected (see `genie status`). */
  session?: string
  /** `genie tools --all`: the complete flat catalog instead of the progressive group index. */
  all?: boolean
}

/** Priority: --session flag → GENIE_SESSION env, so a same-app agent pins its own tab once per shell instead of repeating the flag. */
export function resolveSession(explicit?: string): string | undefined {
  return explicit ?? process.env.GENIE_SESSION ?? undefined
}

const out = (message: string): void => void process.stdout.write(`${message}\n`)
const err = (message: string): void => void process.stderr.write(`${message}\n`)

async function connect(opts: AgentOptions): Promise<{ link: GenieAgentLink; url: string }> {
  const url = opts.url ?? (await resolveBridgeUrl(opts.cwd ?? process.cwd()))
  const link = new GenieAgentLink({
    url,
    connectTimeoutMs: 8_000,
    invokeTimeoutMs: 20_000,
    sessionId: resolveSession(opts.session),
  })
  link.start()
  return { link, url }
}

const summarizers: Record<string, (result: unknown) => string | null> = {
  devtools_status: summarizeStatus,
  react_get_renders: summarizeRenders,
  react_effect_audit: summarizeEffects,
  react_get_tree: summarizeTree,
  react_dom_for_component: summarizeDom,
  react_component_for_dom: summarizeComponentForDom,
  react_find_components: summarizeFindComponents,
  react_inspect_component: summarizeInspect,
  react_error_state: summarizeErrorState,
  react_profile_report: summarizeProfile,
  query_list: summarizeQueryList,
  query_get: summarizeQueryGet,
  router_get_state: summarizeRouterState,
  router_list_matches: summarizeRouterMatches,
}

/** `--json` is machine-first (compact, parseable); the human path falls back to pretty JSON on any summarizer miss so compact mode never drops data. */
export function renderResult(tool: string, result: unknown, json?: boolean): string {
  if (json) return JSON.stringify(result)
  const summarize = summarizers[tool]
  if (!summarize) return prettyJson(result)
  return summarize(result) ?? prettyJson(result)
}

export function summarizeRenders(result: unknown): string | null {
  if (!isRecord(result)) return null
  const { summary, components } = result
  if (!isRecord(summary) || !Array.isArray(components)) return null

  const trackingOff = result.tracking === false ? ' · ⚠ tracking OFF (run react_profile_start)' : ''
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
    const changed = unstableChangeNames(component.changes)
    if (changed) parts.push(`· ↻ ${changed}`)
    lines.push(parts.join(' ') + sourceSuffix(component))
  }
  return lines.join('\n')
}

export function summarizeEffects(result: unknown): string | null {
  if (!isRecord(result)) return null
  const { components } = result
  if (!Array.isArray(components)) return null

  const trackingOff = result.tracking === false ? ' · ⚠ tracking OFF (run react_profile_start)' : ''
  const lines = [
    `${num(result.commits)} commits · ${components.length} components with effects${trackingOff}`,
  ]
  for (const component of components) {
    if (!isRecord(component) || !Array.isArray(component.effects)) continue
    const head = `${String(component.name)} #${num(component.id)}`
    for (const effect of component.effects) {
      if (!isRecord(effect)) continue
      const parts = [
        `  ${head} [${num(effect.index)}] ${String(effect.kind)} deps=${String(effect.depsMode)}(${num(effect.depCount)}) fired ${num(effect.fired)}/${num(effect.updates)}`,
      ]
      if (effect.firesEveryUpdate === true) parts.push('EVERY')
      parts.push(effect.hasCleanup === true ? 'cleanup' : 'no-cleanup')
      if (typeof effect.note === 'string' && effect.note.length > 0)
        parts.push(`· ⚠ ${effect.note}`)
      if (effect.isLibrary === true) parts.push('· lib')
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

function unstableChangeNames(changes: unknown): string | null {
  if (!Array.isArray(changes)) return null
  const names = changes
    .filter(isRecord)
    .filter((change) => change.unstable === true)
    .map((change) => String(change.name))
  return names.length > 0 ? names.join(', ') : null
}

/** Renders a `(file:line)` suffix from an optional resolved `source` field, terse for one-liners. */
function sourceSuffix(record: Record<string, unknown>): string {
  const { source } = record
  if (!isRecord(source) || typeof source.file !== 'string') return ''
  const base = source.file.split('/').pop() || source.file
  return typeof source.line === 'number' ? ` (${base}:${source.line})` : ` (${base})`
}

export function summarizeStatus(result: unknown): string | null {
  if (!isRecord(result) || typeof result.connected !== 'boolean') return null
  if (!result.connected) {
    return 'not connected — open the app in a browser (devtools_wait blocks until it connects)'
  }
  const app = isRecord(result.app) ? result.app : {}
  const head = [
    'connected',
    typeof app.name === 'string' ? app.name : null,
    typeof app.reactVersion === 'string' ? `react ${app.reactVersion}` : null,
    `${num(result.toolCount)} tools`,
  ]
    .filter(Boolean)
    .join(' · ')
  const sessions = Array.isArray(result.sessions) ? result.sessions.filter(isRecord) : []
  if (sessions.length <= 1) return head
  const lines = [`${head} · ${sessions.length} sessions`]
  for (const session of sessions) {
    const sessionApp = isRecord(session.app) ? session.app : {}
    const parts = [`  ${String(session.sessionId)}`]
    if (typeof sessionApp.name === 'string') parts.push(sessionApp.name)
    if (typeof sessionApp.url === 'string') parts.push(sessionApp.url)
    if (session.current === true) parts.push('(current)')
    lines.push(parts.join(' · '))
  }
  lines.push('target one: --session <id> (or set GENIE_SESSION once per shell)')
  return lines.join('\n')
}

export function summarizeFindComponents(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.matches)) return null
  const matches = result.matches.filter(isRecord)
  if (matches.length === 0) return '0 matches'
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

export function summarizeInspect(result: unknown): string | null {
  if (!isRecord(result) || typeof result.name !== 'string' || !('props' in result)) return null
  const lines = [`${result.name} #${num(result.id)} · ${String(result.kind)}`]
  lines.push(`  props: ${recordPreview(result.props)}`)
  if (result.state !== undefined) lines.push(`  state: ${recordPreview(result.state)}`)
  if (Array.isArray(result.hooks)) lines.push(`  hooks: ${result.hooks.length}`)
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
      `  ${String(entry.boundaryName)} #${num(entry.boundaryId)} ${state}` + sourceSuffix(entry),
    )
  }
  if (typeof result.blankTreeHint === 'string' && result.blankTreeHint.length > 0) {
    lines.push(`hint: ${result.blankTreeHint}`)
  }
  return lines.join('\n')
}

export function summarizeProfile(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.slowest)) return null
  const trackingOff = result.tracking === false ? ' · ⚠ tracking OFF (run react_profile_start)' : ''
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
    (r) => `${String(r.name)} ${round(num(r.selfTime))}ms×${num(r.renders)}`,
  )
  row('re-rendered', result.mostRerendered, (r) => `${String(r.name)} ${num(r.renders)}×`)
  row(
    'unnecessary',
    result.mostUnnecessary,
    (r) => `${String(r.name)} ${num(r.unnecessary)}/${num(r.renders)}`,
  )
  row(
    'unstable',
    result.mostUnstable,
    (r) => `${String(r.name)} ${num(r.unstableRenders)}/${num(r.renders)}`,
  )
  return lines.join('\n')
}

export function summarizeQueryList(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.queries)) return null
  const queries = result.queries.filter(isRecord)
  const total = num(result.total)
  const stale = queries.filter((query) => query.isStale === true).length
  const fetching = queries.filter((query) => query.fetchStatus === 'fetching').length
  const orphaned = isRecord(result.churn) ? num(result.churn.orphaned) : 0
  const head = [`${total} quer${total === 1 ? 'y' : 'ies'}`]
  if (queries.length < total) head.push(`(showing ${queries.length})`)
  if (stale > 0) head.push(`· ${stale} stale`)
  if (fetching > 0) head.push(`· ${fetching} fetching`)
  if (orphaned > 0) head.push(`· ⚠ ${orphaned} orphaned (churn)`)
  const lines = [head.join(' ')]
  for (const query of queries) {
    const parts = [
      `  ${keyPreview(query.queryKey, query.queryHash)}`,
      String(query.status),
      query.isStale === true ? 'stale' : 'fresh',
    ]
    if (query.fetchStatus !== 'idle') parts.push(String(query.fetchStatus))
    parts.push(`${num(query.observerCount)} obs`)
    if (num(query.recentFetches) > 0) parts.push(`⚠ ${num(query.recentFetches)} fetches/10s`)
    if (typeof query.error === 'string') parts.push(`error: ${query.error}`)
    lines.push(parts.join(' · '))
  }
  return lines.join('\n')
}

export function summarizeQueryGet(result: unknown): string | null {
  if (
    !isRecord(result) ||
    typeof result.queryHash !== 'string' ||
    typeof result.status !== 'string'
  )
    return null
  const parts = [
    keyPreview(result.queryKey, result.queryHash),
    result.status,
    result.isStale === true ? 'stale' : 'fresh',
  ]
  if (typeof result.fetchStatus === 'string' && result.fetchStatus !== 'idle')
    parts.push(result.fetchStatus)
  if (typeof result.observerCount === 'number') parts.push(`${result.observerCount} obs`)
  if (typeof result.fetchCount === 'number') parts.push(`${result.fetchCount} fetches`)
  if (num(result.recentFetches) > 0) parts.push(`⚠ ${num(result.recentFetches)}/10s`)
  if (result.hasQueryFn === false) parts.push('no queryFn')
  const lines = [parts.join(' · ')]
  if ('data' in result) lines.push(`  data: ${recordPreview(result.data)}`)
  if (typeof result.error === 'string') lines.push(`  error: ${result.error}`)
  return lines.join('\n')
}

export function summarizeRouterState(result: unknown): string | null {
  if (!isRecord(result) || typeof result.pathname !== 'string' || typeof result.status !== 'string')
    return null
  const search = typeof result.searchStr === 'string' ? result.searchStr : ''
  const hash = typeof result.hash === 'string' && result.hash.length > 0 ? `#${result.hash}` : ''
  const parts = [JSON.stringify(`${result.pathname}${search}${hash}`), result.status]
  if (result.isLoading === true) parts.push('loading')
  if (result.isTransitioning === true) parts.push('transitioning')
  parts.push(`${num(result.matchCount)} matches`)
  if (num(result.pendingMatchCount) > 0) parts.push(`${num(result.pendingMatchCount)} pending`)
  return parts.join(' · ')
}

export function summarizeRouterMatches(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.matches)) return null
  const matches = result.matches.filter(isRecord)
  const lines = [`${matches.length} match${matches.length === 1 ? '' : 'es'}`]
  for (const match of matches) {
    const parts = [
      `  ${String(match.routeId)} ${JSON.stringify(String(match.pathname))} ${String(match.status)}`,
    ]
    if (match.isFetching === true || (typeof match.isFetching === 'string' && match.isFetching))
      parts.push('· fetching')
    if (isRecord(match.params) && Object.keys(match.params).length > 0)
      parts.push(`· params ${recordPreview(match.params)}`)
    lines.push(parts.join(' '))
  }
  return lines.join('\n')
}

/** Key/value preview for dehydrated records: primitives inline, everything else by key — bounded, never a dump. */
function recordPreview(value: unknown): string {
  if (!isRecord(value)) return value === undefined ? '(none)' : JSON.stringify(value)
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

function keyPreview(key: unknown, hash: unknown): string {
  const raw = key !== undefined ? JSON.stringify(key) : String(hash)
  if (!raw) return '(unknown key)'
  return raw.length > 48 ? `${raw.slice(0, 48)}…` : raw
}

const prettyJson = (result: unknown): string => JSON.stringify(result, null, 2)
const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
const round = (value: number): number => Math.round(value * 10) / 10

export async function runCall(
  tool: string | undefined,
  argsJson: string | undefined,
  opts: AgentOptions = {},
): Promise<number> {
  if (!tool) {
    err("usage: genie call <tool> '<json-args>'")
    return 1
  }
  let args: unknown = {}
  if (argsJson) {
    try {
      args = JSON.parse(argsJson)
    } catch {
      err(`invalid JSON args: ${argsJson}`)
      return 1
    }
  }

  const { link } = await connect(opts)
  try {
    if (tool !== 'devtools_status') {
      // Bridge-global wait (sessionId: null) so a stale --session fails fast on the real call instead of stalling here.
      const ready = await link
        .invoke(
          devtoolsWaitContract,
          { condition: 'connected', timeoutMs: opts.waitMs ?? 15_000 },
          null,
        )
        .catch(() => null)
      if (!ready?.ok) {
        err(
          'no app connected — start your dev server (Vite: genie() plugin; Next.js/other: genie hub) and open the app in a browser',
        )
        return 1
      }
    }
    const result = await link.invoke(tool, args)
    out(renderResult(tool, result, opts.json))
    return 0
  } catch (error) {
    err(`genie call ${tool}: ${errorMessage(error)}`)
    return 1
  } finally {
    link.close()
  }
}

export async function runStatus(opts: AgentOptions = {}): Promise<number> {
  const { link, url } = await connect(opts)
  try {
    const status = await link.invoke(devtoolsStatusContract, {})
    // A 0.1.0 bridge predates the `sessions` field; the typed contract can't see that skew.
    const sessions = Array.isArray(status.sessions) ? status.sessions : []
    // Preamble on stderr so stdout stays pure (parseable) — important for `--json` and piping.
    err(`bridge: ${url}`)
    err(`run from any dir: genie --url ${url} call react_get_renders '{"sort":"unnecessary"}'`)
    if (sessions.length > 1)
      err(
        `${sessions.length} sessions connected — calls hit the most recent; target one with --session <id>`,
      )
    err('')
    out(renderResult('devtools_status', status, opts.json))
    return 0
  } catch (error) {
    err(`genie status: ${errorMessage(error)}`)
    return 1
  } finally {
    link.close()
  }
}

export async function runTools(
  selector: string | undefined,
  opts: AgentOptions = {},
): Promise<number> {
  const { link } = await connect(opts)
  try {
    const pinned = resolveSession(opts.session)
    // The broadcast status only carries the current session's catalog; a pinned session must ask the bridge for its own.
    const status = pinned
      ? await link.invoke(devtoolsStatusContract, {})
      : await waitForTools(link, opts.waitMs ?? 12_000)
    const tools = status?.tools ?? []
    if (!status || tools.length === 0) {
      err('no tools advertised — start your dev server and open the app in a browser')
      return 1
    }

    if (selector) {
      const selection = resolveToolsSelector(tools, selector)
      switch (selection.kind) {
        case 'tool':
          out(opts.json ? JSON.stringify(selection.tool) : formatToolDetail(selection.tool))
          return 0
        case 'group':
          out(
            opts.json
              ? JSON.stringify(selection.tools.map(slimDescriptor))
              : formatToolsListing({ app: status.app, tools: selection.tools }),
          )
          return 0
        case 'unknown':
          err(selection.message)
          return 1
      }
    }

    if (opts.all) {
      out(
        opts.json
          ? JSON.stringify({ app: status.app, tools })
          : formatToolsListing({ app: status.app, tools }),
      )
      return 0
    }
    out(
      opts.json
        ? JSON.stringify(groupIndex(status.app?.name, tools))
        : formatGroupIndex(status.app?.name, tools),
    )
    return 0
  } catch (error) {
    err(`genie tools: ${errorMessage(error)}`)
    return 1
  } finally {
    link.close()
  }
}

type ToolsSelection =
  | { kind: 'tool'; tool: ToolDescriptor }
  | { kind: 'group'; tools: ToolDescriptor[] }
  | { kind: 'unknown'; message: string }

/** Exact tool name → its full contract; exact group → that group's listing; else suggestions, never a full dump. */
export function resolveToolsSelector(tools: ToolDescriptor[], selector: string): ToolsSelection {
  const tool = tools.find((candidate) => candidate.name === selector)
  if (tool) return { kind: 'tool', tool }
  const inGroup = tools.filter((candidate) => candidate.group === selector)
  if (inGroup.length > 0) return { kind: 'group', tools: inGroup }

  const needle = selector.toLowerCase()
  const near = tools
    .map((candidate) => candidate.name)
    .filter((name) => name.includes(needle))
    .slice(0, 5)
  const groups = [...new Set(tools.map((candidate) => candidate.group))].sort()
  const hint = near.length > 0 ? `Did you mean: ${near.join(', ')}? ` : ''
  return {
    kind: 'unknown',
    message: `Unknown tool or group "${selector}". ${hint}Groups: ${groups.join(', ')}`,
  }
}

/** Layer 1 of the discovery ladder: groups + counts + a name preview, ~10× smaller than the flat catalog. */
export function formatGroupIndex(appName: string | undefined, tools: ToolDescriptor[]): string {
  const groups = groupIndex(appName, tools).groups
  const width = Math.max(0, ...groups.map((group) => group.group.length))
  const lines = [`${tools.length} tools from ${appName ?? 'the app'} · ${groups.length} groups`, '']
  for (const group of groups) {
    const preview =
      group.tools.slice(0, 3).join(', ') +
      (group.tools.length > 3 ? `, +${group.tools.length - 3} more` : '')
    lines.push(`  ${group.group.padEnd(width)} ${String(group.count).padStart(2)} — ${preview}`)
  }
  lines.push(
    '',
    'drill in: genie tools <group> · one tool: genie tools <tool> · everything: genie tools --all',
  )
  return lines.join('\n')
}

function groupIndex(
  appName: string | undefined,
  tools: ToolDescriptor[],
): {
  app: string | null
  total: number
  groups: Array<{ group: string; count: number; tools: string[] }>
} {
  const byGroup = new Map<string, string[]>()
  for (const tool of tools) {
    const list = byGroup.get(tool.group) ?? []
    list.push(tool.name)
    byGroup.set(tool.group, list)
  }
  return {
    app: appName ?? null,
    total: tools.length,
    groups: [...byGroup]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, names]) => ({ group, count: names.length, tools: names })),
  }
}

/** Layer 3: one tool's full contract — the long description lives here instead of in a 100KB catalog dump. */
export function formatToolDetail(tool: ToolDescriptor): string {
  const lines = [
    `${tool.name} — ${tool.title} [${tool.group}]`,
    '',
    tool.description,
    '',
    'params:',
  ]
  const object = objectSchema(tool.inputJsonSchema)
  const properties = object && isRecord(object.properties) ? object.properties : {}
  const required = new Set(Array.isArray(object?.required) ? object.required : [])
  const names = Object.keys(properties)
  if (names.length === 0) lines.push('  (none)')
  for (const name of names) {
    const property = properties[name]
    const parts = [`  ${name}${required.has(name) ? '' : '?'}: ${jsonSchemaType(property)}`]
    if (isRecord(property)) {
      if (property.default !== undefined)
        parts.push(`(default ${JSON.stringify(property.default)})`)
      if (typeof property.description === 'string') parts.push(`— ${property.description}`)
    }
    lines.push(parts.join(' '))
  }
  lines.push('', `example: genie call ${tool.name} '${exampleArgs(properties, required)}'`)
  return lines.join('\n')
}

function slimDescriptor(tool: ToolDescriptor): { name: string; title: string; params: string } {
  return { name: tool.name, title: tool.title, params: describeToolParams(tool.inputJsonSchema) }
}

function exampleArgs(properties: Record<string, unknown>, required: Set<unknown>): string {
  const example: Record<string, unknown> = {}
  for (const name of Object.keys(properties)) {
    if (required.has(name)) example[name] = examplePropValue(properties[name], name)
  }
  return JSON.stringify(example)
}

function examplePropValue(schema: unknown, name: string): unknown {
  if (isRecord(schema)) {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
    if (schema.default !== undefined) return schema.default
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
    if (type === 'number' || type === 'integer') return 1
    if (type === 'boolean') return true
    if (type === 'array') return []
    if (type === 'object') return {}
  }
  return `<${name}>`
}

type ToolDescriptor = BridgeStatusMessage['tools'][number]

/** Renders the catalog grouped by domain, params derived from each tool's advertised input schema (`?` marks optional). */
export function formatToolsListing(status: {
  app?: { name?: string } | null
  tools: ToolDescriptor[]
}): string {
  const lines: string[] = [`${status.tools.length} tools from ${status.app?.name ?? 'the app'}:`]
  const groups = new Map<string, ToolDescriptor[]>()
  for (const tool of status.tools) {
    const list = groups.get(tool.group) ?? []
    list.push(tool)
    groups.set(tool.group, list)
  }
  for (const [group, tools] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('', `  ${group}`)
    for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(
        `    ${tool.name} — ${tool.title}`,
        `      ${describeToolParams(tool.inputJsonSchema)}`,
      )
    }
  }
  return lines.join('\n')
}

function describeToolParams(schema: unknown): string {
  const object = objectSchema(schema)
  const properties = object && isRecord(object.properties) ? object.properties : {}
  const names = Object.keys(properties)
  if (names.length === 0) return '(no args)'
  const required = new Set(Array.isArray(object?.required) ? object.required : [])
  return names
    .map((name) => `${name}${required.has(name) ? '' : '?'}: ${jsonSchemaType(properties[name])}`)
    .join(', ')
}

/** Finds the object node carrying `properties`, unwrapping the `allOf` a refined schema emits. */
function objectSchema(schema: unknown): Record<string, unknown> | null {
  if (!isRecord(schema)) return null
  if (isRecord(schema.properties)) return schema
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      const found = objectSchema(part)
      if (found) return found
    }
  }
  return null
}

function jsonSchemaType(schema: unknown): string {
  if (!isRecord(schema)) return 'any'
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  if (Array.isArray(schema.anyOf)) return [...new Set(schema.anyOf.map(jsonSchemaType))].join(' | ')
  if (typeof schema.type === 'string') return schema.type
  if (Array.isArray(schema.type)) return schema.type.join(' | ')
  return 'any'
}

function waitForTools(
  link: GenieAgentLink,
  timeoutMs: number,
): Promise<BridgeStatusMessage | null> {
  const current = link.getStatus()
  if (current && current.tools.length > 0) return Promise.resolve(current)
  return new Promise((resolveStatus) => {
    const timer = setTimeout(() => {
      link.onStatus = null
      resolveStatus(link.getStatus())
    }, timeoutMs)
    link.onStatus = (status) => {
      if (status.tools.length > 0) {
        clearTimeout(timer)
        link.onStatus = null
        resolveStatus(status)
      }
    }
    // Nudge the bridge to surface a connected app (and rebroadcast its catalog).
    void link.invoke(devtoolsWaitContract, { condition: 'connected', timeoutMs }).catch(() => {})
  })
}
