import {
  type BridgeStatusMessage,
  devtoolsStatusContract,
  devtoolsWaitContract,
  errorMessage,
} from '@genie-react/core'
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
  /** Print raw pretty JSON instead of the compact per-tool summary. */
  json?: boolean
  /** Target a specific app session when several tabs are connected (see `genie status`). */
  session?: string
}

const out = (message: string): void => void process.stdout.write(`${message}\n`)
const err = (message: string): void => void process.stderr.write(`${message}\n`)

async function connect(opts: AgentOptions): Promise<{ link: GenieAgentLink; url: string }> {
  const url = opts.url ?? (await resolveBridgeUrl(opts.cwd ?? process.cwd()))
  const link = new GenieAgentLink({
    url,
    connectTimeoutMs: 8_000,
    invokeTimeoutMs: 20_000,
    sessionId: opts.session,
  })
  link.start()
  return { link, url }
}

const summarizers: Record<string, (result: unknown) => string | null> = {
  react_get_renders: summarizeRenders,
  react_effect_audit: summarizeEffects,
  react_get_tree: summarizeTree,
  react_dom_for_component: summarizeDom,
}

/** Falls back to pretty JSON on any miss (`json` set, no summarizer, rejected shape) so compact mode never drops data. */
export function renderResult(tool: string, result: unknown, json?: boolean): string {
  if (json) return prettyJson(result)
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
        err('no app connected — start your dev server (with the genie() plugin) and open the app')
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

export async function runTools(opts: AgentOptions = {}): Promise<number> {
  const { link } = await connect(opts)
  try {
    const status = await waitForTools(link, opts.waitMs ?? 12_000)
    if (!status || status.tools.length === 0) {
      err('no tools advertised — start your dev server and open the app in a browser')
      return 1
    }
    if (opts.session)
      err(
        'note: the catalog shown is the current session’s; sessions of the same app advertise the same tools',
      )
    out(formatToolsListing(status))
    return 0
  } catch (error) {
    err(`genie tools: ${errorMessage(error)}`)
    return 1
  } finally {
    link.close()
  }
}

type ToolDescriptor = BridgeStatusMessage['tools'][number]

/** Renders the catalog grouped by domain, params derived from each tool's advertised input schema (`?` marks optional). */
export function formatToolsListing(status: BridgeStatusMessage): string {
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
