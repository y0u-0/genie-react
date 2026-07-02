import { z } from 'zod'
import {
  type AgentToolContract,
  type AppBoundMessage,
  type AppInfo,
  decodeAppBoundMessage,
  encodeMessage,
  errorMessage,
  GENIE_PROTOCOL_VERSION,
  GENIE_WS_PATH,
  newId,
  type ToolDescriptor,
} from '../protocol'
import type { CollectorContext, ErasedCollectorTool, GenieCollector } from './collector'

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
}

const SOCKET_OPEN = 1

export class GenieClient {
  private readonly url: string
  private readonly appName: string | undefined
  private readonly socketFactory: SocketFactory
  private readonly reconnectDelayMs: number
  private readonly sessionId = newId()
  private readonly collectors: GenieCollector[] = []
  private readonly tools = new Map<string, ErasedCollectorTool>()
  private readonly cleanups = new Map<string, () => void>()
  private socket: SocketLike | null = null
  private started = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: GenieClientOptions) {
    this.url = options.url ?? defaultBridgeUrl()
    this.appName = options.appName
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    for (const cleanup of this.cleanups.values()) cleanup()
    this.cleanups.clear()
    this.socket?.close()
    this.socket = null
  }

  registerCollector(collector: GenieCollector): void {
    this.collectors.push(collector)
    if (this.socket?.readyState === SOCKET_OPEN) {
      this.registerCollectorTools(collector)
      this.sendHello()
      this.runCollectorStart(collector)
    }
  }

  private connect(): void {
    const socket = this.socketFactory(`${this.url}?role=app`)
    this.socket = socket
    socket.onopen = () => this.onOpen()
    socket.onmessage = (event) => this.onMessage(String(event.data))
    socket.onclose = () => {
      this.socket = null
      if (this.started) this.scheduleReconnect()
    }
    socket.onerror = () => {}
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.started) this.connect()
    }, this.reconnectDelayMs)
  }

  private onOpen(): void {
    this.tools.clear()
    for (const collector of this.collectors) this.registerCollectorTools(collector)
    // Hello must precede collector start() so the bridge doesn't drop snapshots pushed before the session registers.
    this.sendHello()
    for (const collector of this.collectors) this.runCollectorStart(collector)
  }

  private registerCollectorTools(collector: GenieCollector): void {
    for (const tool of collector.tools ?? []) this.tools.set(tool.contract.name, tool)
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
      refreshTools: () => this.sendHello(),
    }
  }

  private sendHello(): void {
    this.send({
      kind: 'app/hello',
      protocol: GENIE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      app: this.appInfo(),
      capabilities: this.capabilities(),
      tools: this.descriptors(),
    })
  }

  private appInfo(): AppInfo {
    const info: AppInfo = {}
    for (const collector of this.collectors) Object.assign(info, collector.appInfo?.() ?? {})
    if (this.appName) info.name = this.appName
    if (!info.name && typeof document !== 'undefined' && document.title) info.name = document.title
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
    }
  }

  private async handleRequest(id: string, toolName: string, args: unknown): Promise<void> {
    const tool = this.tools.get(toolName)
    if (!tool) {
      this.send({ kind: 'app/response', id, ok: false, error: this.unknownToolError(toolName) })
      return
    }
    const rejectedKeys = unknownArgKeysError(toolName, tool.contract.input, args)
    if (rejectedKeys) {
      this.send({ kind: 'app/response', id, ok: false, error: rejectedKeys })
      return
    }
    try {
      const parsed = tool.contract.input.parse(args ?? {}) as never
      const result = await tool.handler(parsed, this.context())
      warnOnOutputDrift(tool.contract, result)
      this.send({ kind: 'app/response', id, ok: true, result })
    } catch (error) {
      this.send({ kind: 'app/response', id, ok: false, error: invocationError(toolName, error) })
    }
  }

  private unknownToolError(toolName: string): string {
    const domains = this.capabilities().sort().join(', ') || 'none'
    const hint =
      DOMAIN_GATING_HINTS[toolName.split('_')[0] ?? ''] ?? 'run `genie tools` for the live catalog'
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
}

/** Zod objects strip unrecognized keys silently — an agent typo like `maxDepth` for `depth` would otherwise no-op; reject it loudly instead. */
function unknownArgKeysError(
  toolName: string,
  input: AgentToolContract['input'],
  args: unknown,
): string | null {
  if (!(input instanceof z.ZodObject) || typeof args !== 'object' || args === null) return null
  const known = Object.keys(input.shape)
  const unknown = Object.keys(args).filter((key) => !known.includes(key))
  if (unknown.length === 0) return null
  const rejected = unknown.map((key) => `"${key}"`).join(', ')
  return `Unknown argument${unknown.length === 1 ? '' : 's'} ${rejected} for "${toolName}" — valid keys: ${known.join(', ') || '(none)'}`
}

function invocationError(toolName: string, error: unknown): string {
  if (error instanceof z.ZodError) {
    const issues = error.issues
      .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
      .join('; ')
    return `Invalid arguments for "${toolName}": ${issues}`
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

function toDescriptor(tool: ErasedCollectorTool): ToolDescriptor {
  const { contract } = tool
  return {
    name: contract.name,
    title: contract.title,
    description: contract.description,
    group: contract.group,
    inputJsonSchema: z.toJSONSchema(contract.input, { io: 'input' }),
    outputJsonSchema: z.toJSONSchema(contract.output),
    annotations: contract.annotations,
  }
}

function defaultBridgeUrl(): string {
  if (typeof location === 'undefined') return `ws://127.0.0.1:5173${GENIE_WS_PATH}`
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}${GENIE_WS_PATH}`
}

const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike
