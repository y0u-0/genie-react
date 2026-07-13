import { z } from 'zod'
import { defineAgentToolContract } from '../../protocol'
import { sourceSchema } from './contract-schemas'
import { observationSchema } from './render-contract'

const effectOwnershipSchema = z.enum(['app', 'library', 'unknown'])
const provenanceEvidenceSchema = z.enum(['exact', 'inferred', 'unknown'])

const effectCoverageSchema = z.object({
  complete: z.boolean().describe('Completeness of effect schedule capture.'),
  inputAttributionComplete: z.boolean(),
  skippedCommitFibers: z.number().int().nonnegative(),
  droppedUnmountFibers: z.number().int().nonnegative(),
  analysisFailedFibers: z.number().int().nonnegative(),
  truncatedInputFibers: z.number().int().nonnegative(),
  propsNotEnumeratedFibers: z.number().int().nonnegative(),
  truncatedEffectLists: z.number().int().nonnegative(),
  budgetExhaustedCommits: z.number().int().nonnegative(),
  budgetExhaustedSubsystems: z.array(
    z.object({ subsystem: z.string(), commits: z.number().int().positive() }),
  ),
})

const effectHotnessSchema = z.object({
  label: z.enum(['hot', 'not-hot', 'insufficient-data']),
  samples: z.number().int().nonnegative(),
  observedRate: z.number().min(0).max(1),
  minUpdates: z.number().int().positive(),
  minScheduleRate: z.number().min(0).max(1),
  minFireRate: z.number().min(0).max(1).describe('Legacy alias for minScheduleRate.'),
  confidenceInterval: z.object({
    level: z.number().min(0).max(1),
    lower: z.number().min(0).max(1),
    upper: z.number().min(0).max(1),
  }),
  scheduleReason: z.enum(['meets-threshold', 'below-schedule-rate', 'below-minimum-updates']),
  reason: z
    .enum(['meets-threshold', 'below-fire-rate', 'below-minimum-updates'])
    .describe(
      'Legacy alias for scheduleReason; below-fire-rate means below schedule rate and does not prove execution.',
    ),
})

const effectFindingSchema = z.object({
  index: z.number().describe('Position of the effect among the component’s hooks.'),
  kind: z.enum(['effect', 'layout', 'insertion']),
  depsMode: z
    .enum(['none', 'empty', 'list'])
    .describe(
      'none = no deps array (scheduled after every render); empty = [] (mount only); list = [deps].',
    ),
  depCount: z.number(),
  scheduled: z.number().describe('Update commits in which React scheduled this effect.'),
  updates: z.number().describe('Update commits observed for the component.'),
  schedulesEveryUpdate: z
    .boolean()
    .describe('Raw schedule fact; use hotness.label before treating a small sample as actionable.'),
  fired: z
    .number()
    .describe('Legacy alias for scheduled. This does not prove that the effect executed.'),
  firesEveryUpdate: z
    .boolean()
    .describe('Legacy alias for schedulesEveryUpdate. This does not prove execution.'),
  lastChangedDep: z
    .number()
    .nullable()
    .describe('Index of the dependency that changed for the most recent schedule.'),
  cleanupFunctionObserved: z
    .boolean()
    .describe(
      'Whether React stored a cleanup function at least once; this does not prove current cleanup state or execution timing.',
    ),
  hasCleanup: z.boolean().describe('Legacy alias for cleanupFunctionObserved.'),
  note: z
    .string()
    .optional()
    .describe('A concrete fix when the effect looks like a re-run/loop smell.'),
  source: sourceSchema.describe(
    "This effect's own call-site. Automatic reports leave it null instead of re-running the component to inspect hooks; provenance.reason says why.",
  ),
  isLibrary: z
    .boolean()
    .describe(
      'Compatibility boolean derived from provenance.ownership === "library"; use provenance to preserve unknown ownership.',
    ),
  provenance: z.object({
    ownership: effectOwnershipSchema,
    evidence: provenanceEvidenceSchema,
    reason: z.enum([
      'exact-hook-order',
      'no-user-effect-callsite',
      'library-only-hook-tree',
      'hook-count-mismatch',
      'hook-source-unresolved',
      'hook-inspection-unavailable',
      'inspection-truncated',
      'shadow-render-disabled',
      'attribution-budget-exhausted',
      'report-state-advanced',
    ]),
    hookSource: sourceSchema.describe('Effect implementation callsite, separate from its owner.'),
    packageName: z
      .string()
      .nullable()
      .describe('Owning npm package when one can be recovered from a library source path.'),
    hookAncestry: z
      .array(
        z.object({
          name: z.string(),
          source: sourceSchema,
          ownership: effectOwnershipSchema,
          packageName: z.string().nullable(),
        }),
      )
      .max(12)
      .describe(
        'Bounded custom-hook wrappers above this effect. Present only when effect count/order alignment is exact.',
      ),
  }),
  hotness: effectHotnessSchema.describe(
    'Thresholded classification plus a 95% Wilson interval for the observed schedule rate.',
  ),
})

