import { z } from 'zod'
import { defineAgentToolContract } from './contract'
import {
  appInfoSchema,
  sessionSummarySchema,
  type ToolDescriptor,
  toolDescriptorSchema,
} from './protocol'

/** Meta tools are answered by the bridge itself (not the app), so they work before an app connects — as `devtools_wait` needs. */
export const devtoolsStatusContract = defineAgentToolContract({
  name: 'devtools_status',
  title: 'DevTools status',
  description:
    'Check whether a Genie-instrumented React + TanStack app is connected, and report its session, React/TanStack versions, available data domains, and tool count. `sessions` lists every connected tab; tool calls hit the `current` one unless a session is targeted explicitly (CLI: --session <id>).',
  group: 'meta',
  input: z.object({}),
  output: z.object({
    connected: z.boolean(),
    sessionId: z.string().nullable(),
    app: appInfoSchema.nullable(),
    domains: z.array(z.string()),
    toolCount: z.number(),
    tools: z.array(toolDescriptorSchema).optional(),
    sessions: z.array(sessionSummarySchema),
  }),
  annotations: { readOnlyHint: true },
})

export const WAIT_CONDITIONS = ['connected', 'component', 'query-settled', 'navigation'] as const
export type WaitCondition = (typeof WAIT_CONDITIONS)[number]

export const devtoolsWaitContract = defineAgentToolContract({
  name: 'devtools_wait',
  title: 'Wait for a condition',
  description:
    'Block until a runtime condition holds so the agent can synchronize instead of polling: the app connecting, a component mounting, a query settling, or a navigation completing.',
  group: 'meta',
  input: z.object({
    condition: z.enum(WAIT_CONDITIONS).default('connected'),
    name: z
      .string()
      .optional()
      .describe('Component name, query key, or route to wait for, when relevant to the condition.'),
    timeoutMs: z.number().int().positive().max(60_000).default(10_000),
  }),
  output: z.object({
    ok: z.boolean(),
    waitedMs: z.number(),
    reason: z.string().optional(),
  }),
  annotations: { readOnlyHint: true },
})

export const metaTools = [devtoolsStatusContract, devtoolsWaitContract]

/** Catalog entries for the meta tools, so `tools` listings and toolCount agree on the same set. */
export const metaToolDescriptors: ToolDescriptor[] = metaTools.map((contract) => ({
  name: contract.name,
  title: contract.title,
  description: contract.description,
  group: contract.group,
  inputJsonSchema: z.toJSONSchema(contract.input, { io: 'input' }),
}))
