import { access, link as linkFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyCaptureIntegrity } from 'genie-react/hub'
import {
  type BridgeStatusMessage,
  type CaptureDomain,
  captureArtifactSchema,
  devtoolsCaptureCompareContract,
  devtoolsCaptureListContract,
  devtoolsCapturePinContract,
  devtoolsCaptureReadContract,
  devtoolsStatusContract,
  devtoolsWaitContract,
  errorMessage,
} from 'genie-react/protocol'
import { BridgeCallError, GenieAgentLink, INVOKE_GRACE_MS } from './agent-link'
import {
  summarizeCapture,
  summarizeCaptureComparison,
  summarizeCaptureList,
} from './capture-output'
import { normalizeBridgeUrl, resolveBridge } from './discovery'
import { isRecord, isRecordArray } from './guards'
import { setOutputContext } from './output-safety'
import { reactSummarizers } from './react-output'
import {
  ResultSelectionError,
  renderBoundedJson,
  renderBoundedText,
  selectResult,
} from './result-selection'
import { summarizeSessionsOnly, summarizeStatus } from './session-output'
import {
  formatGroupIndex,
  formatToolDetail,
  formatToolsListing,
  groupIndex,
  relatedActions,
  resolveToolsSelector,
  slimDescriptor,
} from './tool-output'

export {
  summarizeCapture,
  summarizeCaptureComparison,
  summarizeCaptureList,
} from './capture-output'
export * from './react-output'
export { summarizeSessionsOnly, summarizeStatus } from './session-output'
export {
  formatGroupIndex,
  formatToolDetail,
  formatToolsListing,
  relatedActions,
  resolveToolsSelector,
} from './tool-output'

// The CLI's tool-calling surface: connects to the bridge as the `agent` role — straight from a shell, no separate server.

export interface AgentOptions {
  cwd?: string
  /** Override the bridge URL (else resolved from GENIE_BRIDGE_URL → .genie/bridge.json → default). */
  url?: string
  /** How long to wait for the bridge WebSocket itself to open, in ms. */
  connectTimeoutMs?: number
  /** How long to wait for an app to connect before giving up, in ms. */
  waitMs?: number
  /** Print raw JSON (compact, machine-first) instead of the per-tool summary. */
  json?: boolean
  /** Batch-only explicit JSON Lines mode; the no-flag default remains JSONL for compatibility. */
  ndjson?: boolean
  /** Target a specific app session when several tabs are connected (see `genie-react status`). */
  session?: string
  /** `genie-react tools --all`: the complete flat catalog instead of the progressive group index. */
  all?: boolean
  /** Per-call full-timeout budget (ms) forwarded to the bridge; clamped by it to [1000, 120000]. */
  timeoutMs?: number
  /** `--fields id,name,…`: project the first array-of-records to these keys as JSONL (implies machine output). */
  fields?: string[]
  /** Select nested output with JSON Pointer or a dotted wildcard path. */
  select?: string
  /** Hard byte ceiling for emitted command output, including the trailing newline. */
  maxBytes?: number
  /** Make a devtools_wait result with ok:false set a failing process status. */
  failOnResultError?: boolean
  /** Optional caller marker echoed by status machine output. */
  marker?: string
  /** Status-only projection that omits app/domain/tool metadata. */
  sessionsOnly?: boolean
  /** Print startup and connection diagnostics to stderr. */
  verbose?: boolean
  /** Resolved CLI package version, supplied by the executable for diagnostics. */
  cliVersion?: string
}

export const CLI_OUTPUT_SCHEMA_VERSION = '1.0'

type AgentFailureReason =
  | 'invalid_input'
  | 'not_connected'
  | 'operational_failure'
  | 'busy'
  | 'timeout'
  | 'not-connected'
  | 'unknown-session'
  | 'invalid-args'
  | 'tool-error'

interface AgentFailureOptions {
  userActionRequired?: boolean
  retryInMs?: number
  next?: { command: string; argv: string[] }
  correctedExample?: { tool: string; args: Record<string, unknown> }
  busyTelemetry?: BridgeCallError['busyTelemetry']
}

/** Stable, stdout-clean failure payload for --json/--fields and inherently machine-readable commands. */
export function formatAgentFailure(
  reason: AgentFailureReason,
  message: string,
  options: AgentFailureOptions = {},
): string {
  return JSON.stringify({
    schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
    status: 'error',
    reason,
    message,
    userActionRequired: options.userActionRequired ?? false,
    ...(options.retryInMs === undefined ? {} : { retryInMs: options.retryInMs }),
    ...(options.next === undefined ? {} : { next: options.next }),
    ...(options.correctedExample === undefined
      ? {}
      : { correctedExample: options.correctedExample }),
    ...(options.busyTelemetry === undefined ? {} : { busyTelemetry: options.busyTelemetry }),
  })
}

