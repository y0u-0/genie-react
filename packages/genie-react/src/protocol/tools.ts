import { z } from 'zod'
import { defineAgentToolContract } from './contract'
import {
  appInfoSchema,
  sessionSummarySchema,
  type ToolDescriptor,
  toolDescriptorSchema,
} from './protocol'

export const CAPTURE_SCHEMA_VERSION = '1.0' as const
export const CAPTURE_DOMAINS = [
  'react',
  'effects',
  'query',
  'router',
  'memory',
  'performance',
] as const
export type CaptureDomain = (typeof CAPTURE_DOMAINS)[number]

const captureDomainSchema = z.enum(CAPTURE_DOMAINS)

const captureToolResultSchema = z.object({
  status: z.enum(['ok', 'unavailable', 'error']),
  capturedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

const captureSectionSchema = z.object({
  status: z.enum(['ok', 'partial', 'unavailable', 'error']),
  tools: z.record(z.string(), captureToolResultSchema),
})

export const captureArtifactSchema = z.object({
  schemaVersion: z.literal(CAPTURE_SCHEMA_VERSION),
  captureId: z.string(),
  name: z.string(),
  createdAt: z.string().datetime(),
  session: z.object({
    sessionId: z.string(),
    logicalSessionId: z.string().optional(),
    documentGeneration: z.number().int().positive().optional(),
    sessionName: z.string().optional(),
    app: appInfoSchema,
  }),
  include: z.array(captureDomainSchema),
  consistency: z.object({
    kind: z.enum(['react-commit-stable', 'best-effort']),
    attempts: z.number().int().positive(),
    reactCommit: z.number().int().nonnegative().nullable(),
    reason: z.string(),
  }),
  sections: z.partialRecord(captureDomainSchema, captureSectionSchema),
  complete: z.boolean(),
  warnings: z.array(z.string()),
  sizeBytes: z.number().int().nonnegative(),
})
export type CaptureArtifact = z.infer<typeof captureArtifactSchema>

export const CAPTURE_METRICS = [
  'react.commits',
  'react.renders',
  'react.updates',
  'react.unnecessary',
  'react.selfTimeMs',
  'effects.hot',
  'query.pending',
  'memory.usedHeapBytes',
  'performance.avgFps',
  'performance.droppedFrames',
] as const
export type CaptureMetric = (typeof CAPTURE_METRICS)[number]
const captureMetricSchema = z.enum(CAPTURE_METRICS)

const captureMetricBudgetSchema = z
  .object({
    metric: captureMetricSchema,
    maxRegressionPct: z.number().nonnegative().optional(),
    maxValue: z.number().optional(),
    minValue: z.number().optional(),
  })
  .strict()
  .refine(
    (budget) =>
      budget.maxRegressionPct !== undefined ||
      budget.maxValue !== undefined ||
      budget.minValue !== undefined,
    'a budget requires maxRegressionPct, maxValue, or minValue',
  )
  .refine(
    (budget) =>
      budget.minValue === undefined ||
      budget.maxValue === undefined ||
      budget.minValue <= budget.maxValue,
    'minValue cannot exceed maxValue',
  )

const captureMetricStatsSchema = z.object({
  samples: z.number().int().nonnegative(),
  median: z.number().nullable(),
  p95: z.number().nullable(),
  mad: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
})

const captureComparisonMetricSchema = z.object({
  metric: captureMetricSchema,
  direction: z.enum(['lower-is-better', 'higher-is-better']),
  baseline: captureMetricStatsSchema,
  candidate: captureMetricStatsSchema,
  missingBaselineCaptureIds: z.array(z.string()),
  missingCandidateCaptureIds: z.array(z.string()),
  delta: z.object({
    median: z.number().nullable(),
    regressionPct: z.number().nullable(),
  }),
  budget: captureMetricBudgetSchema.optional(),
  verdict: z.enum(['pass', 'fail', 'insufficient-data', 'informational']),
  reasons: z.array(z.string()),
})

export const captureComparisonSchema = z.object({
  schemaVersion: z.literal(CAPTURE_SCHEMA_VERSION),
  kind: z.literal('capture-comparison'),
  comparisonId: z.string(),
  createdAt: z.string().datetime(),
  minimumRuns: z.number().int().positive(),
  baselineCaptureIds: z.array(z.string()),
  candidateCaptureIds: z.array(z.string()),
  overall: z.enum(['pass', 'fail', 'insufficient-data', 'informational']),
  metrics: z.array(captureComparisonMetricSchema),
  violations: z.array(z.object({ metric: captureMetricSchema, reasons: z.array(z.string()) })),
  warnings: z.array(z.string()),
})
export type CaptureComparison = z.infer<typeof captureComparisonSchema>

const captureNameSchema = z
  .string()
  .trim()
  .min(1, 'capture name is required')
  .max(80, 'capture name must be at most 80 characters')
  .refine(
    (name) =>
      ![...name].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint <= 31 || codePoint === 127
      }),
    'capture name cannot contain control characters',
  )

const captureSummarySchema = captureArtifactSchema.pick({
  schemaVersion: true,
  captureId: true,
  name: true,
  createdAt: true,
  session: true,
  include: true,
  consistency: true,
  complete: true,
  sizeBytes: true,
})

export const devtoolsCaptureCreateContract = defineAgentToolContract({
  name: 'devtools_capture_create',
  title: 'Create an immutable runtime capture',
  description:
    'Create and retain a named, schema-versioned artifact containing bounded runtime sections. The bridge probes React commits before and after, retries when they move, and records whether the final artifact is React-commit-stable or best-effort. Read it later by captureId or export this JSON result directly.',
  group: 'meta',
  input: z
    .object({
      name: captureNameSchema,
      include: z
        .array(captureDomainSchema)
        .min(1)
        .max(CAPTURE_DOMAINS.length)
        .refine(
          (domains) => new Set(domains).size === domains.length,
          'include domains must be unique',
        )
        .default(['react', 'effects', 'query', 'router', 'memory']),
      maxAttempts: z.number().int().min(1).max(5).default(3),
    })
    .strict(),
  output: captureArtifactSchema,
  annotations: { idempotentHint: false },
})

export const devtoolsCaptureListContract = defineAgentToolContract({
  name: 'devtools_capture_list',
  title: 'List retained runtime captures',
  description:
    'List bounded capture summaries newest first. The bridge retains at most 20 captures; export important artifacts from devtools_capture_create/read as JSON.',
  group: 'meta',
  input: z.object({}).strict(),
  output: z.object({
    captures: z.array(captureSummarySchema),
    total: z.number().int().nonnegative(),
    maxRetained: z.number().int().positive(),
  }),
  annotations: { readOnlyHint: true },
})

export const devtoolsCaptureReadContract = defineAgentToolContract({
  name: 'devtools_capture_read',
  title: 'Read an immutable runtime capture',
  description: 'Read one retained schema-versioned artifact by its exact captureId.',
  group: 'meta',
  input: z.object({ captureId: z.string().min(1, 'captureId is required') }).strict(),
  output: captureArtifactSchema,
  annotations: { readOnlyHint: true },
})

export const devtoolsCaptureCompareContract = defineAgentToolContract({
  name: 'devtools_capture_compare',
  title: 'Compare repeated runtime captures',
  description:
    'Compare repeated baseline and candidate capture cohorts with median, p95, and median absolute deviation (MAD). Apply optional typed regression budgets per metric. At least minimumRuns usable samples per cohort are required for a pass/fail budget verdict; smaller or missing cohorts remain explicit insufficient-data. Capture IDs must be unique and cannot appear in both cohorts.',
  group: 'meta',
  input: z
    .object({
      baselineCaptureIds: z.array(z.string().min(1)).min(1).max(10),
      candidateCaptureIds: z.array(z.string().min(1)).min(1).max(10),
      metrics: z
        .array(captureMetricSchema)
        .min(1)
        .max(CAPTURE_METRICS.length)
        .default([...CAPTURE_METRICS]),
      minimumRuns: z.number().int().min(1).max(10).default(3),
      budgets: z.array(captureMetricBudgetSchema).max(CAPTURE_METRICS.length).default([]),
    })
    .strict()
    .superRefine((input, context) => {
      const baseline = new Set(input.baselineCaptureIds)
      const candidate = new Set(input.candidateCaptureIds)
      if (baseline.size !== input.baselineCaptureIds.length) {
        context.addIssue({
          code: 'custom',
          path: ['baselineCaptureIds'],
          message: 'IDs must be unique',
        })
      }
      if (candidate.size !== input.candidateCaptureIds.length) {
        context.addIssue({
          code: 'custom',
          path: ['candidateCaptureIds'],
          message: 'IDs must be unique',
        })
      }
      if (input.metrics.length !== new Set(input.metrics).size) {
        context.addIssue({ code: 'custom', path: ['metrics'], message: 'metrics must be unique' })
      }
      if (input.budgets.length !== new Set(input.budgets.map((budget) => budget.metric)).size) {
        context.addIssue({
          code: 'custom',
          path: ['budgets'],
          message: 'budget metrics must be unique',
        })
      }
      const requestedMetrics = new Set(input.metrics)
      if (input.budgets.some((budget) => !requestedMetrics.has(budget.metric))) {
        context.addIssue({
          code: 'custom',
          path: ['budgets'],
          message: 'every budget metric must also be requested in metrics',
        })
      }
      const overlap = [...baseline].filter((captureId) => candidate.has(captureId))
      if (overlap.length > 0) {
        context.addIssue({
          code: 'custom',
          path: ['candidateCaptureIds'],
          message: 'baseline and candidate capture IDs cannot overlap',
        })
      }
    }),
  output: captureComparisonSchema,
  annotations: { readOnlyHint: true },
})

/** Meta tools are answered by the bridge itself (not the app), so they work before an app connects — as `devtools_wait` needs. */
export const devtoolsStatusContract = defineAgentToolContract({
  name: 'devtools_status',
  title: 'DevTools status',
  description:
    'Check whether a Genie-instrumented React + TanStack app is connected and ready, and report its session, React/TanStack versions, available data domains, and tool count. `sessions` lists every connected tab; tool calls hit the `current` one unless a physical id, logical id, or unique session name is targeted explicitly (CLI: --session <target>).',
  group: 'meta',
  input: z.object({
    includeTools: z
      .boolean()
      .default(true)
      .describe('Include full tool descriptors; set false for a compact status response.'),
  }),
  output: z.object({
    connected: z.boolean(),
    ready: z.boolean().default(true),
    sessionId: z.string().nullable(),
    app: appInfoSchema.nullable(),
    domains: z.array(z.string()),
    toolCount: z.number(),
    tools: z.array(toolDescriptorSchema).optional(),
    sessions: z.array(sessionSummarySchema),
  }),
  annotations: { readOnlyHint: true },
})

export const WAIT_CONDITIONS = [
  'connected',
  'ready',
  'component',
  'query-settled',
  'navigation',
] as const
export type WaitCondition = (typeof WAIT_CONDITIONS)[number]

export const devtoolsWaitContract = defineAgentToolContract({
  name: 'devtools_wait',
  title: 'Wait for a condition',
  description:
    'Block until a runtime condition holds so the agent can synchronize instead of polling: the app connecting, collector startup completing, a component mounting, one exact query settling, or a navigation completing. For queries, prefer queryHash or queryKey from query_list; legacy name matching is exact, never substring-based.',
  group: 'meta',
  input: z
    .object({
      condition: z.enum(WAIT_CONDITIONS).default('connected'),
      name: z
        .string()
        .optional()
        .describe(
          'Component name or route. For query-settled, a legacy exact queryHash, JSON array key, or one-item string key; prefer queryHash/queryKey.',
        ),
      queryHash: z
        .string()
        .min(1)
        .optional()
        .describe('Exact queryHash from query_list; only for condition="query-settled".'),
      queryKey: z
        .array(z.unknown())
        .optional()
        .describe('Exact structured query key; only for condition="query-settled".'),
      timeoutMs: z.number().int().positive().max(60_000).default(10_000),
    })
    .strict()
    .superRefine((input, context) => {
      if (input.queryHash !== undefined && input.queryKey !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['queryKey'],
          message: 'choose queryHash or queryKey, not both',
        })
      }
      const hasStructuredQuery = input.queryHash !== undefined || input.queryKey !== undefined
      if (hasStructuredQuery && input.condition !== 'query-settled') {
        context.addIssue({
          code: 'custom',
          path: ['condition'],
          message: 'queryHash/queryKey require condition="query-settled"',
        })
      }
      if (hasStructuredQuery && input.name !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['name'],
          message: 'choose name or queryHash/queryKey, not both',
        })
      }
    }),
  output: z.object({
    ok: z.boolean(),
    waitedMs: z.number(),
    reason: z.string().optional(),
    query: z
      .object({ queryHash: z.string(), queryKey: z.unknown() })
      .optional()
      .describe('The exact cache entry that satisfied a targeted query wait.'),
  }),
  annotations: { readOnlyHint: true },
})

export const metaTools = [
  devtoolsStatusContract,
  devtoolsWaitContract,
  devtoolsCaptureCreateContract,
  devtoolsCaptureListContract,
  devtoolsCaptureReadContract,
  devtoolsCaptureCompareContract,
]

/** Catalog entries for the meta tools, so `tools` listings and toolCount agree on the same set. */
export const metaToolDescriptors: ToolDescriptor[] = metaTools.map((contract) => ({
  name: contract.name,
  title: contract.title,
  description: contract.description,
  group: contract.group,
  inputJsonSchema: z.toJSONSchema(contract.input, { io: 'input' }),
}))
