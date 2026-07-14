import { z } from 'zod'
import { decodeFrame, encodeFrame } from './serialization'

type CryptoLike = {
  randomUUID?: () => string
  getRandomValues?: <T extends Uint8Array>(array: T) => T
}

/** v4 UUID; falls back when `crypto.randomUUID` is absent (non-secure contexts) — these ids are not security-sensitive. */
export const newId = (): string => {
  const cryptoLike = (globalThis as { crypto?: CryptoLike }).crypto
  if (typeof cryptoLike?.randomUUID === 'function') return cryptoLike.randomUUID()

  const bytes = new Uint8Array(16)
  if (typeof cryptoLike?.getRandomValues === 'function') cryptoLike.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  let hex = ''
  for (let i = 0; i < 16; i++) hex += (bytes[i] ?? 0).toString(16).padStart(2, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const toolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
})

/** Serializable description of a tool, advertised by the app so the surface can be discovered dynamically. */
export const toolDescriptorSchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  group: z.string(),
  inputJsonSchema: z.unknown().optional(),
  outputJsonSchema: z.unknown().optional(),
  annotations: toolAnnotationsSchema.optional(),
})
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>

export const appInfoSchema = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
  reactVersion: z.string().optional(),
  tanstack: z.record(z.string(), z.string()).optional(),
})
export type AppInfo = z.infer<typeof appInfoSchema>

const sessionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((name) => !hasControlCharacters(name), 'session name cannot contain control characters')

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })
}