/** Priority: --session flag → GENIE_SESSION env, so a same-app agent pins its own tab once per shell instead of repeating the flag. */
export function resolveSession(explicit?: string): string | undefined {
  return explicit ?? process.env.GENIE_SESSION ?? undefined
}

const out = (message: string): void => void process.stdout.write(`${message}\n`)
const err = (message: string): void => void process.stderr.write(`${message}\n`)

const isMachineMode = (opts: AgentOptions): boolean =>
  opts.json === true ||
  opts.ndjson === true ||
  (opts.fields !== undefined && opts.fields.length > 0) ||
  opts.select !== undefined ||
  opts.maxBytes !== undefined

const BRIDGE_LOCAL_TOOLS = new Set([
  devtoolsStatusContract.name,
  devtoolsWaitContract.name,
  devtoolsCaptureListContract.name,
  devtoolsCaptureReadContract.name,
  devtoolsCaptureCompareContract.name,
  devtoolsCapturePinContract.name,
])

/** Bridge-local reads do not need a ready browser session. */
export function requiresReadySession(tool: string): boolean {
  return !BRIDGE_LOCAL_TOOLS.has(tool)
}

function emitFailure(
  opts: AgentOptions,
  reason: AgentFailureReason,
  message: string,
  options?: AgentFailureOptions,
): void {
  if (isMachineMode(opts)) {
    out(renderBoundedText(formatAgentFailure(reason, message, options), opts.maxBytes))
  } else err(message)
}

const SAFE_TOOL_NAME = /^[a-z][a-z0-9_.-]{0,127}$/

function toolHelpNext(tool: string): AgentFailureOptions['next'] | undefined {
  if (!SAFE_TOOL_NAME.test(tool)) return undefined
  return {
    command: `genie-react tools ${tool}`,
    argv: ['genie-react', 'tools', tool],
  }
}

async function connect(opts: AgentOptions): Promise<{ link: GenieAgentLink; url: string }> {
  const cwd = opts.cwd ?? process.cwd()
  let url = opts.url
  let source = 'flag'
  if (!url) {
    const bridge = await resolveBridge(cwd)
    url = bridge.url
    source = bridge.source
    if (bridge.source === 'fallback') {
      if (!isMachineMode(opts))
        err(
          `genie-react: no .genie/bridge.json found from ${cwd} upward — trying ${url}. Start your dev server (Vite: genie() plugin) or \`genie-react hub\`, or set GENIE_BRIDGE_URL.`,
        )
    }
  }
  url = normalizeBridgeUrl(url)
  const connectTimeoutMs = opts.connectTimeoutMs ?? 8_000
  if (opts.verbose) {
    err(
      `genie-react: phase=bridge target=${url} source=${source} connectTimeoutMs=${connectTimeoutMs} appWaitMs=${opts.waitMs ?? 15_000} callTimeoutMs=${opts.timeoutMs ?? 20_000} session=${resolveSession(opts.session) ?? 'current'}`,
    )
  }
  const link = new GenieAgentLink({
    url,
    connectTimeoutMs,
    // A per-call --timeout still wins per-invoke (timeoutMs + grace); this is the default when none is given.
    invokeTimeoutMs: opts.timeoutMs ? opts.timeoutMs + INVOKE_GRACE_MS : 20_000,
    sessionId: resolveSession(opts.session),
    logger: opts.verbose ? (message) => err(`genie-react: phase=bridge ${message}`) : undefined,
  })
  link.start()
  return { link, url }
}

const summarizers: Record<string, (result: unknown) => string | null> = {
  ...reactSummarizers,
  devtools_status: summarizeStatus,
  devtools_capture_create: summarizeCapture,
  devtools_capture_compare: summarizeCaptureComparison,
  devtools_capture_list: summarizeCaptureList,
  devtools_capture_read: summarizeCapture,
  browser_fps: summarizeFps,
  query_list: summarizeQueryList,
  query_get: summarizeQueryGet,
  router_get_state: summarizeRouterState,
  router_list_matches: summarizeRouterMatches,
  router_list_routes: summarizeRouterRoutes,
}

/** `--json` is machine-first (compact, parseable); the human path tries a summarizer, then a one-line flat record (small action results), then pretty JSON so nothing is ever dropped. */
export function renderResult(
  tool: string,
  result: unknown,
  json?: boolean,
  fields?: string[],
  select?: string,
  maxBytes?: number,
): string {
  if (fields && fields.length > 0) return renderBoundedText(projectFields(result, fields), maxBytes)
  const projected = select === undefined ? result : selectResult(result, select)
  if (json || select !== undefined || maxBytes !== undefined) {
    return renderBoundedJson(projected, maxBytes)
  }
  const summarize = summarizers[tool]
  const text = summarize?.(result) ?? smallResultLine(result) ?? prettyJson(result)
  return withFilteredNote(text, result)
}

