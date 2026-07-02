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

/** One connected app session (a browser tab); the bridge routes to the most recent unless `agent/invoke.sessionId` targets one. */
export const sessionSummarySchema = z.object({
  sessionId: z.string(),
  app: appInfoSchema,
  domains: z.array(z.string()),
  toolCount: z.number(),
  connectedAt: z.number(),
  current: z.boolean(),
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>

// ── App (browser) → Bridge ──────────────────────────────────────────────────

export const appHelloSchema = z.object({
  kind: z.literal('app/hello'),
  protocol: z.number(),
  sessionId: z.string(),
  app: appInfoSchema,
  capabilities: z.array(z.string()),
  tools: z.array(toolDescriptorSchema),
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

export const appResponseSchema = z.object({
  kind: z.literal('app/response'),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

export const appMessageSchema = z.discriminatedUnion('kind', [
  appHelloSchema,
  appSnapshotSchema,
  appEventSchema,
  appResponseSchema,
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

export const appBoundMessageSchema = z.discriminatedUnion('kind', [
  bridgeRequestSchema,
  bridgePingSchema,
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
})

export const agentPingSchema = z.object({
  kind: z.literal('agent/ping'),
  id: z.string(),
})

export const agentMessageSchema = z.discriminatedUnion('kind', [agentInvokeSchema, agentPingSchema])
export type AgentMessage = z.infer<typeof agentMessageSchema>

// ── Bridge → Agent ──────────────────────────────────────────────────────────

export const bridgeResultSchema = z.object({
  kind: z.literal('bridge/result'),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

export const bridgeStatusSchema = z.object({
  kind: z.literal('bridge/status'),
  connected: z.boolean(),
  sessionId: z.string().nullable(),
  app: appInfoSchema.nullable(),
  domains: z.array(z.string()),
  tools: z.array(toolDescriptorSchema),
  sessions: z.array(sessionSummarySchema).default([]),
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
