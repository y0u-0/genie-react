import './ws-env'
import {
  type AgentBoundMessage,
  type AgentErrorCode,
  type AgentToolContract,
  type BridgeStatusMessage,
  type BusyTelemetry,
  decodeAgentBoundMessage,
  encodeMessage,
  errorMessage,
  newId,
  type ToolInput,
  type ToolOutput,
} from 'genie-react/protocol'
import { WebSocket } from 'ws'

export interface GenieAgentLinkOptions {
  /** Bridge URL, or a resolver re-invoked on every (re)connect so the link self-heals when the URL changes. */
  url: string | (() => string | Promise<string>)
  logger?: (message: string) => void
  connectTimeoutMs?: number
  invokeTimeoutMs?: number
  reconnectDelayMs?: number
  /** Target a specific app session when several tabs are connected (default: most recent). */
  sessionId?: string
}

/** Grace added on top of a per-call `timeoutMs` so the bridge's typed answer (timeout/busy) wins the race with the link's own guard. */
export const INVOKE_GRACE_MS = 2_000

/** A bridge-side failure that carries the machine-readable code (and optional retry hint) from the `bridge/result` frame. */
export class BridgeCallError extends Error {
  readonly errorCode?: AgentErrorCode
  readonly retryInMs?: number
  readonly busyTelemetry?: BusyTelemetry

  constructor(
    message: string,
    options?: {
      errorCode?: AgentErrorCode
      retryInMs?: number
      busyTelemetry?: BusyTelemetry
    },
  ) {
    super(message)
    this.name = 'BridgeCallError'
    this.errorCode = options?.errorCode
    this.retryInMs = options?.retryInMs
    this.busyTelemetry = options?.busyTelemetry
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface InvokeOptions {
  /** Per-call full-timeout budget forwarded to the bridge; the local guard waits this plus {@link INVOKE_GRACE_MS}. */
  timeoutMs?: number
}

/** Agent-side WebSocket client to the bridge; reconnects and re-resolves the URL each attempt to survive dev-server restarts. */
export class GenieAgentLink {
  private readonly resolveUrl: () => string | Promise<string>
  private readonly log: (message: string) => void
  private readonly connectTimeoutMs: number
  private readonly invokeTimeoutMs: number
  private readonly reconnectDelayMs: number
  private readonly sessionId: string | undefined
  private readonly pending = new Map<string, Pending>()
  private ws: WebSocket | null = null
  private status: BridgeStatusMessage | null = null
  private currentUrl = ''
  private openWaiters: Array<() => void> = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connecting = false
  private closed = false

  /** Invoked whenever the bridge pushes a status update (e.g. an app connects with new tools). */
  onStatus: ((status: BridgeStatusMessage) => void) | null = null

  constructor(options: GenieAgentLinkOptions) {
    const { url } = options
    this.resolveUrl = typeof url === 'function' ? url : () => url
    this.log = options.logger ?? (() => {})
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? 30_000
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000
    this.sessionId = options.sessionId
  }

  start(): void {
    this.closed = false
    void this.connect()
  }

  getStatus(): BridgeStatusMessage | null {
    return this.status
  }

  /** Contract-typed round-trip (no cast); `sessionId` overrides the link target, and `null` forces a bridge-global call. */
  invoke<C extends AgentToolContract>(
    contract: C,
    args: ToolInput<C>,
    sessionId?: string | null,
    options?: InvokeOptions,
  ): Promise<ToolOutput<C>>
  /** Pass a bare tool name for dynamic dispatch of a tool discovered at runtime over the wire. */
  invoke(
    tool: string,
    args: unknown,
    sessionId?: string | null,
    options?: InvokeOptions,
  ): Promise<unknown>
  async invoke(
    toolOrContract: string | AgentToolContract,
    args: unknown,
    sessionId: string | null | undefined = this.sessionId,
    options: InvokeOptions = {},
  ): Promise<unknown> {
    const tool = typeof toolOrContract === 'string' ? toolOrContract : toolOrContract.name
    const ws = await this.ensureConnection()
    const id = newId()
    // Give the bridge its per-call budget plus a grace window, so its typed timeout/busy result arrives before this local guard fires.
    const localTimeoutMs =
      options.timeoutMs === undefined ? this.invokeTimeoutMs : options.timeoutMs + INVOKE_GRACE_MS
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new BridgeCallError(`Bridge did not respond to "${tool}" within ${localTimeoutMs}ms`, {
            errorCode: 'timeout',
          }),
        )
      }, localTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(
        encodeMessage({
          kind: 'agent/invoke',
          id,
          tool,
          args,
          sessionId: sessionId ?? undefined,
          timeoutMs: options.timeoutMs,
        }),
      )
    })
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('agent link closed'))
    }
    this.pending.clear()
    this.ws?.close()
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.ws) return
    this.connecting = true

    let url: string
    try {
      url = await this.resolveUrl()
    } catch (error) {
      this.connecting = false
      this.log(`failed to resolve bridge url: ${errorMessage(error)}`)
      if (!this.closed) this.scheduleReconnect()
      return
    }
    if (this.closed) {
      this.connecting = false
      return
    }

    this.currentUrl = url
    const ws = new WebSocket(`${url}?role=agent`)
    this.ws = ws
    this.connecting = false
    ws.on('open', () => {
      this.log(`connected to bridge at ${url}`)
      const waiters = this.openWaiters
      this.openWaiters = []
      for (const waiter of waiters) waiter()
    })
    ws.on('message', (data) => this.onMessage(data.toString()))
    ws.on('error', (error) => this.log(`socket error: ${errorMessage(error)}`))
    ws.on('close', () => {
      this.ws = null
      this.status = null
      if (!this.closed) this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, this.reconnectDelayMs)
  }

  private onMessage(raw: string): void {
    let message: AgentBoundMessage
    try {
      message = decodeAgentBoundMessage(raw)
    } catch (error) {
      this.log(`failed to decode bridge message: ${errorMessage(error)}`)
      return
    }
    if (message.kind === 'bridge/result') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else
        pending.reject(
          new BridgeCallError(message.error ?? 'tool failed', {
            errorCode: message.errorCode,
            retryInMs: message.retryInMs,
            busyTelemetry: message.busyTelemetry,
          }),
        )
    } else if (message.kind === 'bridge/status') {
      this.status = message
      this.onStatus?.(message)
    }
  }

  private ensureConnection(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws)
    return new Promise<WebSocket>((resolve, reject) => {
      const onOpen = () => {
        clearTimeout(timer)
        if (this.ws && this.ws.readyState === WebSocket.OPEN) resolve(this.ws)
        else reject(new Error('bridge connection closed before it was ready'))
      }
      const timer = setTimeout(() => {
        this.openWaiters = this.openWaiters.filter((waiter) => waiter !== onOpen)
        reject(
          new Error(
            `Genie bridge not reachable at ${this.currentUrl || '(unresolved)'}. Start it: Vite apps run the dev server with the genie() plugin; Next.js/other apps run \`genie-react hub\` (or next dev with instrumentation).`,
          ),
        )
      }, this.connectTimeoutMs)
      this.openWaiters.push(onOpen)
      if (!this.ws && !this.reconnectTimer && !this.connecting) void this.connect()
    })
  }
}
