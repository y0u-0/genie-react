import './ws-env'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import {
  type AgentErrorCode,
  type AgentMessage,
  type AppInfo,
  type AppMessage,
  agentMessageSchema,
  appMessageSchema,
  type BusyTelemetry,
  type ConnectionRole,
  DEFAULT_REQUEST_TIMEOUT_MS,
  decodeFrame,
  devtoolsStatusContract,
  devtoolsWaitContract,
  encodeMessage,
  formatToolValidationError,
  GENIE_WS_PATH,
  metaToolDescriptors,
  newId,
  ROLE_QUERY_PARAM,
  type SessionSummary,
  type ToolDescriptor,
  WAIT_CONDITIONS,
  type WaitCondition,
  type WaitDomain,
} from '../protocol'
import { CaptureManager, isCaptureTool } from './capture-manager'
import {
  InteractionManager,
  type InteractionSettleResult,
  isInteractionTool,
} from './interaction-manager'
import { frameKind, matchesOf, parseQueryList, queryStateOf, routerStateOf } from './wire-guards'

type BridgeLogLevel = 'info' | 'warn' | 'error'
type BridgeLogger = (level: BridgeLogLevel, message: string, meta?: unknown) => void

export interface GenieBridgeOptions {
  requestTimeoutMs?: number
  /** WS ping cadence used to reap half-open connections (crashed tabs); a peer is dropped after two silent intervals. */
  heartbeatIntervalMs?: number
  /** When a still-pending request is checked for a busy (main-thread-blocked) app; production default 2000ms. */
  busyProbeMs?: number
  /** How stale an app heartbeat must be at probe time to fast-fail as busy; production default 2500ms. */
  busyHeartbeatGapMs?: number
  /** Silence after which a heartbeat-capable session reads as a dead tab context and loses default routing; production default 15000ms. */
  sessionStaleMs?: number
  /** Grace for ordinary reload overlap before a concurrent logical identity is auto-forked. */
  logicalCollisionGraceMs?: number
  logger?: BridgeLogger
}

interface BridgeStatus {
  connected: boolean
  ready: boolean
  sessionId: string | null
  app: AppInfo | null
  domains: string[]
  tools: ToolDescriptor[]
  sessions: SessionSummary[]
  warnings: string[]
}

interface AppSession {
  socket: WebSocket
  sessionId: string
  logicalSessionId?: string
  documentGeneration?: number
  sessionName?: string
  predecessorSessionId?: string
  successorSessionId?: string
  forkedFromLogicalSessionId?: string
  app: AppInfo
  capabilities: string[]
  tools: ToolDescriptor[]
  connectedAt: number
  readyAt?: number
  /** Last `app/heartbeat` receipt; undefined until the first beat, which is how legacy (never-beating) clients opt out of busy fast-fail. */
  lastHeartbeatAt?: number
}

interface LatestDocument {
  sessionId: string
  documentGeneration?: number
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
  errorCode?: AgentErrorCode
  retryInMs?: number
  busyTelemetry?: BusyTelemetry
}

interface PendingRequest {
  settle: (response: AppResponse) => void
  timer: ReturnType<typeof setTimeout>
  busyTimer: ReturnType<typeof setTimeout> | null
  sessionId: string
}

const POLL_INTERVAL_MS = 150
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

// A request still pending this long with a stale heartbeat is fast-failed as busy, far short of the 20s full timeout.
const BUSY_PROBE_MS = 2_000
// Above the ~1s heartbeat cadence with margin for a tool that itself blocks the thread a while — only a longer silence reads as busy.
const BUSY_HEARTBEAT_GAP_MS = 3_500
const BUSY_RETRY_MS = 500
// Well past any legitimate block: a session silent this long is a dead tab context, not a busy one.
const SESSION_STALE_MS = 15_000
const MIN_REQUEST_TIMEOUT_MS = 1_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const MAX_SESSION_SUCCESSORS = 256
const LOGICAL_COLLISION_GRACE_MS = 750

interface WaitInput {
  condition: WaitCondition
  name?: string
  queryHash?: string
  queryKey?: unknown[]
  domains: WaitDomain[]
  quietMs: number
}

interface WaitDomainCheck {
  status: 'met' | 'pending' | 'failed' | 'unsupported'
  reason?: string
  lastObserved?: unknown
}

interface WaitCheck {
  state: 'met' | 'pending' | 'failed'
  reason?: string
  query?: { queryHash: string; queryKey: unknown }
  lastObserved?: Record<string, unknown>
  domains?: Partial<Record<WaitDomain, WaitDomainCheck>>
}

interface WaitPollState {
  reactCommit: number | null
  reactChangedAt: number
  frameCheck: WaitDomainCheck | null
}

function queryIdentity(
  query: Record<string, unknown>,
): { queryHash: string; queryKey: unknown } | undefined {
  if (typeof query.queryHash !== 'string' || !('queryKey' in query)) return undefined
  return { queryHash: query.queryHash, queryKey: query.queryKey }
}

function legacyQueryMatches(query: Record<string, unknown>, name: string): boolean {
  if (query.queryHash === name) return true
  let expectedKey: unknown = [name]
  try {
    const parsed: unknown = JSON.parse(name)
    if (Array.isArray(parsed)) expectedKey = parsed
  } catch {
    // A plain name means the exact one-item key [name].
  }
  return JSON.stringify(query.queryKey) === JSON.stringify(expectedKey)
}