/** Appends a collector's optional top-level `filteredNote` (e.g. "37 library effects hidden") so progressive-disclosure filtering is never silent; defensive against odd shapes. */
function withFilteredNote(text: string, result: unknown): string {
  if (!isRecord(result)) return text
  const note = result.filteredNote
  if (typeof note !== 'string' || note.length === 0) return text
  return `${text}\n${note}`
}

/** `--fields` output: the top-level object projected when any requested key exists on it; otherwise one JSONL row per record in the FIRST array-of-records field (key order, empty → zero rows). Deterministic — the projected source never depends on which array happens to have rows. */
export function projectFields(result: unknown, fields: string[]): string {
  if (!isRecord(result)) throw new FieldSelectionError(fields, [])
  const rows = fields.some((field) => field in result) ? [result] : firstRecordArray(result)
  if (rows?.length === 0) return ''
  const source = rows ?? [result]
  const available = [...new Set(source.flatMap((row) => Object.keys(row)))].sort()
  const unknown = fields.filter((field) => !available.includes(field))
  if (unknown.length > 0) throw new FieldSelectionError(unknown, available)
  return source.map((row) => JSON.stringify(pickFields(row, fields))).join('\n')
}

class FieldSelectionError extends Error {
  constructor(unknown: string[], available: string[]) {
    const fieldLabel = unknown.length === 1 ? 'field' : 'fields'
    const names = unknown.map((field) => JSON.stringify(field)).join(', ')
    const choices = available.length > 0 ? available.join(', ') : '(none)'
    super(`Unknown ${fieldLabel} ${names}. Available fields: ${choices}.`)
    this.name = 'FieldSelectionError'
  }
}

function firstRecordArray(result: Record<string, unknown>): Record<string, unknown>[] | null {
  for (const value of Object.values(result)) {
    if (isRecordArray(value)) return value
  }
  return null
}

/** Projects a value to the requested keys, omitting ones it doesn't have (never emits `undefined`). */
function pickFields(value: unknown, fields: string[]): Record<string, unknown> {
  const source = isRecord(value) ? value : {}
  const picked: Record<string, unknown> = {}
  for (const field of fields) {
    if (field in source) picked[field] = source[field]
  }
  return picked
}

/** One line for small all-primitive records (`ok=true · pathname="/error"`) so action results read like the summaries around them. */
function smallResultLine(result: unknown): string | null {
  if (!isRecord(result)) return null
  const keys = Object.keys(result)
  if (keys.length === 0 || keys.length > 8) return null
  const parts: string[] = []
  for (const key of keys) {
    const value = result[key]
    const primitive =
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    if (!primitive) return null
    parts.push(`${key}=${JSON.stringify(value)}`)
  }
  return parts.join(' · ')
}

