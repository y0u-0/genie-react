import { z } from 'zod'
import {
  type AgentToolContract,
  type AppBoundMessage,
  type AppInfo,
  decodeAppBoundMessage,
  encodeMessage,
  errorMessage,
  formatToolValidationError,
  GENIE_PROTOCOL_VERSION,
  GENIE_WS_PATH,
  newId,
  type ToolDescriptor,
} from '../protocol'
import type { CollectorContext, ErasedCollectorTool, GenieCollector } from './collector'
import {
  forkSessionIdentity,
  runtimeSessionIdentity,
  runtimeSessionName,
  type SessionIdentity,
} from './session-identity'

export interface SocketLike {
  send(data: string): void
  close(): void
  readyState: number
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type SocketFactory = (url: string) => SocketLike

export interface GenieClientOptions {
  url?: string
  appName?: string
  collectors: GenieCollector[]
  socketFactory?: SocketFactory
  reconnectDelayMs?: number
  /** Human-readable tab marker shown in status; defaults to the initial `_genie` URL parameter. */
  sessionName?: string
  /** Advanced override for non-browser hosts that manage their own document lineage. */
  sessionIdentity?: SessionIdentity
}

const SOCKET_OPEN = 1
const HEARTBEAT_INTERVAL_MS = 1_000

export class GenieClient {
  private readonly url: string
  private readonly appName: string | undefined
  private readonly socketFactory: SocketFactory
  private readonly reconnectDelayMs: number
  private readonly sessionId = newId()
  private readonly sessionIdentity: SessionIdentity
  private readonly sessionName: string | undefined
  private readonly documentName: string | undefined
  private readonly collectors: GenieCollector[] = []
  private readonly tools = new Map<string, ErasedCollectorTool>()
  private readonly cleanups = new Map<string, () => void>()
  private socket: SocketLike | null = null
  private started = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatFrame: string | null = null
  private lastHeartbeatSentAt = 0

  constructor(options: GenieClientOptions) {
    this.url = options.url ?? defaultBridgeUrl()
    this.appName = options.appName
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000
    this.sessionIdentity = options.sessionIdentity ?? runtimeSessionIdentity()
    this.sessionName = runtimeSessionName(options.sessionName ?? initialSessionName())
    this.documentName = initialDocumentName()
    this.collectors.push(...options.collectors)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.exposeGlobal()
    this.connect()
  }

  stop(): void {
    this.started = false
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopHeartbeat()
    for (const cleanup of this.cleanups.values()) cleanup()
    this.cleanups.clear()
    const socket = this.socket
    this.socket = null
    if (socket) {
      this.clearSocketHandlers(socket)
      socket.close()
    }
  }

  registerCollector(collector: GenieCollector): void {
    const collectorId = collector.meta.id
    const existingIndex = this.collectors.findIndex((current) => current.meta.id === collectorId)
    if (existingIndex >= 0) {
      if (this.collectors[existingIndex] === collector) return
      this.cleanups.get(collectorId)?.()
      this.cleanups.delete(collectorId)
      this.collectors[existingIndex] = collector
    } else {
      this.collectors.push(collector)
    }

    if (this.socket?.readyState === SOCKET_OPEN) {
      this.rebuildCollectorTools()
      this.sendHello()
      this.runCollectorStart(collector)
    }
  }

  private connect(): void {
    const socket = this.socketFactory(`${this.url}?role=app`)
    this.socket = socket
    socket.onopen = () => {
      if (this.socket === socket) this.onOpen()
    }
    socket.onmessage = (event) => {
      if (this.socket === socket) this.onMessage(String(event.data))
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.clearSocketHandlers(socket)
      this.socket = null
      this.stopHeartbeat()
      if (this.started) this.scheduleReconnect()
    }
    socket.onerror = () => {}
  }

  private clearSocketHandlers(socket: SocketLike): void {
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.started) this.connect()
    }, this.reconnectDelayMs)
  }

  private onOpen(): void {
    this.rebuildCollectorTools()
    // Hello must precede collector start() so the bridge doesn't drop snapshots pushed before the session registers.
    this.sendHello()
    for (const collector of this.collectors) this.runCollectorStart(collector)
    this.send({ kind: 'app/ready', sessionId: this.sessionId })
    this.startHeartbeat()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastHeartbeatSentAt = 0
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS)
    // Node-only guard so the interval never keeps a test process (or an SSR host) alive.
    if (
      typeof this.heartbeatTimer === 'object' &&
      this.heartbeatTimer &&
      'unref' in this.heartbeatTimer
    )
      this.heartbeatTimer.unref()
  }

  // Sends at most one heartbeat per interval whether the timer or a commit triggered it: the interval covers idle apps; commit-driven sends keep a saturated thread alive when the macrotask timer is starved.
  private sendHeartbeat(): void {
    if (this.socket?.readyState !== SOCKET_OPEN) return
    const now = Date.now()
    if (now - this.lastHeartbeatSentAt < HEARTBEAT_INTERVAL_MS) return
    // The frame is constant for the session; encode once.
    this.heartbeatFrame ??= encodeMessage({ kind: 'app/heartbeat', sessionId: this.sessionId })
    this.socket.send(this.heartbeatFrame)
    this.lastHeartbeatSentAt = now
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private registerCollectorTools(collector: GenieCollector): void {
    for (const tool of collector.tools ?? []) this.tools.set(tool.contract.name, tool)
  }

  private rebuildCollectorTools(): void {
    this.tools.clear()
    for (const collector of this.collectors) this.registerCollectorTools(collector)
  }

  private runCollectorStart(collector: GenieCollector): void {
    if (collector.start && !this.cleanups.has(collector.meta.id)) {
      const cleanup = collector.start(this.context())
      if (cleanup) this.cleanups.set(collector.meta.id, cleanup)
    }
  }

  private context(): CollectorContext {
    return {
      pushSnapshot: (domain, data) =>
        this.send({ kind: 'app/snapshot', domain, data, ts: Date.now() }),
      pushEvent: (domain, event) => this.send({ kind: 'app/event', domain, event, ts: Date.now() }),
      refreshTools: () => {
        this.rebuildCollectorTools()
        this.sendHello()
      },
      markActivity: () => this.sendHeartbeat(),
    }
  }

  private sendHello(): void {
    this.send({
      kind: 'app/hello',
      protocol: GENIE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      logicalSessionId: this.sessionIdentity.logicalSessionId,
      documentGeneration: this.sessionIdentity.documentGeneration,
      sessionName: this.sessionName,
      app: this.appInfo(),
      capabilities: this.capabilities(),
      tools: this.descriptors(),
    })
  }

  private appInfo(): AppInfo {
    const info: AppInfo = {}
    for (const collector of this.collectors) Object.assign(info, collector.appInfo?.() ?? {})
    if (this.appName) info.name = this.appName
    if (!info.name && this.documentName) info.name = this.documentName
    if (!info.url && typeof location !== 'undefined') info.url = location.href
    return info
  }

  private capabilities(): string[] {
    const capabilities = new Set<string>()
    for (const collector of this.collectors) {
      for (const capability of collector.capabilities ?? []) capabilities.add(capability)
    }
    return [...capabilities]
  }

  private descriptors(): ToolDescriptor[] {
    return [...this.tools.values()].map(toDescriptor)
  }

  private onMessage(raw: string): void {
    let message: AppBoundMessage
    try {
      message = decodeAppBoundMessage(raw)
    } catch {
      return
    }
    if (message.kind === 'bridge/request') {
      void this.handleRequest(message.id, message.tool, message.args)
      return
    }
    if (
      message.kind === 'bridge/session-fork' &&
      message.expectedLogicalSessionId === this.sessionIdentity.logicalSessionId
    ) {
      forkSessionIdentity(
        this.sessionIdentity,
        message.logicalSessionId,
        message.documentGeneration,
      )
      this.sendHello()
      this.send({ kind: 'app/ready', sessionId: this.sessionId })
    }
  }

  private async handleRequest(id: string, toolName: string, rawArgs: unknown): Promise<void> {
    const tool = this.tools.get(toolName)
    if (!tool) {
      this.send({
        kind: 'app/response',
        id,
        ok: false,
        error: this.unknownToolError(toolName),
        errorCode: 'tool-error',
      })
      return
    }
    const availability = tool.availability?.()
    if (availability && !availability.available) {
      this.send({
        kind: 'app/response',
        id,
        ok: false,
        error: `Tool "${toolName}" is currently unavailable — ${availability.reason}`,
        errorCode: 'tool-unavailable',
      })
      return
    }
    const args = remapNameAlias(tool.contract.input, rawArgs)
    const rejectedKeys = unknownArgKeysError(toolName, tool.contract.input, args)
    if (rejectedKeys) {
      this.send({
        kind: 'app/response',
        id,
        ok: false,
        error: rejectedKeys,
        errorCode: 'invalid-args',
      })
      return
    }
    try {
      const parsed = tool.contract.input.parse(args ?? {}) as never
      const result = await tool.handler(parsed, this.context())
      warnOnOutputDrift(tool.contract, result)
      this.send({ kind: 'app/response', id, ok: true, result })
    } catch (error) {
      this.send({
        kind: 'app/response',
        id,
        ok: false,
        error: invocationError(toolName, error),
        errorCode: isZodErrorLike(error) ? 'invalid-args' : 'tool-error',
      })
    }
  }

  private unknownToolError(toolName: string): string {
    const domains = this.capabilities().sort().join(', ') || 'none'
    const hint =
      DOMAIN_GATING_HINTS[toolName.split('_')[0] ?? ''] ??
      'call devtools_status for the live catalog (CLI: `genie-react tools`)'
    return `Unknown tool "${toolName}" — this app advertises: ${domains}. Note: ${hint}.`
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === SOCKET_OPEN) this.socket.send(encodeMessage(message))
  }

  private exposeGlobal(): void {
    // Core publishes collectors as `unknown`; discoverers are trusted, so this is the one narrowing seam.
    globalThis.__GENIE_REACT_AGENT__ = {
      register: (collector) => this.registerCollector(collector as GenieCollector),
    }
  }
}

