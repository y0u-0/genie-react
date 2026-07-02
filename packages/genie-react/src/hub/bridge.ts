import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import {
  type AgentMessage,
  type AppInfo,
  type AppMessage,
  agentMessageSchema,
  appMessageSchema,
  type ConnectionRole,
  DEFAULT_REQUEST_TIMEOUT_MS,
  decodeFrame,
  devtoolsStatusContract,
  devtoolsWaitContract,
  encodeMessage,
  GENIE_WS_PATH,
  metaToolDescriptors,
  newId,
  ROLE_QUERY_PARAM,
  type SessionSummary,
  type ToolDescriptor,
  type WaitCondition,
} from '../protocol'
import { frameKind, matchesOf, parseQueryList, routerStateOf } from './wire-guards'

type BridgeLogLevel = 'info' | 'warn' | 'error'
type BridgeLogger = (level: BridgeLogLevel, message: string, meta?: unknown) => void

export interface GenieBridgeOptions {
  requestTimeoutMs?: number
  /** WS ping cadence used to reap half-open connections (crashed tabs); a peer is dropped after two silent intervals. */
  heartbeatIntervalMs?: number
  logger?: BridgeLogger
}

interface BridgeStatus {
  connected: boolean
  sessionId: string | null
  app: AppInfo | null
  domains: string[]
  tools: ToolDescriptor[]
  sessions: SessionSummary[]
}

interface AppSession {
  socket: WebSocket
  sessionId: string
  app: AppInfo
  capabilities: string[]
  tools: ToolDescriptor[]
  connectedAt: number
}

interface Connection {
  socket: WebSocket
  role: ConnectionRole | null
}

interface AppResponse {
  ok: boolean
  result?: unknown
  error?: string
}

interface PendingRequest {
  settle: (response: AppResponse) => void
  timer: ReturnType<typeof setTimeout>
  sessionId: string
}

const POLL_INTERVAL_MS = 150
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

/** A session's full catalog: its advertised tools plus the bridge-answered meta tools, so listings and toolCount agree. */
function catalogOf(session: AppSession | null | undefined): ToolDescriptor[] {
  return [...(session?.tools ?? []), ...metaToolDescriptors]
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Keeps a leaked bridge from pinning the process; Node-only, but typed against a possible DOM `number` timer.
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
}

/** The hub: a `noServer` WSS mountable on Vite's HTTP server; calls route to the newest app session unless `agent/invoke.sessionId` targets one, and it answers the `devtools_status`/`devtools_wait` meta tools itself. */
export class GenieBridge {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly agents = new Set<WebSocket>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly connectionWaiters = new Set<() => void>()
  private readonly requestTimeoutMs: number
  private readonly log: BridgeLogger
  private readonly apps = new Map<string, AppSession>()
  private readonly connections = new Set<WebSocket>()
  private readonly responsiveSockets = new WeakSet<WebSocket>()
  private readonly heartbeat: ReturnType<typeof setInterval>
  private currentSessionId: string | null = null

  constructor(options: GenieBridgeOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.log = options.logger ?? (() => {})
    const interval = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeat = setInterval(() => this.sweepDeadConnections(), interval)
    unrefTimer(this.heartbeat)
  }

