import { z } from 'zod'
import { defineAgentToolContract } from '../../protocol'
import { sourceSchema } from './contract-schemas'

const effectOwnershipSchema = z.enum(['app', 'library', 'unknown'])
const provenanceConfidenceSchema = z.enum(['high', 'medium', 'none'])

const effectHotnessSchema = z.object({
  label: z.enum(['hot', 'not-hot', 'insufficient-data']),
  samples: z.number().int().nonnegative(),
  observedRate: z.number().min(0).max(1),
  minUpdates: z.number().int().positive(),
  minFireRate: z.number().min(0).max(1),
  confidenceInterval: z.object({
    level: z.number().min(0).max(1),
    lower: z.number().min(0).max(1),
    upper: z.number().min(0).max(1),
  }),
  reason: z.enum(['meets-threshold', 'below-fire-rate', 'below-minimum-updates']),
})

const effectFindingSchema = z.object({
  index: z.number().describe('Position of the effect among the component’s hooks.'),
  kind: z.enum(['effect', 'layout', 'insertion']),
  depsMode: z
    .enum(['none', 'empty', 'list'])
    .describe('none = no deps array (runs every render); empty = [] (mount only); list = [deps].'),
  depCount: z.number(),
  fired: z.number().describe('Update commits in which this effect actually ran.'),
  updates: z.number().describe('Update commits observed for the component.'),
  firesEveryUpdate: z
    .boolean()
    .describe('Raw observed fact; use hotness.label before treating a small sample as actionable.'),
  lastChangedDep: z
    .number()
    .nullable()
    .describe('Index of the dependency that drove the most recent run, if a list dep changed.'),
  hasCleanup: z
    .boolean()
    .describe('Whether the effect returned a cleanup (observed after it ran).'),
  note: z
    .string()
    .optional()
    .describe('A concrete fix when the effect looks like a re-run/loop smell.'),
  source: sourceSchema.describe(
    "This effect's own call-site (the useEffect call), resolved per-effect — null when it cannot be attributed (e.g. the component also uses useSyncExternalStore).",
  ),
  isLibrary: z
    .boolean()
    .describe(
      'Compatibility boolean derived from provenance.ownership === "library"; use provenance to preserve unknown ownership.',
    ),
  provenance: z.object({
    ownership: effectOwnershipSchema,
    confidence: provenanceConfidenceSchema,
    reason: z.enum([
      'exact-hook-order',
      'no-user-effect-callsite',
      'library-only-hook-tree',
      'hook-count-mismatch',
      'hook-source-unresolved',
      'hook-inspection-unavailable',
      'attribution-budget-exhausted',
    ]),
    hookSource: sourceSchema.describe('Effect implementation callsite, separate from its owner.'),
    packageName: z
      .string()
      .nullable()
      .describe('Owning npm package when one can be recovered from a library source path.'),
  }),
  hotness: effectHotnessSchema.describe(
    'Thresholded classification plus a 95% Wilson interval for the observed firing rate.',
  ),
})

export const reactEffectAuditContract = defineAgentToolContract({
  name: 'react_effect_audit',
  title: 'Effect audit (did effects fire & why)',
  description:
    'Audit useEffect / useLayoutEffect / useInsertionEffect executions: observed firing counts, dependency mode/change, cleanup, thresholded hotness with sample evidence, and explicit implementation provenance separate from the owning component. Ownership is app/library/unknown with a confidence and reason; unknown effects are never silently filtered as application code. appOnly (default true) drops only effects confidently attributed to libraries. Interact with the app (or react_clear_renders to reset) first, then read this.',
  group: 'react.render',
  input: z.object({
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
      .describe('Minimum fired/updates ratio required for hot classification.'),
    limit: z.number().int().min(1).max(200).default(40),
  }),
  output: z.object({
    tracking: z.boolean(),
    commits: z.number(),
    hotnessCriteria: z.object({
      minUpdates: z.number().int().positive(),
      minFireRate: z.number().min(0).max(1),
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
          confidence: z.enum(['medium', 'none']),
          reason: z.enum(['nearest-symbolicated-fiber', 'source-unresolved']),
          source: sourceSchema,
        }),
        effects: z.array(effectFindingSchema),
      }),
    ),
    filteredNote: z
      .string()
      .optional()
      .describe(
        'Present only when appOnly hid library-origin effects; distinguishes "no effects filtered" from "no effects exist".',
      ),
  }),
  annotations: { readOnlyHint: true },
})