export function summarizeFps(result: unknown): string | null {
  if (!isRecord(result) || typeof result.avgFps !== 'number') return null
  const parts = [
    `${String(result.verdict)} · avg ${num(result.avgFps)} fps over ${num(result.durationMs)}ms (${num(result.frames)} frames @ ${num(result.refreshRate)}Hz)`,
  ]
  if (num(result.droppedFrames) > 0) parts.push(`${num(result.droppedFrames)} dropped`)
  if (num(result.longFrames) > 0)
    parts.push(`${num(result.longFrames)} long (>50ms), worst ${round(num(result.worstFrameMs))}ms`)
  if (result.hidden === true) parts.push('! tab was hidden — unreliable')
  return parts.join(' · ')
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
  if (orphaned > 0) head.push(`· ! ${orphaned} orphaned (churn)`)
  const lines = [head.join(' ')]
  for (const query of queries) {
    const parts = [
      `  ${keyPreview(query.queryKey, query.queryHash)}`,
      String(query.status),
      query.isStale === true ? 'stale' : 'fresh',
    ]
    if (query.fetchStatus !== 'idle') parts.push(String(query.fetchStatus))
    parts.push(`${num(query.observerCount)} obs`)
    if (num(query.recentFetches) > 0) parts.push(`! ${num(query.recentFetches)} fetches/10s`)
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
  if (num(result.recentFetches) > 0) parts.push(`! ${num(result.recentFetches)}/10s`)
  if (result.hasQueryFn === false) parts.push('no queryFn')
  const lines = [parts.join(' · ')]
  if ('data' in result) lines.push(`  data: ${recordPreview(result.data)}`)
  if (typeof result.error === 'string') lines.push(`  error: ${result.error}`)
  if (Array.isArray(result.observers)) {
    const observers = result.observers.filter(isRecord)
    for (const observer of observers.slice(0, 5)) lines.push(summarizeQueryObserver(observer))
    const omitted = Math.max(0, num(result.observerCount) - Math.min(observers.length, 5))
    if (omitted > 0) lines.push(`  +${omitted} observers omitted`)
  }
  return lines.join('\n')
}

function summarizeQueryObserver(observer: Record<string, unknown>): string {
  const parts = [`  observer ${String(observer.observerId)}`, String(observer.identityStatus)]
  if (isRecord(observer.notificationPolicy)) {
    const policy = observer.notificationPolicy
    parts.push(String(policy.mode).replaceAll('-', ' '))
    if (Array.isArray(policy.fields)) {
      const fields = policy.fields.filter((field): field is string => typeof field === 'string')
      if (fields.length > 0) parts.push(`fields ${fields.slice(0, 5).join(',')}`)
    }
  }
  if (observer.deliveryEvidence === 'unavailable-private-tracking')
    parts.push('delivery unavailable (private tracking)')
  else if (observer.deliveryEvidence === 'policy-explicit') parts.push('delivery policy explicit')
  else if (observer.deliveryEvidence === 'public-track-prop-observed')
    parts.push('public tracked fields observed')
  const subscriberStatus = subscriberObservationLabel(observer.subscriberObservationStatus)
  if (subscriberStatus) parts.push(subscriberStatus)
  else if (isRecord(observer.subscriber)) parts.push('subscriber freshness unknown')
  if (isRecord(observer.subscriber)) {
    const subscriber = observer.subscriber
    parts.push(
      `subscriber ${String(subscriber.componentName)} #${num(subscriber.componentId)} hook[${num(subscriber.hookIndex)}]`,
    )
    if (typeof subscriber.subscriberId === 'string') parts.push(subscriber.subscriberId)
  }
  return parts.join(' · ')
}

function subscriberObservationLabel(value: unknown): string | null {
  if (value === 'current-observation') return 'subscriber current observation'
  if (value === 'previous-observation') return '! subscriber previous observation'
  if (value === 'no-active-observation') return 'subscriber before measurement window'
  if (value === 'not-observed') return 'subscriber not observed'
  return null
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
  if (result.locationSync === 'mismatched' && isRecord(result.browserLocation)) {
    parts.push(`! browser at ${JSON.stringify(String(result.browserLocation.pathname))}`)
  } else if (result.locationSync === 'matched') {
    parts.push('browser matched')
  }
  return parts.join(' · ')
}

export function summarizeRouterRoutes(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.routes)) return null
  const routes = result.routes.filter(isRecord)
  const lines = [`${num(result.total)} routes`]
  for (const route of routes) {
    const parts = [`  ${String(route.fullPath ?? route.routeId)}`]
    if (route.hasLoader === true) parts.push('· loader')
    if (route.hasBeforeLoad === true) parts.push('· beforeLoad')
    lines.push(parts.join(' '))
  }
  return lines.join('\n')
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

function keyPreview(key: unknown, hash: unknown): string {
  const raw = key !== undefined ? JSON.stringify(key) : String(hash)
  if (!raw) return '(unknown key)'
  return raw.length > 48 ? `${raw.slice(0, 48)}…` : raw
}