/** A session's full catalog: its advertised tools plus the bridge-answered meta tools, so listings and toolCount agree. */
function catalogOf(session: AppSession | null | undefined): ToolDescriptor[] {
  return [...(session?.tools ?? []), ...metaToolDescriptors]
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function toolDescriptor(session: AppSession, tool: string): ToolDescriptor | undefined {
  return catalogOf(session).find((descriptor) => descriptor.name === tool)
}

function compareSessionRecency(a: AppSession, b: AppSession): number {
  if (a.logicalSessionId && a.logicalSessionId === b.logicalSessionId) {
    const generationOrder = (b.documentGeneration ?? 0) - (a.documentGeneration ?? 0)
    if (generationOrder !== 0) return generationOrder
  }
  return b.connectedAt - a.connectedAt
}

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
  private readonly busyProbeMs: number
  private readonly busyHeartbeatGapMs: number
  private readonly sessionStaleMs: number
  private readonly logicalCollisionGraceMs: number
  private readonly log: BridgeLogger
  private readonly apps = new Map<string, AppSession>()
  /** Physical document id → its replacement; bounded so stale shell pins can survive ordinary reloads. */
  private readonly sessionSuccessors = new Map<string, string>()
  /** Logical tab id → latest document, retained after socket close so close-before-hello reloads keep lineage. */
  private readonly latestDocuments = new Map<string, LatestDocument>()
  private readonly logicalCollisionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly captures: CaptureManager<AppSession>
  private readonly interactions: InteractionManager<AppSession>
  private readonly connections = new Set<WebSocket>()
  private readonly responsiveSockets = new WeakSet<WebSocket>()
  private readonly heartbeat: ReturnType<typeof setInterval>
  private currentSessionId: string | null = null

  constructor(options: GenieBridgeOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.busyProbeMs = options.busyProbeMs ?? BUSY_PROBE_MS
    this.busyHeartbeatGapMs = options.busyHeartbeatGapMs ?? BUSY_HEARTBEAT_GAP_MS
    this.sessionStaleMs = options.sessionStaleMs ?? SESSION_STALE_MS
    this.logicalCollisionGraceMs = Math.max(
      0,
      options.logicalCollisionGraceMs ?? LOGICAL_COLLISION_GRACE_MS,
    )
    this.log = options.logger ?? (() => {})
    this.captures = new CaptureManager({
      resolveSession: (target) => (target ? this.resolveSession(target) : this.currentSession()),
      unknownSessionError: (target) => this.unknownSessionError(target),
      isCurrentSession: (session) => this.apps.get(session.sessionId)?.socket === session.socket,
      request: (session, tool, args) => this.appRequestForSession(tool, args, session),
    })
    this.interactions = new InteractionManager({
      resolveSession: (target) => (target ? this.resolveSession(target) : this.currentSession()),
      unknownSessionError: (target) => this.unknownSessionError(target),
      isCurrentSession: (session) => this.apps.get(session.sessionId)?.socket === session.socket,
      request: (session, tool, args) => this.appRequestForSession(tool, args, session),
      settle: (session, domains, quietMs, timeoutMs) =>
        this.settleInteraction(session, domains, quietMs, timeoutMs),
    })
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
      ready: current?.readyAt !== undefined,
      sessionId: current?.sessionId ?? null,
      app: current?.app ?? null,
      domains: current?.capabilities ?? [],
      tools: catalogOf(current),
      sessions: this.sessionSummaries(),
      warnings: this.statusWarnings(),
    }
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const pending of this.pending.values()) this.clearPendingTimers(pending)
    this.pending.clear()
    this.sessionSuccessors.clear()
    this.latestDocuments.clear()
    for (const timer of this.logicalCollisionTimers.values()) clearTimeout(timer)
    this.logicalCollisionTimers.clear()
    this.captures.clear()
    this.interactions.clear()
    // terminate(), not close(): a graceful close handshake with a half-open peer blocks shutdown on ws's 30s timeout.
    for (const socket of this.agents) socket.terminate()
    for (const session of this.apps.values()) session.socket.terminate()
    this.wss.close()
  }

  // A heartbeat-capable session gone this quiet is a dead tab context (reload leftover, frozen bfcache page) — never route default calls to it while a live session exists.
  private staleMsOf(session: AppSession): number | null {
    if (session.lastHeartbeatAt === undefined) return null
    const gap = Date.now() - session.lastHeartbeatAt
    return gap > this.sessionStaleMs ? gap : null
  }

  private currentSession(): AppSession | null {
    const pinned = this.currentSessionId ? (this.apps.get(this.currentSessionId) ?? null) : null
    if (pinned && this.logicalPeers(pinned).length > 0) return null
    if (!pinned || this.staleMsOf(pinned) === null) return pinned
    const fresh = [...this.apps.values()]
      .filter((session) => this.staleMsOf(session) === null)
      .sort(compareSessionRecency)[0]
    return fresh ?? pinned
  }

  private sessionSummaries(): SessionSummary[] {
    const current = this.currentSession()
    return [...this.apps.values()].sort(compareSessionRecency).map((session) => {
      const staleMs = this.staleMsOf(session)
      const collisionWithSessionIds = this.logicalPeers(session).map((peer) => peer.sessionId)
      return {
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
        logicalSessionCollision: collisionWithSessionIds.length > 0,
        collisionWithSessionIds,
        ...(session.forkedFromLogicalSessionId === undefined
          ? {}
          : { forkedFromLogicalSessionId: session.forkedFromLogicalSessionId }),
        app: session.app,
        domains: session.capabilities,
        toolCount: catalogOf(session).length,
        connectedAt: session.connectedAt,
        ready: session.readyAt !== undefined,
        ...(session.readyAt === undefined ? {} : { readyAt: session.readyAt }),
        current: session.sessionId === current?.sessionId,
        ...(staleMs === null ? {} : { staleMs }),
      }
    })
  }

  private hasSession(sessionId?: string): boolean {
    return sessionId ? this.resolveSession(sessionId) !== null : this.apps.size > 0
  }

  private hasReadySession(sessionId?: string): boolean {
    const session = sessionId ? this.resolveSession(sessionId) : this.currentSession()
    return session?.readyAt !== undefined
  }

  /** Resolves physical ids, reload-stable logical ids, and unique human names. */
  private resolveSession(target: string): AppSession | null {
    let physicalId = target
    const visited = new Set<string>()
    while (this.sessionSuccessors.has(physicalId) && !visited.has(physicalId)) {
      visited.add(physicalId)
      physicalId = this.sessionSuccessors.get(physicalId) ?? physicalId
    }
    const physical = this.apps.get(physicalId)
    if (physical) return physical

    const logical = [...this.apps.values()].filter((session) => session.logicalSessionId === target)
    if (logical.length === 1) return logical[0] ?? null

    const named = [...this.apps.values()].filter((session) => session.sessionName === target)
    return named.length === 1 ? (named[0] ?? null) : null
  }

  private logicalPeers(session: AppSession): AppSession[] {
    if (!session.logicalSessionId) return []
    return [...this.apps.values()].filter(
      (candidate) =>
        candidate.sessionId !== session.sessionId &&
        candidate.logicalSessionId === session.logicalSessionId,
    )
  }

  private statusWarnings(): string[] {
    const collisions = new Map<string, string[]>()
    for (const session of this.apps.values()) {
      if (!session.logicalSessionId) continue
      const sessions = collisions.get(session.logicalSessionId) ?? []
      sessions.push(session.sessionId)
      collisions.set(session.logicalSessionId, sessions)
    }
    return [...collisions]
      .filter(([, sessions]) => sessions.length > 1)
      .map(
        ([logicalSessionId, sessions]) =>
          `Logical session collision ${JSON.stringify(logicalSessionId)} across ${sessions.join(', ')}; implicit and logical-id routing is paused until the cloned document is auto-forked.`,
      )
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
        const previousLogicalSessionId = existing?.logicalSessionId
        const now = Date.now()
        if (existing && existing.socket !== socket) {
          // Requests in flight on the replaced socket will never get a response.
          this.failPendingForSession(
            message.sessionId,
            'app reconnected — the previous connection was replaced; retry the call',
          )
          existing.socket.close()
        }
        const latest = message.logicalSessionId
          ? this.latestDocuments.get(message.logicalSessionId)
          : undefined
        const concurrentLogicalDocument = message.logicalSessionId
          ? [...this.apps.values()].some(
              (session) =>
                session.sessionId !== message.sessionId &&
                session.logicalSessionId === message.logicalSessionId,
            )
          : false
        const replacesLatest =
          !concurrentLogicalDocument &&
          (latest === undefined ||
            latest.sessionId === message.sessionId ||
            (message.documentGeneration ?? 0) >= (latest.documentGeneration ?? 0))
        const predecessorSessionId =
          replacesLatest && latest?.sessionId !== message.sessionId ? latest?.sessionId : undefined
        if (predecessorSessionId) {
          const predecessor = this.apps.get(predecessorSessionId)
          if (predecessor) predecessor.successorSessionId = message.sessionId
          this.recordSessionSuccessor(predecessorSessionId, message.sessionId)
        }
        if (message.logicalSessionId && replacesLatest) {
          this.recordLatestDocument(message.logicalSessionId, {
            sessionId: message.sessionId,
            documentGeneration: message.documentGeneration,
            connectedAt: existing?.connectedAt ?? now,
          })
        }
        this.apps.set(message.sessionId, {
          socket,
          sessionId: message.sessionId,
          logicalSessionId: message.logicalSessionId,
          documentGeneration: message.documentGeneration,
          sessionName: message.sessionName,
          predecessorSessionId: existing?.predecessorSessionId ?? predecessorSessionId,
          successorSessionId: existing?.successorSessionId,
          forkedFromLogicalSessionId: existing?.forkedFromLogicalSessionId,
          app: message.app,
          capabilities: message.capabilities,
          tools: message.tools,
          // First-connect time survives re-hellos (tool refreshes, reconnects), so a background tab can't steal recency.
          connectedAt: existing?.connectedAt ?? now,
          readyAt: existing?.readyAt,
          // A re-hello from a once-heartbeating session is a live JS turn (reload, reconnect, or tool refresh), so clear stale/busy state immediately.
          lastHeartbeatAt: existing?.lastHeartbeatAt === undefined ? undefined : now,
        })
        if (previousLogicalSessionId && previousLogicalSessionId !== message.logicalSessionId) {
          this.refreshLatestDocument(previousLogicalSessionId)
        }
        if (!existing && replacesLatest) {
          this.currentSessionId = message.sessionId
          this.log(
            'info',
            `app connected: ${message.app.name ?? message.sessionId} (${this.apps.size} session${this.apps.size === 1 ? '' : 's'})`,
          )
        }
        const registered = this.apps.get(message.sessionId)
        if (registered) this.scheduleLogicalCollision(registered)
        for (const notify of [...this.connectionWaiters]) notify()
        this.broadcastStatus()
        return
      }
      case 'app/ready': {
        const session = this.apps.get(message.sessionId)
        if (!session || session.socket !== socket) return
        session.readyAt ??= Date.now()
        if (session.lastHeartbeatAt !== undefined) session.lastHeartbeatAt = Date.now()
        for (const notify of [...this.connectionWaiters]) notify()
        this.broadcastStatus()
        return
      }
      case 'app/event':
      case 'app/snapshot':
        this.markSessionAlive(socket, true)
        return
      case 'app/heartbeat': {
        const session = this.apps.get(message.sessionId)
        if (session) {
          const now = Date.now()
          const becameReady = session.readyAt === undefined
          session.lastHeartbeatAt = now
          // Backward compatibility: pre-readiness clients prove collector startup by reaching their heartbeat loop.
          session.readyAt ??= now
          for (const notify of [...this.connectionWaiters]) notify()
          if (becameReady) this.broadcastStatus()
        }
        return
      }
      case 'app/response': {
        this.markSessionAlive(socket, true)
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.clearPendingTimers(pending)
        this.pending.delete(message.id)
        pending.settle({
          ok: message.ok,
          result: message.result,
          error: message.error,
          errorCode: message.ok ? undefined : (message.errorCode ?? 'tool-error'),
        })
        return
      }
    }
  }

  private markSessionAlive(socket: WebSocket, impliesReady = false): void {
    const session = [...this.apps.values()].find((candidate) => candidate.socket === socket)
    if (session && impliesReady) session.readyAt ??= Date.now()
    if (session?.lastHeartbeatAt !== undefined) session.lastHeartbeatAt = Date.now()
  }

  private recordSessionSuccessor(predecessorId: string, successorId: string): void {
    this.sessionSuccessors.delete(predecessorId)
    this.sessionSuccessors.set(predecessorId, successorId)
    while (this.sessionSuccessors.size > MAX_SESSION_SUCCESSORS) {
      const oldest = this.sessionSuccessors.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.sessionSuccessors.delete(oldest)
    }
  }

  private recordLatestDocument(logicalSessionId: string, document: LatestDocument): void {
    this.latestDocuments.delete(logicalSessionId)
    this.latestDocuments.set(logicalSessionId, document)
    while (this.latestDocuments.size > MAX_SESSION_SUCCESSORS) {
      const oldest = this.latestDocuments.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.latestDocuments.delete(oldest)
    }
  }

  private refreshLatestDocument(logicalSessionId: string): void {
    const latest = [...this.apps.values()]
      .filter((session) => session.logicalSessionId === logicalSessionId)
      .sort(compareSessionRecency)[0]
    if (!latest) {
      this.latestDocuments.delete(logicalSessionId)
      return
    }
    this.recordLatestDocument(logicalSessionId, {
      sessionId: latest.sessionId,
      documentGeneration: latest.documentGeneration,
      connectedAt: latest.connectedAt,
    })
  }

  private scheduleLogicalCollision(session: AppSession): void {
    const previousTimer = this.logicalCollisionTimers.get(session.sessionId)
    if (previousTimer) clearTimeout(previousTimer)
    this.logicalCollisionTimers.delete(session.sessionId)
    if (!session.logicalSessionId || this.logicalPeers(session).length === 0) return

    const expectedLogicalSessionId = session.logicalSessionId
    const timer = setTimeout(
      () => this.autoForkLogicalCollision(session.sessionId, expectedLogicalSessionId),
      this.logicalCollisionGraceMs,
    )
    unrefTimer(timer)
    this.logicalCollisionTimers.set(session.sessionId, timer)
    this.log('warn', 'logical session collision detected', {
      logicalSessionId: expectedLogicalSessionId,
      sessionId: session.sessionId,
      collisionWithSessionIds: this.logicalPeers(session).map((peer) => peer.sessionId),
    })
  }

  private autoForkLogicalCollision(sessionId: string, expectedLogicalSessionId: string): void {
    this.logicalCollisionTimers.delete(sessionId)
    const session = this.apps.get(sessionId)
    if (!session || session.logicalSessionId !== expectedLogicalSessionId) return
    const collisionWithSessionIds = this.logicalPeers(session).map((peer) => peer.sessionId)
    if (collisionWithSessionIds.length === 0) return

    const logicalSessionId = newId()
    session.logicalSessionId = logicalSessionId
    session.documentGeneration = 1
    session.forkedFromLogicalSessionId = expectedLogicalSessionId
    this.refreshLatestDocument(expectedLogicalSessionId)
    this.recordLatestDocument(logicalSessionId, {
      sessionId,
      documentGeneration: 1,
      connectedAt: session.connectedAt,
    })
    this.send(session.socket, {
      kind: 'bridge/session-fork',
      expectedLogicalSessionId,
      logicalSessionId,
      documentGeneration: 1,
      reason: 'logical-session-collision',
      collisionWithSessionIds,
    })
    this.log('warn', 'auto-forked cloned logical session', {
      sessionId,
      expectedLogicalSessionId,
      logicalSessionId,
    })
    this.broadcastStatus()
  }

  private promoteLogicalSuccessor(closed: AppSession): void {
    if (!closed.logicalSessionId) return
    const remaining = [...this.apps.values()]
      .filter((session) => session.logicalSessionId === closed.logicalSessionId)
      .sort(compareSessionRecency)
    if (remaining.length !== 1) return
    const successor = remaining[0]
    if (!successor) return
    successor.predecessorSessionId ??= closed.sessionId
    this.recordSessionSuccessor(closed.sessionId, successor.sessionId)
    this.recordLatestDocument(closed.logicalSessionId, {
      sessionId: successor.sessionId,
      documentGeneration: successor.documentGeneration,
      connectedAt: successor.connectedAt,
    })
  }

  private clearPendingTimers(pending: PendingRequest): void {
    clearTimeout(pending.timer)
    if (pending.busyTimer) clearTimeout(pending.busyTimer)
  }

  private handleAgentMessage(socket: WebSocket, message: AgentMessage): void {
    switch (message.kind) {
      case 'agent/ping':
        this.send(socket, { kind: 'bridge/pong', id: message.id })
        return
      case 'agent/invoke':
        void this.handleInvoke(
          socket,
          message.id,
          message.tool,
          message.args,
          message.sessionId,
          message.timeoutMs,
        )
        return
    }
  }

  private async handleInvoke(
    agent: WebSocket,
    id: string,
    tool: string,
    args: unknown,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<void> {
    if (tool === devtoolsStatusContract.name) {
      const parsed = devtoolsStatusContract.input.safeParse(args ?? {})
      if (!parsed.success) {
        this.result(
          agent,
          id,
          false,
          undefined,
          formatToolValidationError(devtoolsStatusContract.name, parsed.error.issues),
          { errorCode: 'invalid-args' },
        )
        return
      }
      const target = sessionId ? this.resolveSession(sessionId) : this.currentSession()
      if (sessionId && !target) {
        this.result(agent, id, false, undefined, this.unknownSessionError(sessionId), {
          errorCode: 'unknown-session',
        })
        return
      }
      this.result(agent, id, true, {
        connected: this.apps.size > 0,
        ready: target?.readyAt !== undefined,
        sessionId: target?.sessionId ?? null,
        app: target?.app ?? null,
        domains: target?.capabilities ?? [],
        toolCount: catalogOf(target).length,
        ...(parsed.data.includeTools ? { tools: catalogOf(target) } : {}),
        sessions: this.sessionSummaries(),
        warnings: this.statusWarnings(),
      })
      return
    }

    if (isCaptureTool(tool)) {
      const response = await this.captures.invoke(tool, args, sessionId)
      this.result(
        agent,
        id,
        response.ok,
        response.ok ? response.result : undefined,
        response.ok ? undefined : response.error,
        response.ok ? undefined : { errorCode: response.errorCode },
      )
      return
    }

    if (isInteractionTool(tool)) {
      const response = await this.interactions.invoke(tool, args, sessionId)
      this.result(
        agent,
        id,
        response.ok,
        response.ok ? response.result : undefined,
        response.ok ? undefined : response.error,
        response.ok ? undefined : { errorCode: response.errorCode },
      )
      return
    }

    if (tool === devtoolsWaitContract.name) {
      await this.handleWait(agent, id, args, sessionId)
      return
    }

    this.forwardToApp(agent, id, tool, args, sessionId, timeoutMs)
  }

  private async handleWait(
    agent: WebSocket,
    id: string,
    args: unknown,
    sessionId?: string,
  ): Promise<void> {
    const parsed = devtoolsWaitContract.input.safeParse(args ?? {})
    if (!parsed.success) {
      this.result(
        agent,
        id,
        false,
        undefined,
        formatToolValidationError(devtoolsWaitContract.name, parsed.error.issues),
        { errorCode: 'invalid-args' },
      )
      return
    }
    const input = parsed.data
    const started = Date.now()
    const finish = (check: WaitCheck, timeoutReason = 'timeout') =>
      this.result(agent, id, true, {
        ok: check.state === 'met',
        condition: input.condition,
        waitedMs: Date.now() - started,
        ...(check.state === 'met'
          ? {}
          : { reason: check.state === 'failed' ? check.reason : timeoutReason }),
        ...(check.query === undefined ? {} : { query: check.query }),
        validConditions: [...WAIT_CONDITIONS],
        ...(check.lastObserved === undefined ? {} : { lastObserved: check.lastObserved }),
        ...(check.domains === undefined ? {} : { domains: check.domains }),
      })

    if (input.condition === 'connected' || input.condition === 'ready') {
      const waitFor =
        input.condition === 'ready'
          ? this.waitForReady.bind(this)
          : this.waitForConnection.bind(this)
      const connected = await waitFor(input.timeoutMs, sessionId)
      finish({
        state: connected ? 'met' : 'pending',
        lastObserved: {
          connected: this.hasSession(sessionId),
          ready: this.hasReadySession(sessionId),
        },
      })
      return
    }

    if (
      !this.hasSession(sessionId) &&
      !(await this.waitForConnection(input.timeoutMs, sessionId))
    ) {
      finish({ state: 'failed', reason: 'no app connected' })
      return
    }

    const check = await this.pollCondition(
      input,
      input.timeoutMs - (Date.now() - started),
      sessionId,
    )
    finish(check)
  }

  private async pollCondition(
    input: WaitInput,
    remainingMs: number,
    sessionId?: string,
  ): Promise<WaitCheck> {
    const deadline = Date.now() + Math.max(0, remainingMs)
    const pollState: WaitPollState = {
      reactCommit: null,
      reactChangedAt: Date.now(),
      frameCheck: null,
    }
    let lastCheck: WaitCheck = { state: 'pending' }
    while (Date.now() < deadline) {
      const check = await this.checkCondition(input, sessionId, pollState)
      lastCheck = check
      if (check.state !== 'pending') return check
      await delay(POLL_INTERVAL_MS)
    }
    return lastCheck
  }

  private async settleInteraction(
    session: AppSession,
    domains: WaitDomain[],
    quietMs: number,
    timeoutMs: number,
  ): Promise<InteractionSettleResult> {
    const started = Date.now()
    const check = await this.pollCondition(
      { condition: 'settled', domains, quietMs },
      timeoutMs,
      session.sessionId,
    )
    return {
      ok: check.state === 'met',
      waitedMs: Date.now() - started,
      ...(check.state === 'met'
        ? {}
        : { reason: check.state === 'failed' ? check.reason : 'timeout' }),
      domains: check.domains ?? {},
    }
  }

  private async checkCondition(
    input: WaitInput,
    sessionId: string | undefined,
    pollState: WaitPollState,
  ): Promise<WaitCheck> {
    if (input.condition === 'react-quiet' || input.condition === 'settled') {
      return this.checkSettle(input, sessionId, pollState)
    }
    if (input.condition === 'component') {
      const res = await this.appRequest(
        'react_find_components',
        { query: input.name ?? '', limit: 1 },
        sessionId,
      )
      const matches = matchesOf(res.result)
      return {
        state: res.ok && matches !== undefined && matches.length > 0 ? 'met' : 'pending',
        lastObserved: { matches: matches?.length ?? null },
      }
    }
    if (input.condition === 'query-settled') {
      if (input.queryHash !== undefined || input.queryKey !== undefined) {
        const selector =
          input.queryHash === undefined
            ? { queryKey: input.queryKey }
            : { queryHash: input.queryHash }
        const res = await this.appRequest('query_get', selector, sessionId)
        const query = queryStateOf(res.result)
        if (!res.ok || !query) return { state: 'pending' }
        const match = queryIdentity(query)
        return {
          state: query.fetchStatus === 'idle' ? 'met' : 'pending',
          ...(match === undefined ? {} : { query: match }),
          lastObserved: { fetchStatus: query.fetchStatus ?? null },
        }
      }

      if (input.name) {
        const res = await this.appRequest('query_list', { limit: 500 }, sessionId)
        const queries = parseQueryList(res.result)
        if (!res.ok || !queries || queries.length === 0) return { state: 'pending' }
        const relevant = queries.filter((query) => legacyQueryMatches(query, input.name ?? ''))
        if (relevant.length > 1) {
          return {
            state: 'failed',
            reason: `query selector ${JSON.stringify(input.name)} is ambiguous (${relevant.length} exact matches); use queryHash or queryKey from query_list`,
          }
        }
        const query = relevant[0]
        if (!query) return { state: 'pending' }
        const match = queryIdentity(query)
        return {
          state: query.fetchStatus === 'idle' ? 'met' : 'pending',
          ...(match === undefined ? {} : { query: match }),
          lastObserved: { fetchStatus: query.fetchStatus ?? null },
        }
      }
      const fetching = await this.appRequest('query_is_fetching', {}, sessionId)
      const state = queryStateOf(fetching.result)
      return {
        state: fetching.ok && state?.fetching === 0 && state.mutating === 0 ? 'met' : 'pending',
        lastObserved: {
          fetching: state?.fetching ?? null,
          mutating: state?.mutating ?? null,
        },
      }
    }
    if (input.condition === 'navigation') {
      const res = await this.appRequest('router_get_state', {}, sessionId)
      const state = routerStateOf(res.result)
      if (!res.ok || !state) return { state: 'pending' }
      return {
        state:
          (input.name ? state.pathname === input.name : true) && !state.isLoading
            ? 'met'
            : 'pending',
        lastObserved: {
          pathname: state.pathname ?? null,
          isLoading: state.isLoading ?? null,
        },
      }
    }
    return { state: 'pending' }
  }

  private async checkSettle(
    input: WaitInput,
    sessionId: string | undefined,
    pollState: WaitPollState,
  ): Promise<WaitCheck> {
    const requested: WaitDomain[] = input.condition === 'react-quiet' ? ['react'] : input.domains
    const domains: Partial<Record<WaitDomain, WaitDomainCheck>> = {}
    for (const domain of requested) {
      domains[domain] = await this.checkSettleDomain(domain, input, sessionId, pollState)
    }
    const checks = Object.values(domains)
    const unsupported = checks.find(
      (check) => check?.status === 'unsupported' || check?.status === 'failed',
    )
    const state = unsupported
      ? 'failed'
      : checks.every((check) => check?.status === 'met')
        ? 'met'
        : 'pending'
    return {
      state,
      ...(unsupported?.reason === undefined ? {} : { reason: unsupported.reason }),
      domains,
      lastObserved: Object.fromEntries(
        Object.entries(domains).map(([domain, check]) => [domain, check?.lastObserved ?? null]),
      ),
    }
  }

  private async checkSettleDomain(
    domain: WaitDomain,
    input: WaitInput,
    sessionId: string | undefined,
    pollState: WaitPollState,
  ): Promise<WaitDomainCheck> {
    const session = sessionId ? this.resolveSession(sessionId) : this.currentSession()
    const unsupported = (tool: string): WaitDomainCheck => ({
      status: 'unsupported',
      reason: `Domain ${domain} requires unavailable tool ${tool}.`,
    })
    if (domain === 'network') {
      return {
        status: 'unsupported',
        reason: 'Generic network quiet is not instrumented by this app.',
      }
    }
    if (domain === 'react') {
      if (!session || !toolDescriptor(session, 'react_get_renders')) {
        return unsupported('react_get_renders')
      }
      const response = await this.appRequest(
        'react_get_renders',
        { sort: 'renders', limit: 1, appOnly: false },
        sessionId,
      )
      const result = recordOf(response.result)
      const commit = result && numberField(result, 'documentCommitId')
      if (!response.ok || commit === null) {
        return { status: 'pending', reason: response.error, lastObserved: null }
      }
      const now = Date.now()
      if (pollState.reactCommit !== commit) {
        pollState.reactCommit = commit
        pollState.reactChangedAt = now
      }
      const quietForMs = now - pollState.reactChangedAt
      return {
        status: quietForMs >= input.quietMs ? 'met' : 'pending',
        lastObserved: { documentCommitId: commit, quietForMs, requiredQuietMs: input.quietMs },
      }
    }
    if (domain === 'query') {
      if (!session || !toolDescriptor(session, 'query_is_fetching')) {
        return unsupported('query_is_fetching')
      }
      const response = await this.appRequest('query_is_fetching', {}, sessionId)
      const result = recordOf(response.result)
      const fetching = result ? numberField(result, 'fetching') : null
      const mutating = result ? (numberField(result, 'mutating') ?? 0) : null
      return {
        status: response.ok && fetching === 0 && mutating === 0 ? 'met' : 'pending',
        lastObserved: { fetching, mutating },
      }
    }
    if (domain === 'router') {
      if (!session || !toolDescriptor(session, 'router_get_state')) {
        return unsupported('router_get_state')
      }
      const response = await this.appRequest('router_get_state', {}, sessionId)
      const result = routerStateOf(response.result)
      return {
        status: response.ok && result?.isLoading === false ? 'met' : 'pending',
        lastObserved: {
          isLoading: result?.isLoading ?? null,
          pathname: result?.pathname ?? null,
        },
      }
    }
    if (!session || !toolDescriptor(session, 'browser_fps')) return unsupported('browser_fps')
    if (pollState.frameCheck?.status === 'met') return pollState.frameCheck
    const response = await this.appRequest('browser_fps', { durationMs: 250 }, sessionId)
    const result = recordOf(response.result)
    const comparable = result?.comparable === true
    pollState.frameCheck = {
      status: response.ok && comparable ? 'met' : 'pending',
      reason: comparable
        ? undefined
        : 'Frame sample is hidden, throttled, sparse, or mode-shifted.',
      lastObserved: {
        comparable,
        avgFps: result ? numberField(result, 'avgFps') : null,
        notComparableReasons: Array.isArray(result?.notComparableReasons)
          ? result.notComparableReasons
          : [],
      },
    }
    return pollState.frameCheck
  }

  private forwardToApp(
    agent: WebSocket,
    id: string,
    tool: string,
    args: unknown,
    sessionId?: string,
    timeoutMs?: number,
  ): void {
    this.sendAppRequest(
      id,
      tool,
      args,
      (response) =>
        this.result(agent, id, response.ok, response.result, response.error, {
          errorCode: response.errorCode,
          retryInMs: response.retryInMs,
          busyTelemetry: response.busyTelemetry,
        }),
      sessionId,
      timeoutMs,
    )
  }

  private appRequest(tool: string, args: unknown, sessionId?: string): Promise<AppResponse> {
    return new Promise((resolve) => this.sendAppRequest(newId(), tool, args, resolve, sessionId))
  }

  private appRequestForSession(
    tool: string,
    args: unknown,
    session: AppSession,
  ): Promise<AppResponse> {
    return new Promise((resolve) =>
      this.sendAppRequest(newId(), tool, args, resolve, undefined, undefined, session),
    )
  }

  private clampTimeout(timeoutMs?: number): number {
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return this.requestTimeoutMs
    return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, Math.round(timeoutMs)))
  }

  private sendAppRequest(
    id: string,
    tool: string,
    args: unknown,
    settle: (response: AppResponse) => void,
    sessionId?: string,
    timeoutMs?: number,
    exactSession?: AppSession,
  ): void {
    const exactCurrent = exactSession ? this.apps.get(exactSession.sessionId) : undefined
    const session = exactSession
      ? exactCurrent?.socket === exactSession.socket
        ? exactCurrent
        : null
      : sessionId
        ? this.resolveSession(sessionId)
        : this.currentSession()
    if (!session) {
      settle({
        ok: false,
        errorCode: sessionId && !exactSession ? 'unknown-session' : 'not-connected',
        error: exactSession
          ? 'The target app document disconnected during the request.'
          : sessionId
            ? this.unknownSessionError(sessionId)
            : 'No app connected. Run your dev server with the Genie Vite plugin.',
      })
      return
    }
    const fullTimeout = this.clampTimeout(timeoutMs)
    const timer = setTimeout(() => {
      const pending = this.pending.get(id)
      if (pending) this.clearPendingTimers(pending)
      this.pending.delete(id)
      settle({
        ok: false,
        errorCode: 'timeout',
        error: `Tool "${tool}" timed out after ${fullTimeout}ms — the app tab may be reloading or its main thread busy; retry, or wait for it with devtools_wait`,
      })
    }, fullTimeout)
    const busyTimer = this.shouldBusyProbe(session, tool, timeoutMs)
      ? this.scheduleBusyProbe(id, session.sessionId, tool, settle)
      : null
    this.pending.set(id, {
      settle,
      timer,
      busyTimer,
      sessionId: session.sessionId,
    })
    this.send(session.socket, { kind: 'bridge/request', id, tool, args })
  }

  private shouldBusyProbe(session: AppSession, tool: string, timeoutMs?: number): boolean {
    if (timeoutMs !== undefined) return false
    const descriptor = toolDescriptor(session, tool)
    if (!descriptor) return true
    return descriptor.annotations?.readOnlyHint === true
  }

  /** Fast-fails a still-pending request when a once-heartbeating session has since gone quiet (main thread busy) — never for sessions that never beat. Re-arms until settle/timeout so a gap crossing the threshold after the first probe still fast-fails instead of racing the full timeout. */
  private scheduleBusyProbe(
    id: string,
    sessionId: string,
    tool: string,
    settle: (response: AppResponse) => void,
  ): ReturnType<typeof setTimeout> {
    const reprobeMs = Math.max(25, Math.min(500, this.busyProbeMs / 4))
    const probe = (): void => {
      const pending = this.pending.get(id)
      if (!pending) return
      const session = this.apps.get(sessionId)
      const lastBeat = session?.lastHeartbeatAt
      const gap = lastBeat === undefined ? 0 : Date.now() - lastBeat
      if (lastBeat === undefined || gap <= this.busyHeartbeatGapMs) {
        pending.busyTimer = setTimeout(probe, reprobeMs)
        return
      }
      this.clearPendingTimers(pending)
      this.pending.delete(id)
      // Past the stale threshold the app is not merely busy but likely reloading or hung; retrying won't help, so drop the retry hint and point at reload / an explicit timeoutMs.
      if (gap > this.sessionStaleMs) {
        settle({
          ok: false,
          errorCode: 'busy',
          error: `App unresponsive (no heartbeat for ${gap}ms) — likely reloading, frozen, or its JS thread is stuck; retrying won't help. Reload the app, or pass a larger timeoutMs to wait it out.`,
          busyTelemetry: this.busyTelemetry(sessionId, tool, gap),
        })
        return
      }
      settle({
        ok: false,
        errorCode: 'busy',
        retryInMs: BUSY_RETRY_MS,
        error: `App main thread busy (no heartbeat for ${gap}ms) — not a crash; retry shortly or reduce concurrent profilers. Tool "${tool}" was still pending; if this tool itself blocks the thread this long, pass a larger timeoutMs and retry.`,
        busyTelemetry: this.busyTelemetry(sessionId, tool, gap),
      })
    }
    return setTimeout(probe, this.busyProbeMs)
  }

  private busyTelemetry(sessionId: string, tool: string, gap: number): BusyTelemetry {
    const session = this.apps.get(sessionId)
    const descriptor = session ? toolDescriptor(session, tool) : undefined
    return {
      lastHeartbeatAgeMs: gap,
      queueDepth: Math.max(
        1,
        [...this.pending.values()].filter((pending) => pending.sessionId === sessionId).length,
      ),
      pendingWorkClass:
        descriptor?.annotations?.readOnlyHint === true
          ? 'instrumentation'
          : descriptor
            ? 'app'
            : 'unknown',
      tool,
    }
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

  private waitForReady(timeoutMs: number, sessionId?: string): Promise<boolean> {
    if (this.hasReadySession(sessionId)) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (ready: boolean) => {
        if (settled) return
        settled = true
        this.connectionWaiters.delete(waiter)
        clearTimeout(timer)
        resolve(ready)
      }
      const waiter = () => {
        if (this.hasReadySession(sessionId)) finish(true)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.connectionWaiters.add(waiter)
    })
  }

  private unknownSessionError(sessionId: string): string {
    const logical = [...this.apps.values()].filter(
      (session) => session.logicalSessionId === sessionId,
    )
    if (logical.length > 1) {
      return `Logical session ${JSON.stringify(sessionId)} has a live identity collision (${logical.map((session) => session.sessionId).join(', ')}). Wait for auto-fork, then choose a distinct logical or physical id from devtools_status.`
    }
    const named = [...this.apps.values()].filter((session) => session.sessionName === sessionId)
    if (named.length > 1) {
      return `Session name "${sessionId}" is ambiguous (${named.length} tabs). Use a physical or logical id from devtools_status.`
    }
    const targets = this.sessionSummaries()
      .flatMap((session) => [session.sessionId, session.logicalSessionId, session.sessionName])
      .filter((target): target is string => typeof target === 'string')
    return `Unknown session "${sessionId}". Connected targets: ${[...new Set(targets)].join(', ') || 'none'} — run devtools_status to list them.`
  }

  private failPendingForSession(sessionId: string, error: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue
      this.clearPendingTimers(pending)
      pending.settle({ ok: false, error, errorCode: 'not-connected' })
      this.pending.delete(id)
    }
  }

  private onClose(connection: Connection): void {
    this.connections.delete(connection.socket)
    const session = [...this.apps.values()].find((s) => s.socket === connection.socket)
    if (session) {
      this.apps.delete(session.sessionId)
      const collisionTimer = this.logicalCollisionTimers.get(session.sessionId)
      if (collisionTimer) clearTimeout(collisionTimer)
      this.logicalCollisionTimers.delete(session.sessionId)
      this.promoteLogicalSuccessor(session)
      this.log('info', `app disconnected: ${session.app.name ?? session.sessionId}`)
      this.failPendingForSession(session.sessionId, 'app disconnected')
      if (this.currentSessionId === session.sessionId) {
        const successor = this.resolveSession(session.sessionId)
        const next = successor ?? [...this.apps.values()].sort(compareSessionRecency)[0]
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
    extra?: { errorCode?: AgentErrorCode; retryInMs?: number; busyTelemetry?: BusyTelemetry },
  ): void {
    this.send(agent, {
      kind: 'bridge/result',
      id,
      ok,
      result,
      error,
      errorCode: extra?.errorCode,
      retryInMs: extra?.retryInMs,
      busyTelemetry: extra?.busyTelemetry,
    })
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

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