export const reactEffectAuditContract = defineAgentToolContract({
  name: 'react_effect_audit',
  title: 'Effect schedule audit',
  description:
    'Audit useEffect, useLayoutEffect, and useInsertionEffect schedules: commit counts, dependency mode/change, cleanup presence, sample-aware hotness, and implementation provenance. React commit flags do not prove passive execution or cleanup timing. Genie does not re-run components to recover hook callsites, so automatic provenance can be unknown with reason shadow-render-disabled. Start with react_clear_renders, drive the interaction, then read this.',
  group: 'react.render',
  input: z
    .object({
      component: z.string().optional().describe('Only components whose name contains this string.'),
      onlyHot: z
        .boolean()
        .default(false)
        .describe('Return only effects whose thresholded hotness label is "hot".'),
      appOnly: z
        .boolean()
        .default(true)
        .describe(
          'Exclude library components AND library-origin effects (node_modules, incl. Vite pre-bundled deps) so your own effects surface above hook noise; set false to include them.',
        ),
      packageName: z
        .string()
        .trim()
        .min(1)
        .max(214)
        .optional()
        .describe(
          'Only effects attributed to this exact npm package, e.g. "@tanstack/react-query". Requires appOnly:false.',
        ),
      minUpdates: z
        .number()
        .int()
        .min(1)
        .max(1_000)
        .default(3)
        .describe('Minimum observed updates required before an effect can be classified hot.'),
      minFireRate: z
        .number()
        .min(0.1)
        .max(1)
        .default(1)
        .describe('Legacy name for minScheduleRate.'),
      minScheduleRate: z
        .number()
        .min(0.1)
        .max(1)
        .optional()
        .describe('Preferred minimum scheduled/updates ratio for hot classification.'),
      limit: z.number().int().min(1).max(200).default(40),
    })
    .superRefine((input, context) => {
      if (input.packageName !== undefined && input.appOnly) {
        context.addIssue({
          code: 'custom',
          path: ['appOnly'],
          message: 'set appOnly:false when filtering by packageName',
        })
      }
    }),
  output: z.object({
    tracking: z.boolean(),
    commits: z.number(),
    documentCommitId: z.number().int().nonnegative(),
    attribution: z.object({
      status: z.enum(['current', 'stale']),
      startedAtDocumentCommitId: z.number().int().nonnegative(),
      completedAtDocumentCommitId: z.number().int().nonnegative(),
      startedAtAnalysisGeneration: z.number().int().nonnegative(),
      completedAtAnalysisGeneration: z.number().int().nonnegative(),
    }),
    hotnessCriteria: z.object({
      minUpdates: z.number().int().positive(),
      minScheduleRate: z.number().min(0).max(1),
      minFireRate: z.number().min(0).max(1).describe('Legacy alias for minScheduleRate.'),
      confidenceLevel: z.number().min(0).max(1),
    }),
    components: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        source: sourceSchema.describe(
          'Nearest symbolicated fiber source; may be a definition or owner callsite. See componentProvenance.',
        ),
        isLibrary: z.boolean(),
        componentProvenance: z.object({
          ownership: effectOwnershipSchema,
          evidence: z.enum(['inferred', 'unknown']),
          reason: z.enum(['nearest-symbolicated-fiber', 'source-unresolved']),
          source: sourceSchema,
        }),
        effects: z.array(effectFindingSchema),
        effectsOmitted: z.number().int().nonnegative(),
      }),
    ),
    omittedByLimit: z.number().int().nonnegative(),
    effectsOmittedByLimit: z.number().int().nonnegative(),
    coverage: effectCoverageSchema,
    filteredNote: z
      .string()
      .optional()
      .describe(
        'Present only when appOnly hid library-origin effects; distinguishes "no effects filtered" from "no effects exist".',
      ),
    packageFilter: z
      .object({
        packageName: z.string(),
        matchedEffects: z.number().int().nonnegative(),
        excludedEffects: z.number().int().nonnegative(),
        unknownPackageEffects: z.number().int().nonnegative(),
      })
      .optional()
      .describe('Explicit accounting for an exact packageName filter.'),
  }),
  annotations: { readOnlyHint: true },
})

export const reactEffectEventsContract = defineAgentToolContract({
  name: 'react_effect_events',
  title: 'Recent effect schedules',
  description:
    'Report bounded effect schedule events joined to observation, commit, component, mount, and effect IDs. Execution, cleanup execution, and downstream consequences stay explicitly unobserved; no timestamp-only causal edge is emitted.',
  group: 'react.render',
  input: z.object({
    component: z.string().optional(),
    afterDocumentCommitId: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  output: z.object({
    tracking: z.boolean(),
    documentCommitId: z.number().int().nonnegative(),
    observation: observationSchema.nullable(),
    events: z.array(
      z.object({
        effectEventId: z.string(),
        effectId: z.string(),
        observationId: z.string().nullable(),
        commitId: z.number().int().nonnegative(),
        documentCommitId: z.number().int().nonnegative(),
        componentId: z.number().int(),
        componentName: z.string(),
        mountId: z.string(),
        effectIndex: z.number().int().nonnegative(),
        kind: z.enum(['effect', 'layout', 'insertion']),
        phase: z.enum(['mount', 'update']),
        event: z.literal('scheduled'),
        evidence: z.literal('exact'),
        changedDependencySlots: z.array(z.number().int().nonnegative()),
        changedDependencySlotsOmitted: z.number().int().nonnegative(),
        dependencySlotsUnscanned: z.number().int().nonnegative(),
        execution: z.object({ status: z.literal('unobserved') }),
        cleanupExecution: z.object({ status: z.literal('unobserved') }),
        consequences: z.object({
          status: z.literal('not-instrumented'),
          events: z.tuple([]),
        }),
      }),
    ),
    omittedByLimit: z.number().int().nonnegative(),
    evictedEvents: z
      .number()
      .int()
      .nonnegative()
      .describe('Schedule events evicted from the retained history.'),
    droppedEvents: z.number().int().nonnegative().describe('Legacy alias for evictedEvents.'),
    coverage: effectCoverageSchema,
  }),
  annotations: { readOnlyHint: true },
})