  /** Returns `false` for non-{@link GENIE_WS_PATH} upgrades so another listener (e.g. Vite HMR) can handle them. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const { pathname, role } = parseUpgradeUrl(request.url)
    if (pathname !== GENIE_WS_PATH) return false
    this.wss.handleUpgrade(request, socket, head, (ws) => this.onConnection(ws, role))
    return true
  }

  getStatus(): BridgeStatus {
    const current = this.currentSession()
    return {
      connected: this.apps.size > 0,
      sessionId: current?.sessionId ?? null,
      app: current?.app ?? null,
      domains: current?.capabilities ?? [],
      tools: catalogOf(current),
      sessions: this.sessionSummaries(),
    }
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    // terminate(), not close(): a graceful close handshake with a half-open peer blocks shutdown on ws's 30s timeout.
    for (const socket of this.agents) socket.terminate()
    for (const session of this.apps.values()) session.socket.terminate()
    this.wss.close()
  }

  private currentSession(): AppSession | null {
    return this.currentSessionId ? (this.apps.get(this.currentSessionId) ?? null) : null
  }

  private sessionSummaries(): SessionSummary[] {
    return [...this.apps.values()]
      .sort((a, b) => b.connectedAt - a.connectedAt)
      .map((session) => ({
        sessionId: session.sessionId,
        app: session.app,
        domains: session.capabilities,
        toolCount: catalogOf(session).length,
        connectedAt: session.connectedAt,
        current: session.sessionId === this.currentSessionId,
      }))
  }

  private hasSession(sessionId?: string): boolean {
    return sessionId ? this.apps.has(sessionId) : this.apps.size > 0
  }

  private onConnection(socket: WebSocket, role: ConnectionRole | null): void {
    const connection: Connection = { socket, role }
    this.connections.add(socket)
    this.responsiveSockets.add(socket)
    if (role === 'agent') this.registerAgent(socket)
    socket.on('message', (data) => this.onMessage(connection, data.toString()))
    socket.on('pong', () => this.responsiveSockets.add(socket))
    socket.on('close', () => this.onClose(connection))
    socket.on('error', (error) => this.log('warn', 'socket error', error))
  }

  private sweepDeadConnections(): void {
    for (const socket of this.connections) {
      if (socket.readyState !== WebSocket.OPEN) continue
      if (this.responsiveSockets.has(socket)) {
        this.responsiveSockets.delete(socket)
        socket.ping()
      } else {
        this.log('warn', 'terminating unresponsive connection')
        socket.terminate()
      }
    }
  }

  private onMessage(connection: Connection, raw: string): void {
    let frame: unknown
    try {
      frame = decodeFrame(raw)
    } catch (error) {
      this.log('warn', 'failed to decode frame', error)
      return
    }

    const role: ConnectionRole =
      connection.role ?? (frameKind(frame)?.startsWith('agent/') ? 'agent' : 'app')
    if (connection.role === null) {
      connection.role = role
      if (role === 'agent') this.registerAgent(connection.socket)
    }

    try {
      if (role === 'agent')
        this.handleAgentMessage(connection.socket, agentMessageSchema.parse(frame))
      else this.handleAppMessage(connection.socket, appMessageSchema.parse(frame))
    } catch (error) {
      this.log('warn', 'invalid message', error)
    }
  }

  private registerAgent(socket: WebSocket): void {
    this.agents.add(socket)
    this.send(socket, { kind: 'bridge/status', ...this.getStatus() })
  }

  private handleAppMessage(socket: WebSocket, message: AppMessage): void {
    switch (message.kind) {
      case 'app/hello': {
        const existing = this.apps.get(message.sessionId)
        if (existing && existing.socket !== socket) {
          // Requests in flight on the replaced socket will never get a response.
          this.failPendingForSession(
            message.sessionId,
            'app reconnected — the previous connection was replaced; retry the call',
          )
          existing.socket.close()
        }
        this.apps.set(message.sessionId, {
          socket,
          sessionId: message.sessionId,
          app: message.app,
          capabilities: message.capabilities,
          tools: message.tools,
          // First-connect time survives re-hellos (tool refreshes, reconnects), so a background tab can't steal recency.
          connectedAt: existing?.connectedAt ?? Date.now(),
        })
        if (!existing) {
          this.currentSessionId = message.sessionId
          this.log(
            'info',
            `app connected: ${message.app.name ?? message.sessionId} (${this.apps.size} session${this.apps.size === 1 ? '' : 's'})`,
          )
        }
        for (const notify of [...this.connectionWaiters]) notify()
        this.broadcastStatus()
        return
      }
      case 'app/event':
        return
      case 'app/response': {
        const pending = this.pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        pending.settle({ ok: message.ok, result: message.result, error: message.error })
        return
      }
    }
  }

  private handleAgentMessage(socket: WebSocket, message: AgentMessage): void {
    switch (message.kind) {
      case 'agent/ping':
        this.send(socket, { kind: 'bridge/pong', id: message.id })
        return
      case 'agent/invoke':
        void this.handleInvoke(socket, message.id, message.tool, message.args, message.sessionId)
        return
    }
  }

  private async handleInvoke(
    agent: WebSocket,
    id: string,
    tool: string,
    args: unknown,
    sessionId?: string,
  ): Promise<void> {
    if (tool === devtoolsStatusContract.name) {
      const target = sessionId ? this.apps.get(sessionId) : this.currentSession()
      if (sessionId && !target) {
        this.result(agent, id, false, undefined, this.unknownSessionError(sessionId))
        return
      }
      this.result(agent, id, true, {
        connected: this.apps.size > 0,
        sessionId: target?.sessionId ?? null,
        app: target?.app ?? null,
        domains: target?.capabilities ?? [],
        toolCount: catalogOf(target).length,
        tools: catalogOf(target),
        sessions: this.sessionSummaries(),
      })
      return
    }

    if (tool === devtoolsWaitContract.name) {
      await this.handleWait(agent, id, args, sessionId)
      return
    }

    this.forwardToApp(agent, id, tool, args, sessionId)
  }

  private async handleWait(
    agent: WebSocket,
    id: string,
    args: unknown,
    sessionId?: string,
  ): Promise<void> {
    const parsed = devtoolsWaitContract.input.safeParse(args ?? {})
    if (!parsed.success) {
      this.result(agent, id, false, undefined, 'invalid devtools_wait arguments')
      return
    }
    const input = parsed.data
    const started = Date.now()
    const finish = (ok: boolean, reason?: string) =>
      this.result(agent, id, true, { ok, waitedMs: Date.now() - started, reason })

    if (input.condition === 'connected') {
      const connected = await this.waitForConnection(input.timeoutMs, sessionId)
      finish(connected, connected ? undefined : 'timeout')
      return
    }

    if (
      !this.hasSession(sessionId) &&
      !(await this.waitForConnection(input.timeoutMs, sessionId))
    ) {
      finish(false, 'no app connected')
      return
    }

    const ok = await this.pollCondition(input, input.timeoutMs - (Date.now() - started), sessionId)
    finish(ok, ok ? undefined : 'timeout')
  }

  private async pollCondition(
    input: { condition: WaitCondition; name?: string },
    remainingMs: number,
    sessionId?: string,
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, remainingMs)
    while (Date.now() < deadline) {
      if (await this.checkCondition(input, sessionId)) return true
      await delay(POLL_INTERVAL_MS)
    }
    return false
  }

  private async checkCondition(
    input: { condition: WaitCondition; name?: string },
    sessionId?: string,
  ): Promise<boolean> {
    if (input.condition === 'component') {
      const res = await this.appRequest(
        'react_find_components',
        { query: input.name ?? '', limit: 1 },
        sessionId,
      )
      const matches = matchesOf(res.result)
      return res.ok && matches !== undefined && matches.length > 0
    }
    if (input.condition === 'query-settled') {
      const res = await this.appRequest('query_list', {}, sessionId)
      const queries = parseQueryList(res.result)
      if (!res.ok || !queries || queries.length === 0) return false
      const name = input.name
      const relevant = name
        ? queries.filter((query) => JSON.stringify(query.queryKey ?? null).includes(name))
        : queries
      return relevant.length > 0 && relevant.every((query) => query.fetchStatus === 'idle')
    }
    if (input.condition === 'navigation') {
      const res = await this.appRequest('router_get_state', {}, sessionId)
      const state = routerStateOf(res.result)
      if (!res.ok || !state) return false
      return input.name ? state.pathname === input.name && !state.isLoading : !state.isLoading
    }
    return false
  }

  private forwardToApp(
    agent: WebSocket,
    id: string,
    tool: string,
    args: unknown,
    sessionId?: string,
  ): void {
    this.sendAppRequest(
      id,
      tool,
      args,
      ({ ok, result, error }) => this.result(agent, id, ok, result, error),
      sessionId,
    )
  }

  private appRequest(tool: string, args: unknown, sessionId?: string): Promise<AppResponse> {
    return new Promise((resolve) => this.sendAppRequest(newId(), tool, args, resolve, sessionId))
  }

  private sendAppRequest(
    id: string,
    tool: string,
    args: unknown,
    settle: (response: AppResponse) => void,
    sessionId?: string,
  ): void {
    const session = sessionId ? this.apps.get(sessionId) : this.currentSession()
    if (!session) {
      settle({
        ok: false,
        error: sessionId
          ? this.unknownSessionError(sessionId)
          : 'No app connected. Run your dev server with the Genie Vite plugin.',
      })
      return
    }
    const timer = setTimeout(() => {
      this.pending.delete(id)
      settle({ ok: false, error: `Tool "${tool}" timed out after ${this.requestTimeoutMs}ms` })
    }, this.requestTimeoutMs)
    this.pending.set(id, { settle, timer, sessionId: session.sessionId })
    this.send(session.socket, { kind: 'bridge/request', id, tool, args })
  }

  private waitForConnection(timeoutMs: number, sessionId?: string): Promise<boolean> {
    if (this.hasSession(sessionId)) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (connected: boolean) => {
        if (settled) return
        settled = true
        this.connectionWaiters.delete(waiter)
        clearTimeout(timer)
        resolve(connected)
      }
      const waiter = () => {
        if (this.hasSession(sessionId)) finish(true)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.connectionWaiters.add(waiter)
    })
  }

  private unknownSessionError(sessionId: string): string {
    return `Unknown session "${sessionId}". Connected sessions: ${[...this.apps.keys()].join(', ') || 'none'} — run devtools_status to list them.`
  }

  private failPendingForSession(sessionId: string, error: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timer)
      pending.settle({ ok: false, error })
      this.pending.delete(id)
    }
  }

  private onClose(connection: Connection): void {
    this.connections.delete(connection.socket)
    const session = [...this.apps.values()].find((s) => s.socket === connection.socket)
    if (session) {
      this.apps.delete(session.sessionId)
      this.log('info', `app disconnected: ${session.app.name ?? session.sessionId}`)
      this.failPendingForSession(session.sessionId, 'app disconnected')
      if (this.currentSessionId === session.sessionId) {
        const next = [...this.apps.values()].sort((a, b) => b.connectedAt - a.connectedAt)[0]
        this.currentSessionId = next?.sessionId ?? null
      }
      this.broadcastStatus()
      return
    }
    this.agents.delete(connection.socket)
  }

  private broadcastStatus(): void {
    const status = { kind: 'bridge/status' as const, ...this.getStatus() }
    for (const agent of this.agents) this.send(agent, status)
  }

  private result(
    agent: WebSocket,
    id: string,
    ok: boolean,
    result?: unknown,
    error?: string,
  ): void {
    this.send(agent, { kind: 'bridge/result', id, ok, result, error })
  }

  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(encodeMessage(message))
  }
}

function parseUpgradeUrl(url: string | undefined): {
  pathname: string
  role: ConnectionRole | null
} {
  const parsed = new URL(url ?? '/', 'http://localhost')
  const roleParam = parsed.searchParams.get(ROLE_QUERY_PARAM)
  const role = roleParam === 'app' || roleParam === 'agent' ? roleParam : null
  return { pathname: parsed.pathname, role }
}