function initialSessionName(): string | undefined {
  try {
    if (typeof location === 'undefined') return undefined
    const name = new URL(location.href).searchParams.get('_genie')?.trim()
    return name || undefined
  } catch {
    return undefined
  }
}

function initialDocumentName(): string | undefined {
  const name = typeof document === 'undefined' ? '' : document.title.trim()
  return name || undefined
}

export function createGenieClient(options: GenieClientOptions): GenieClient {
  return new GenieClient(options)
}

// Progressive discovery means these domains are absent-by-design on apps without the matching TanStack instance; say so instead of a bare "unknown".
const DOMAIN_GATING_HINTS: Record<string, string> = {
  query:
    'query tools appear only when a QueryClient is discovered (render <Genie /> or register queryCollector(queryClient))',
  mutation:
    'mutation tools appear only when a QueryClient is discovered (render <Genie /> or register queryCollector(queryClient))',
  router:
    'router tools appear only when a TanStack Router is discovered (render <Genie /> or register routerCollector(router))',
  app: 'app tools are registered by the application itself (useGenieTool / registerGenieTools) and exist only once that code runs',
}

// Three historical spellings of "component name" across the react tools; agents mix them up constantly.
const NAME_ALIASES = ['component', 'query', 'name'] as const

/** Keys of an object schema's shape; duck-typed via the zod 4 `_zod.def` protocol so app-tool schemas from a foreign zod copy still qualify. */
function objectShapeKeys(input: AgentToolContract['input']): string[] | null {
  if (input instanceof z.ZodObject) return Object.keys(input.shape)
  const def = (input as { _zod?: { def?: { type?: string; shape?: Record<string, unknown> } } })
    ._zod?.def
  if (def?.type === 'object' && typeof def.shape === 'object' && def.shape !== null) {
    return Object.keys(def.shape)
  }
  return null
}

/** `instanceof z.ZodError` fails across zod copies (app-provided schemas); duck-type the issues array with an exact class name so business errors can't spoof validation formatting. */
function isZodErrorLike(error: unknown): error is z.ZodError {
  if (error instanceof z.ZodError) return true
  return (
    error instanceof Error &&
    (error.name === 'ZodError' || error.name === '$ZodError') &&
    'issues' in error &&
    Array.isArray((error as { issues: unknown }).issues)
  )
}