function bounded(raw: string | undefined): string {
  if (!raw) return '(none)'
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const prettyJson = (result: unknown): string => JSON.stringify(result, null, 2)
const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
const round = (value: number): number => Math.round(value * 10) / 10

export async function runCall(
  tool: string | undefined,
  argsJson: string | undefined,
  opts: AgentOptions = {},
): Promise<number> {
  setOutputContext({ operation: `call ${tool ?? '(missing tool)'}` })
  if (!tool) {
    emitFailure(
      opts,
      'invalid_input',
      'Provide a tool name. Discover tools with `genie-react tools`.',
      {
        userActionRequired: true,
        next: { command: 'genie-react tools', argv: ['genie-react', 'tools'] },
      },
    )
    return 1
  }
  let args: unknown = {}
  if (argsJson) {
    try {
      args = JSON.parse(argsJson)
    } catch {
      emitFailure(
        opts,
        'invalid_input',
        'Tool arguments must be one valid JSON object. Run `genie-react tools <tool>` for its schema.',
        { userActionRequired: true },
      )
      return 1
    }
  }

  const { link } = await connect(opts)
  try {
    if (requiresReadySession(tool)) {
      // Bridge-global wait (sessionId: null) so a stale --session fails fast on the real call instead of stalling here; its own timeout tracks --wait so a small --timeout can't truncate the connect window.
      const waitMs = opts.waitMs ?? 15_000
      const ready = await link
        .invoke(devtoolsWaitContract, { condition: 'ready', timeoutMs: waitMs }, null, {
          timeoutMs: waitMs,
        })
        .catch(() => null)
      if (!ready?.ok) {
        emitFailure(
          opts,
          'not_connected',
          'No app is connected. Start the dev server and open the app in a browser.',
          {
            userActionRequired: true,
            next: { command: 'genie-react status', argv: ['genie-react', 'status'] },
          },
        )
        return 1
      }
    }
    const result = await link.invoke(tool, args, undefined, { timeoutMs: opts.timeoutMs })
    const operationId = operationIdOf(result)
    if (operationId) setOutputContext({ operation: `call ${tool}`, operationId })
    const rendered = renderResult(tool, result, opts.json, opts.fields, opts.select, opts.maxBytes)
    if (rendered !== '') out(rendered)
    return opts.failOnResultError && tool === devtoolsWaitContract.name && waitResultFailed(result)
      ? 1
      : 0
  } catch (error) {
    const code = error instanceof BridgeCallError ? error.errorCode : undefined
    const reason: AgentFailureReason =
      error instanceof FieldSelectionError || error instanceof ResultSelectionError
        ? 'invalid_input'
        : (code ?? 'operational_failure')
    emitFailure(opts, reason, `Call to ${tool} failed${callErrorSuffix(error)}`, {
      retryInMs: error instanceof BridgeCallError ? error.retryInMs : undefined,
      busyTelemetry: error instanceof BridgeCallError ? error.busyTelemetry : undefined,
      userActionRequired:
        reason === 'invalid_input' ||
        reason === 'invalid-args' ||
        reason === 'unknown-session' ||
        reason === 'operational_failure',
      ...(reason === 'invalid-args'
        ? {
            next: toolHelpNext(tool),
            ...(tool === devtoolsWaitContract.name
              ? {
                  correctedExample: {
                    tool: devtoolsWaitContract.name,
                    args: { condition: 'ready', timeoutMs: 10_000 },
                  },
                }
              : {}),
          }
        : reason === 'unknown-session' || reason === 'operational_failure'
          ? { next: { command: 'genie-react status', argv: ['genie-react', 'status'] } }
          : {}),
    })
    return 1
  } finally {
    link.close()
  }
}

function waitResultFailed(result: unknown): boolean {
  return isRecord(result) && result.ok === false
}

export function operationIdOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  for (const field of [
    'captureId',
    'comparisonId',
    'interactionId',
    'notificationId',
    'observationId',
    'renderEventId',
    'effectEventId',
    'sessionId',
  ] as const) {
    const value = result[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

export interface CaptureExportOptions extends AgentOptions {
  output?: string
  sections?: CaptureDomain[]
  force?: boolean
}

/** Export one retained capture through a verified full read and an atomic local-file replacement. */
export async function runCaptureExport(
  captureId: string | undefined,
  opts: CaptureExportOptions = {},
): Promise<number> {
  setOutputContext({
    operation: 'capture export',
    ...(captureId ? { operationId: captureId } : {}),
  })
  if (!captureId || !opts.output) {
    emitFailure(
      opts,
      'invalid_input',
      'Provide a capture ID and --output <path>. Run `genie-react capture export --help` for an example.',
      { userActionRequired: true },
    )
    return 1
  }
  const outputPath = resolve(opts.cwd ?? process.cwd(), opts.output)
  if (!opts.force && (await pathExists(outputPath))) {
    emitFailure(
      opts,
      'invalid_input',
      `Output already exists at ${JSON.stringify(outputPath)}. Choose another path or pass --force.`,
      { userActionRequired: true },
    )
    return 1
  }

  const { link } = await connect(opts)
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`
  try {
    const result = await link.invoke(devtoolsCaptureReadContract, {
      captureId,
      view: 'full',
      ...(opts.sections === undefined ? {} : { sections: opts.sections }),
    })
    const capture = captureArtifactSchema.parse(result)
    if (!verifyCaptureIntegrity(capture)) {
      throw new Error(
        `Capture ${JSON.stringify(captureId)} failed its SHA-256 integrity check; it was not written.`,
      )
    }
    const contents = `${JSON.stringify(capture, null, 2)}\n`
    await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    if (opts.force) await rename(temporaryPath, outputPath)
    else {
      await linkFile(temporaryPath, outputPath)
      await rm(temporaryPath)
    }
    const exported = {
      captureId,
      outputPath,
      bytesWritten: Buffer.byteLength(contents, 'utf8'),
      checksum: capture.integrity?.digest ?? null,
      sections: capture.include,
    }
    out(
      renderResult('capture_export', exported, opts.json, opts.fields, opts.select, opts.maxBytes),
    )
    return 0
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    const code = error instanceof BridgeCallError ? error.errorCode : undefined
    emitFailure(
      opts,
      code ?? 'operational_failure',
      `Capture export failed: ${errorMessage(error)}`,
      {
        retryInMs: error instanceof BridgeCallError ? error.retryInMs : undefined,
        busyTelemetry: error instanceof BridgeCallError ? error.busyTelemetry : undefined,
        userActionRequired: code !== 'busy' && code !== 'timeout',
        next:
          code === 'invalid-args'
            ? {
                command: 'genie-react call devtools_capture_list {}',
                argv: ['genie-react', 'call', 'devtools_capture_list', '{}'],
              }
            : undefined,
      },
    )
    return 1
  } finally {
    link.close()
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Formats a failed call's tail: ` [<code>]: <message>` and ` — retry in <n>ms` when the bridge tagged the failure. */
function callErrorSuffix(error: unknown): string {
  const code = error instanceof BridgeCallError ? error.errorCode : undefined
  const retry =
    error instanceof BridgeCallError && typeof error.retryInMs === 'number'
      ? ` — retry in ${error.retryInMs}ms`
      : ''
  const tag = code ? ` [${code}]` : ''
  return `${tag}: ${errorMessage(error)}${retry}`
}

interface BatchItem {
  tool: string
  args: unknown
}

/** Parses a batch spec (a JSON array of `{tool, args?}`) into items, or an error string naming the first bad entry. */
export function parseBatchItems(raw: string): { items: BatchItem[] } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: 'Batch input must be a valid JSON array.' }
  }
  if (!Array.isArray(parsed))
    return { error: 'Batch input must be a JSON array of {tool, args?} objects.' }
  const items: BatchItem[] = []
  for (const [index, entry] of parsed.entries()) {
    if (!isRecord(entry) || typeof entry.tool !== 'string') {
      return { error: `Batch item ${index} must be an object with a string "tool".` }
    }
    const unknownKeys = Object.keys(entry).filter((key) => key !== 'tool' && key !== 'args')
    if (unknownKeys.length > 0) {
      const key = unknownKeys[0]
      const hint = key === 'input' ? ' Use "args" for tool arguments.' : ''
      return {
        error: `Batch item ${index} contains unknown key ${JSON.stringify(key)}.${hint}`,
      }
    }
    if (entry.tool.trim().length === 0) {
      return { error: `Batch item ${index} must have a non-empty "tool".` }
    }
    if (entry.args !== undefined && !isRecord(entry.args)) {
      return { error: `Batch item ${index} "args" must be an object when present.` }
    }
    items.push({ tool: entry.tool, args: entry.args ?? {} })
  }
  return { items }
}

interface BatchResult {
  tool: string
  ok: boolean
  status: 'ok' | 'error'
  result?: unknown
  reason?: string
  message?: string
  error?: string
  errorCode?: string
  userActionRequired?: boolean
  retryInMs?: number
  busyTelemetry?: BridgeCallError['busyTelemetry']
  next?: AgentFailureOptions['next']
}

type VersionedBatchResult = BatchResult & { schemaVersion: typeof CLI_OUTPUT_SCHEMA_VERSION }

/** `genie-react batch`: one connection, sequential calls, continue-on-error; legacy/default and --ndjson emit JSONL, while --json emits one valid array. */
export async function runBatch(
  batchJson: string | undefined,
  opts: AgentOptions = {},
): Promise<number> {
  setOutputContext({ operation: 'batch' })
  const raw = batchJson ?? (await readStdin())
  if (!raw.trim()) {
    out(
      renderBoundedText(
        formatAgentFailure('invalid_input', 'Provide a JSON array argument or pipe one on stdin.', {
          userActionRequired: true,
        }),
        opts.maxBytes,
      ),
    )
    return 1
  }
  const parsed = parseBatchItems(raw)
  if ('error' in parsed) {
    out(
      renderBoundedText(
        formatAgentFailure('invalid_input', parsed.error, { userActionRequired: true }),
        opts.maxBytes,
      ),
    )
    return 1
  }

  const { link } = await connect(opts)
  let anyFailed = false
  const results: VersionedBatchResult[] = []
  const emitBatchResult = (result: BatchResult): void => {
    const versioned: VersionedBatchResult = {
      schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
      ...result,
    }
    if (opts.json || opts.maxBytes !== undefined) results.push(versioned)
    else out(renderBoundedJson(versioned, opts.maxBytes))
  }
  try {
    const waitMs = opts.waitMs ?? 15_000
    const ready = await link
      .invoke(devtoolsWaitContract, { condition: 'ready', timeoutMs: waitMs }, null, {
        timeoutMs: waitMs,
      })
      .catch(() => null)
    if (!ready?.ok) {
      out(
        renderBoundedText(
          formatAgentFailure(
            'not_connected',
            'No app is connected. Start the dev server and open the app in a browser.',
            {
              userActionRequired: true,
              next: { command: 'genie-react status', argv: ['genie-react', 'status'] },
            },
          ),
          opts.maxBytes,
        ),
      )
      return 1
    }
    for (const item of parsed.items) {
      setOutputContext({ operation: `batch ${item.tool}` })
      try {
        const result = await link.invoke(item.tool, item.args, undefined, {
          timeoutMs: opts.timeoutMs,
        })
        const operationId = operationIdOf(result)
        setOutputContext({
          operation: `batch ${item.tool}`,
          ...(operationId ? { operationId } : {}),
        })
        const projected = opts.select === undefined ? result : selectResult(result, opts.select)
        emitBatchResult({ tool: item.tool, ok: true, status: 'ok', result: projected })
      } catch (error) {
        anyFailed = true
        const errorCode = error instanceof BridgeCallError ? error.errorCode : undefined
        const userActionRequired =
          error instanceof ResultSelectionError ||
          errorCode === 'invalid-args' ||
          errorCode === 'unknown-session' ||
          errorCode === 'not-connected'
        emitBatchResult({
          tool: item.tool,
          ok: false,
          status: 'error',
          reason:
            error instanceof ResultSelectionError
              ? 'invalid_input'
              : (errorCode ?? 'operational_failure'),
          message: errorMessage(error),
          error: errorMessage(error),
          ...(errorCode ? { errorCode } : {}),
          userActionRequired,
          ...(error instanceof BridgeCallError && error.retryInMs !== undefined
            ? { retryInMs: error.retryInMs }
            : {}),
          ...(error instanceof BridgeCallError && error.busyTelemetry !== undefined
            ? { busyTelemetry: error.busyTelemetry }
            : {}),
          ...(errorCode === 'invalid-args'
            ? { next: toolHelpNext(item.tool) }
            : errorCode === 'unknown-session' || errorCode === 'not-connected'
              ? { next: { command: 'genie-react status', argv: ['genie-react', 'status'] } }
              : {}),
        })
      }
    }
    if (opts.json) out(renderBoundedJson(results, opts.maxBytes))
    else if (opts.maxBytes !== undefined) {
      out(
        renderBoundedText(
          results.map((result) => JSON.stringify(result)).join('\n'),
          opts.maxBytes,
        ),
      )
    }
    return anyFailed ? 1 : 0
  } finally {
    link.close()
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', () => resolve(data))
  })
}

export async function runStatus(opts: AgentOptions = {}): Promise<number> {
  setOutputContext({ operation: 'status' })
  const { link, url } = await connect(opts)
  try {
    const status = await link.invoke(devtoolsStatusContract, { includeTools: false })
    // A 0.1.0 bridge predates the `sessions` field; the typed contract can't see that skew.
    const sessions = Array.isArray(status.sessions) ? status.sessions : []
    // Preamble on stderr so stdout stays pure (parseable) — important for `--json` and piping.
    if (!isMachineMode(opts)) {
      err(`bridge: ${url}`)
      err(
        `run from any dir: genie-react --url ${shellQuote(url)} call react_get_renders '{"sort":"selfTime"}'`,
      )
      if (sessions.length > 1 && resolveSession(opts.session) === undefined)
        err(
          `${sessions.length} sessions connected — calls hit the most recent; target one with --session <id>`,
        )
      err('')
    }
    const selectorSource = opts.session
      ? 'flag'
      : process.env.GENIE_SESSION
        ? 'environment'
        : 'implicit-current'
    const statusMetadata = {
      selectedBridgeUrl: url,
      sessionSelector: {
        requested: resolveSession(opts.session) ?? null,
        source: selectorSource,
        resolvedSessionId: status.sessionId,
        implicit: resolveSession(opts.session) === undefined,
      },
      ...(opts.marker === undefined ? {} : { marker: opts.marker }),
    }
    const result = opts.sessionsOnly
      ? {
          schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
          ...statusMetadata,
          connected: status.connected,
          ready: status.ready,
          sessionId: status.sessionId,
          sessions: sessions.map((session) => ({
            sessionId: session.sessionId,
            ...(session.logicalSessionId === undefined
              ? {}
              : { logicalSessionId: session.logicalSessionId }),
            ...(session.documentGeneration === undefined
              ? {}
              : { documentGeneration: session.documentGeneration }),
            ...(session.sessionName === undefined ? {} : { sessionName: session.sessionName }),
            ...(session.predecessorSessionId === undefined
              ? {}
              : { predecessorSessionId: session.predecessorSessionId }),
            ...(session.successorSessionId === undefined
              ? {}
              : { successorSessionId: session.successorSessionId }),
            logicalSessionCollision: session.logicalSessionCollision,
            collisionWithSessionIds: session.collisionWithSessionIds,
            ...(session.forkedFromLogicalSessionId === undefined
              ? {}
              : { forkedFromLogicalSessionId: session.forkedFromLogicalSessionId }),
            connectedAt: session.connectedAt,
            ready: session.ready,
            ...(session.readyAt === undefined ? {} : { readyAt: session.readyAt }),
            current: session.current,
            ...(session.staleMs === undefined ? {} : { staleMs: session.staleMs }),
          })),
          warnings: status.warnings,
        }
      : { schemaVersion: CLI_OUTPUT_SCHEMA_VERSION, ...statusMetadata, ...status }
    const targetSessionId =
      resolveSession(opts.session) === undefined ? undefined : (status.sessionId ?? undefined)
    out(
      opts.sessionsOnly && !isMachineMode(opts)
        ? summarizeSessionsOnly(result, { targetSessionId })
        : !isMachineMode(opts) && targetSessionId
          ? (summarizeStatus(result, { targetSessionId }) ?? prettyJson(result))
          : renderResult(
              'devtools_status',
              result,
              opts.json,
              opts.fields,
              opts.select,
              opts.maxBytes,
            ),
    )
    return 0
  } catch (error) {
    emitFailure(opts, 'operational_failure', `Status check failed: ${errorMessage(error)}`, {
      userActionRequired: true,
      next: {
        command: 'genie-react doctor --live',
        argv: ['genie-react', 'doctor', '--live'],
      },
    })
    return 1
  } finally {
    link.close()
  }
}

export async function runTools(
  selector: string | undefined,
  opts: AgentOptions = {},
): Promise<number> {
  setOutputContext({ operation: 'tools' })
  const { link } = await connect(opts)
  try {
    const pinned = resolveSession(opts.session)
    // The broadcast status only carries the current session's catalog; a pinned session must ask the bridge for its own.
    const status = pinned
      ? await link.invoke(devtoolsStatusContract, { includeTools: true })
      : await waitForTools(link, opts.waitMs ?? 12_000)
    const tools = status?.tools ?? []
    if (!status || tools.length === 0) {
      emitFailure(
        opts,
        'not_connected',
        'No tools are advertised. Start the dev server and open the app in a browser.',
        {
          userActionRequired: true,
          next: { command: 'genie-react status', argv: ['genie-react', 'status'] },
        },
      )
      return 1
    }

    if (selector) {
      const selection = resolveToolsSelector(tools, selector)
      switch (selection.kind) {
        case 'tool':
          emitToolsResult(opts, selection.tool, formatToolDetail(selection.tool))
          return 0
        case 'group': {
          const value = selection.tools.map(slimDescriptor)
          const listing = formatToolsListing({ app: status.app, tools: selection.tools })
          const actions = relatedActions(tools, selector)
          const human =
            actions.length > 0
              ? `${listing}\n\nmutations for this domain live in "action": ${actions.join(', ')} — details: genie-react tools <tool>`
              : listing
          emitToolsResult(opts, value, human)
          return 0
        }
        case 'unknown':
          emitFailure(opts, 'invalid_input', selection.message, {
            userActionRequired: true,
            next: { command: 'genie-react tools', argv: ['genie-react', 'tools'] },
          })
          return 1
      }
    }

    if (opts.all) {
      emitToolsResult(
        opts,
        { app: status.app, tools },
        formatToolsListing({ app: status.app, tools }),
      )
      return 0
    }
    const index = groupIndex(status.app?.name, tools)
    emitToolsResult(opts, index, formatGroupIndex(status.app?.name, tools))
    return 0
  } catch (error) {
    emitFailure(
      opts,
      error instanceof ResultSelectionError ? 'invalid_input' : 'operational_failure',
      `Tool discovery failed: ${errorMessage(error)}`,
      {
        userActionRequired: true,
        next: { command: 'genie-react status', argv: ['genie-react', 'status'] },
      },
    )
    return 1
  } finally {
    link.close()
  }
}

function emitToolsResult(opts: AgentOptions, value: unknown, human: string): void {
  if (opts.select !== undefined || opts.maxBytes !== undefined) {
    const selected = opts.select === undefined ? value : selectResult(value, opts.select)
    out(renderBoundedJson(selected, opts.maxBytes))
    return
  }
  out(opts.json ? JSON.stringify(value) : human)
}

function waitForTools(
  link: GenieAgentLink,
  timeoutMs: number,
): Promise<BridgeStatusMessage | null> {
  const current = link.getStatus()
  if (current?.ready && current.tools.length > 0) return Promise.resolve(current)
  return new Promise((resolveStatus) => {
    const timer = setTimeout(() => {
      link.onStatus = null
      resolveStatus(link.getStatus())
    }, timeoutMs)
    link.onStatus = (status) => {
      if (status.ready && status.tools.length > 0) {
        clearTimeout(timer)
        link.onStatus = null
        resolveStatus(status)
      }
    }
    // Nudge the bridge to surface a connected app (and rebroadcast its catalog).
    void link.invoke(devtoolsWaitContract, { condition: 'ready', timeoutMs }).catch(() => {})
  })
}