export function normalizeSessionName(value: string | undefined): string | undefined {
  const parsed = sessionNameSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** One connected app session (a browser tab); the bridge routes to the most recent unless `agent/invoke.sessionId` targets one. */
export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  /** Reload-stable browser-tab identity. `--session` accepts this value as well as the physical session id. */
  logicalSessionId: z.string().optional(),
  /** Monotonic document number within a logical browser-tab session. */
  documentGeneration: z.number().int().positive().optional(),
  /** Optional human marker, normally sourced from the initial `_genie` URL parameter. */
  sessionName: sessionNameSchema.optional(),
  predecessorSessionId: z.string().optional(),
  successorSessionId: z.string().optional(),
  /** True only while multiple live documents advertise the same logical browser-tab identity. */
  logicalSessionCollision: z.boolean().default(false),
  /** Physical session IDs competing for the same logical identity. */
  collisionWithSessionIds: z.array(z.string()).default([]),
  /** Original logical identity when the hub auto-forked a cloned browser state. */
  forkedFromLogicalSessionId: z.string().optional(),
  app: appInfoSchema,
  domains: z.array(z.string()),
  toolCount: z.number(),
  connectedAt: z.number(),
  ready: z.boolean().default(true),
  readyAt: z.number().optional(),
  current: z.boolean(),
  /** Present when a heartbeat-capable session went silent (likely a dead tab context); default routing skips it while a fresh session exists. */
  staleMs: z.number().optional(),
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>

// ── App (browser) → Bridge ──────────────────────────────────────────────────

export const appHelloSchema = z.object({
  kind: z.literal('app/hello'),
  protocol: z.number(),
  sessionId: z.string(),
  logicalSessionId: z.string().optional(),
  documentGeneration: z.number().int().positive().optional(),
  sessionName: sessionNameSchema.optional(),
  app: appInfoSchema,
  capabilities: z.array(z.string()),
  tools: z.array(toolDescriptorSchema),
})

/** Sent after every collector has completed its synchronous startup work. */
export const appReadySchema = z.object({
  kind: z.literal('app/ready'),
  sessionId: z.string(),
})

export const appSnapshotSchema = z.object({
  kind: z.literal('app/snapshot'),
  domain: z.string(),
  data: z.unknown(),
  ts: z.number(),
})

export const appEventSchema = z.object({
  kind: z.literal('app/event'),
  domain: z.string(),
  event: z.unknown(),
  ts: z.number(),
})

const appErrorCodeSchema = z.enum(['invalid-args', 'tool-error'])

export const appResponseSchema = z.object({
  kind: z.literal('app/response'),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  errorCode: appErrorCodeSchema.optional(),
})

/** Liveness beacon sent on a fixed cadence while the app socket is open; a gap tells the bridge the main thread is busy, not crashed. */
export const appHeartbeatSchema = z.object({
  kind: z.literal('app/heartbeat'),
  sessionId: z.string(),
})

export const appMessageSchema = z.discriminatedUnion('kind', [
  appHelloSchema,
  appSnapshotSchema,
  appEventSchema,
  appResponseSchema,
  appHeartbeatSchema,
  appReadySchema,
])
export type AppMessage = z.infer<typeof appMessageSchema>

// ── Bridge → App ────────────────────────────────────────────────────────────

export const bridgeRequestSchema = z.object({
  kind: z.literal('bridge/request'),
  id: z.string(),
  tool: z.string(),
  args: z.unknown(),
})

export const bridgePingSchema = z.object({
  kind: z.literal('bridge/ping'),
  id: z.string(),
})

/** Tells a cloned browser document to persist a fresh logical identity and re-announce itself. */
export const bridgeSessionForkSchema = z.object({
  kind: z.literal('bridge/session-fork'),
  expectedLogicalSessionId: z.string(),
  logicalSessionId: z.string(),
  documentGeneration: z.number().int().positive(),
  reason: z.literal('logical-session-collision'),
  collisionWithSessionIds: z.array(z.string()),
})

export const appBoundMessageSchema = z.discriminatedUnion('kind', [
  bridgeRequestSchema,
  bridgePingSchema,
  bridgeSessionForkSchema,
])
export type AppBoundMessage = z.infer<typeof appBoundMessageSchema>

// ── Agent (CLI) → Bridge ────────────────────────────────────────────────────

export const agentInvokeSchema = z.object({
  kind: z.literal('agent/invoke'),
  id: z.string(),
  tool: z.string(),
  args: z.unknown(),
  sessionId: z
    .string()
    .optional()
    .describe('Target app session; defaults to the most recently connected.'),
  timeoutMs: z
    .number()
    .optional()
    .describe('Per-call full-timeout override; the bridge clamps it to [1000, 120000].'),
})

export const agentPingSchema = z.object({
  kind: z.literal('agent/ping'),
  id: z.string(),
})

export const agentMessageSchema = z.discriminatedUnion('kind', [agentInvokeSchema, agentPingSchema])
export type AgentMessage = z.infer<typeof agentMessageSchema>

// ── Bridge → Agent ──────────────────────────────────────────────────────────

/** Machine-readable failure classes so an agent can branch (retry vs. fix args vs. give up) without parsing prose. */
export const agentErrorCodeSchema = z.enum([
  'not-connected',
  'unknown-session',
  'busy',
  'timeout',
  'invalid-args',
  'tool-error',
])
export type AgentErrorCode = z.infer<typeof agentErrorCodeSchema>
export const AGENT_ERROR_CODES = agentErrorCodeSchema.options

export const bridgeResultSchema = z.object({
  kind: z.literal('bridge/result'),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  errorCode: agentErrorCodeSchema.optional(),
  retryInMs: z.number().optional(),
  busyTelemetry: z
    .object({
      lastHeartbeatAgeMs: z.number().nonnegative(),
      queueDepth: z.number().int().nonnegative(),
      pendingWorkClass: z.enum(['app', 'instrumentation', 'unknown']),
      tool: z.string(),
    })
    .optional(),
})
export type BusyTelemetry = NonNullable<z.infer<typeof bridgeResultSchema>['busyTelemetry']>

export const bridgeStatusSchema = z.object({
  kind: z.literal('bridge/status'),
  connected: z.boolean(),
  /** Defaults true when decoding legacy bridge frames, where hello implied readiness. */
  ready: z.boolean().default(true),
  sessionId: z.string().nullable(),
  app: appInfoSchema.nullable(),
  domains: z.array(z.string()),
  tools: z.array(toolDescriptorSchema),
  sessions: z.array(sessionSummarySchema).default([]),
  warnings: z.array(z.string()).default([]),
})
export type BridgeStatusMessage = z.infer<typeof bridgeStatusSchema>

export const bridgePongSchema = z.object({
  kind: z.literal('bridge/pong'),
  id: z.string(),
})

export const agentBoundMessageSchema = z.discriminatedUnion('kind', [
  bridgeResultSchema,
  bridgeStatusSchema,
  bridgePongSchema,
])
export type AgentBoundMessage = z.infer<typeof agentBoundMessageSchema>

// ── Codec helpers (superjson + runtime validation at each boundary) ──────────

export const encodeMessage = (message: unknown): string => encodeFrame(message)

export const decodeAppBoundMessage = (raw: string): AppBoundMessage =>
  appBoundMessageSchema.parse(decodeFrame(raw))
export const decodeAgentBoundMessage = (raw: string): AgentBoundMessage =>
  agentBoundMessageSchema.parse(decodeFrame(raw))