/** Remaps an off-by-spelling name arg when the schema wants exactly one of the aliases and the caller sent exactly one other — unambiguous, so just accept it. */
function remapNameAlias(input: AgentToolContract['input'], args: unknown): unknown {
  const shape = objectShapeKeys(input)
  if (!shape || typeof args !== 'object' || args === null) return args
  const wanted = NAME_ALIASES.filter((alias) => shape.includes(alias))
  if (wanted.length !== 1) return args
  const target = wanted[0] as string
  const record = args as Record<string, unknown>
  if (target in record) return args
  const given = NAME_ALIASES.filter((alias) => alias !== target && alias in record)
  if (given.length !== 1) return args
  const source = given[0] as string
  const { [source]: value, ...rest } = record
  return { ...rest, [target]: value }
}

/** Zod objects strip unrecognized keys silently — an agent typo like `maxDepth` for `depth` would otherwise no-op; reject it loudly instead. */
function unknownArgKeysError(
  toolName: string,
  input: AgentToolContract['input'],
  args: unknown,
): string | null {
  const known = objectShapeKeys(input)
  if (!known || typeof args !== 'object' || args === null) return null
  const unknown = Object.keys(args).filter((key) => !known.includes(key))
  if (unknown.length === 0) return null
  const rejected = unknown.map((key) => `"${key}"`).join(', ')
  return `Unknown argument${unknown.length === 1 ? '' : 's'} ${rejected} for "${toolName}" — valid keys: ${known.join(', ') || '(none)'}`
}

function invocationError(toolName: string, error: unknown): string {
  if (isZodErrorLike(error)) {
    return formatToolValidationError(toolName, error.issues)
  }
  return errorMessage(error)
}

// Dev-only output-side twin of the input validation; warns instead of throwing so schema lag never breaks a running app.
function warnOnOutputDrift(contract: AgentToolContract, result: unknown): void {
  if (!isDevBuild()) return
  const check = contract.output.safeParse(result)
  if (!check.success) {
    console.warn(
      `[genie] tool "${contract.name}" returned a result that does not match its output contract:`,
      check.error.issues,
    )
  }
}

function isDevBuild(): boolean {
  return readNodeEnv()?.NODE_ENV !== 'production'
}

// Runs in both browser and Node; the one cast for the optional ambient `process` global is isolated here.
function readNodeEnv(): Record<string, string | undefined> | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
}

// Contracts are immutable per tool, so the schema conversion (the expensive part of a hello) runs once per contract, not once per hello.
const descriptorCache = new WeakMap<AgentToolContract, ToolDescriptor>()

function toDescriptor(tool: ErasedCollectorTool): ToolDescriptor {
  const { contract } = tool
  let base = descriptorCache.get(contract)
  if (!base) {
    base = {
      name: contract.name,
      title: contract.title,
      description: contract.description,
      group: contract.group,
      inputJsonSchema: safeToJsonSchema(contract.name, contract.input, 'input'),
      outputJsonSchema: safeToJsonSchema(contract.name, contract.output, 'output'),
      annotations: contract.annotations,
    }
    descriptorCache.set(contract, base)
  }
  const availability = tool.availability?.()
  return availability && !availability.available
    ? { ...base, available: false, unavailableReason: availability.reason }
    : base
}

/** JSON Schema conversion can throw on schemas from a mismatched zod copy; a missing schema degrades discovery (warned loudly), a throw would kill the hello. */
function safeToJsonSchema(toolName: string, schema: z.ZodType, io: 'input' | 'output'): unknown {
  try {
    return io === 'input' ? z.toJSONSchema(schema, { io: 'input' }) : z.toJSONSchema(schema)
  } catch (error) {
    console.warn(
      `[genie] tool "${toolName}": could not derive the ${io} JSON Schema (${errorMessage(error)}) — the tool stays callable and validated, but agents cannot discover its ${io} contract`,
    )
    return undefined
  }
}

function defaultBridgeUrl(): string {
  if (typeof location === 'undefined') return `ws://127.0.0.1:5173${GENIE_WS_PATH}`
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}${GENIE_WS_PATH}`
}

const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike
