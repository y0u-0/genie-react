import { z } from 'zod'
import { defineAgentToolContract } from '../../protocol'

/** A fiber's stable id (bippy `getFiberId`), branded against the collector's other numbers; erases to a plain number at runtime, so it serializes unchanged. */
const nodeIdSchema = z.number().int().brand<'ReactNodeId'>()
export type NodeId = z.infer<typeof nodeIdSchema>

/** Cap on the memoizedState hook walk, shared by the inspector, the hook-state override, and its contract. */
export const MAX_HOOKS = 100

const sourceSchema = z
  .object({
    file: z.string(),
    line: z.number().nullable(),
    column: z.number().nullable(),
    functionName: z.string().nullable(),
  })
  .nullable()

const treeNodeSchema = z.object({
  id: z.number(),
  parentId: z.number().nullable(),
  name: z.string(),
  key: z.string().nullable(),
  kind: z.enum(['component', 'host']),
  source: sourceSchema.optional(),
  isLibrary: z.boolean().optional(),
})

export const reactGetTreeContract = defineAgentToolContract({
  name: 'react_get_tree',
  title: 'React component tree',
  description:
    'Get the live React component tree as a flat node list (id, parentId, name, key, kind). Reconstruct the hierarchy from parentId; pass node ids to react_inspect_component. Framework wrappers can be deep, so raise `depth` if your own components do not appear and `truncatedBy` is "depth".',
  group: 'react.tree',
  input: z.object({
    depth: z.number().int().min(1).max(80).default(30),
    includeHost: z
      .boolean()
      .default(false)
      .describe('Include host (DOM) elements, not just components.'),
    maxNodes: z.number().int().min(1).max(2000).default(400),
    appOnly: z
      .boolean()
      .default(true)
      .describe(
        'Fold each library subtree (node_modules, incl. Vite pre-bundled deps) into a single node and label anonymous nodes by file:line. On by default like the other react reads; pass false for the raw structural view.',
      ),
  }),
  output: z.object({
    rootId: z.number().nullable(),
    nodes: z.array(treeNodeSchema),
    total: z
      .number()
      .describe('Total nodes reachable in the tree; `nodes` may be fewer when truncated.'),
    truncated: z.boolean(),
    truncatedBy: z.enum(['depth', 'maxNodes']).nullable(),
    filteredNote: z
      .string()
      .optional()
      .describe(
        'Present only when appOnly folded library subtrees away; names how many components were hidden and how to include them.',
      ),
  }),
  annotations: { readOnlyHint: true },
})

export const reactFindComponentsContract = defineAgentToolContract({
  name: 'react_find_components',
  title: 'Find React components',
  description:
    'Find mounted components by display name (substring match, or exact). Each match carries its id, ancestor path, kind, a shallow (depth-1) props preview, source file:line, and whether it is a library component — enough to pick the right one and often to act without a follow-up react_inspect_component call. Deepen a nested prop with react_inspect_component + `path`.',
  group: 'react.tree',
  input: z.object({
    query: z.string().min(1),
    exact: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    matches: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        path: z.string(),
        kind: z.string(),
        props: z
          .unknown()
          .describe('Shallow (depth-1) props preview; hydrate deeper via react_inspect_component.'),
        source: sourceSchema,
        isLibrary: z.boolean(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true },
})

/** The single source of truth for hook kinds — fiber.ts's HookKind type is inferred from this enum. */
export const hookKindSchema = z.enum([
  'state',
  'reducer',
  'effect',
  'layout-effect',
  'memo',
  'callback',
  'ref',
  'other',
])

export const hookEntrySchema = z.object({
  index: z.number().describe('Flat position among all hooks (the raw hookIndex).'),
  kind: hookKindSchema.describe(
    'Structural classification. memo vs callback is best-effort (both store [value,deps]; callback = value is a function), so a useMemo returning a function reads as callback.',
  ),
  stateful: z
    .boolean()
    .describe('True for useState/useReducer — the only hooks react_override_hook_state can drive.'),
  stateIndex: z
    .number()
    .optional()
    .describe(
      'Present only on stateful hooks: the 0-based ordinal among them, to pass as react_override_hook_state stateIndex.',
    ),
  value: z
    .unknown()
    .optional()
    .describe('The hook value, depth-bounded (absent for effect hooks).'),
  deps: z
    .unknown()
    .optional()
    .describe('Present on effect/layout-effect hooks: the dependency array, depth-bounded.'),
})

export const reactInspectComponentContract = defineAgentToolContract({
  name: 'react_inspect_component',
  title: 'Inspect a React component',
  description:
    'Inspect a component by id: its props, plus state (class components) or hooks (function components), depth-bounded. Each hook reports its `kind` (state/reducer/effect/layout-effect/memo/callback/ref/other), whether it is `stateful`, and for stateful hooks a `stateIndex` — the ordinal you pass to react_override_hook_state instead of counting flat hook positions past library hooks. Pass `path` to hydrate deeper into a nested prop value.',
  group: 'react.inspect',
  input: z.object({
    id: nodeIdSchema,
    path: z
      .array(z.union([z.string(), z.number()]))
      .optional()
      .describe('Path into props to hydrate deeper, e.g. ["user","address"].'),
    depth: z.number().int().min(1).max(6).default(2),
  }),
  output: z.object({
    id: z.number(),
    name: z.string(),
    kind: z.string(),
    props: z.unknown(),
    state: z.unknown().optional(),
    hooks: z.array(hookEntrySchema),
  }),
  annotations: { readOnlyHint: true },
})

export const reactDomForComponentContract = defineAgentToolContract({
  name: 'react_dom_for_component',
  title: 'DOM elements for a component',
  description:
    'Map a React component (by id, from react_get_tree / react_find_components / react_inspect_component) to the actual DOM element(s) it renders — the missing link between the React tree and the live page. Each element comes with a best-effort CSS `selector` plus its id / data-testid / role / aria-label / name / classes / text, so you can hand it straight to a browser tool (click, screenshot, assert) instead of guessing which node a component controls.',
  group: 'react.inspect',
  input: z.object({
    id: nodeIdSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Max elements to return when a component renders many host nodes.'),
  }),
  output: z.object({
    id: z.number(),
    name: z.string(),
    elements: z.array(
      z.object({
        tag: z.string(),
        selector: z
          .string()
          .describe(
            'Best-effort CSS selector: #id or [data-testid] when present, else tag + simple classes. For utility-class-only nodes, prefer a semantic locator built from role / text.',
          ),
        domId: z.string().nullable(),
        testId: z.string().nullable(),
        role: z.string().nullable(),
        ariaLabel: z.string().nullable(),
        name: z.string().nullable().describe('The `name` attribute, for form controls.'),
        classes: z.array(z.string()),
        text: z.string().nullable().describe('Trimmed textContent preview.'),
      }),
    ),
    total: z
      .number()
      .describe(
        'Total host elements the component renders; `elements` may be fewer when truncated.',
      ),
  }),
  annotations: { readOnlyHint: true },
})

export const reactComponentForDomContract = defineAgentToolContract({
  name: 'react_component_for_dom',
  title: 'Owning component for a DOM element',
  description:
    'Map a CSS selector (e.g. an element a browser tool found) to the React component(s) rendering it — the reverse of react_dom_for_component, turning "this button is wrong" into "edit this component". Each match reports the owning component id (feed it to react_inspect_component / overrides), name, kind, shallow props, and source file:line. Elements outside this React tree are skipped; duplicate owners are collapsed.',
  group: 'react.inspect',
  input: z.object({
    selector: z
      .string()
      .describe('CSS selector; each matched element resolves to its owning component.'),
    limit: z.number().int().min(1).max(20).default(5).describe('Max matched elements to resolve.'),
    propsDepth: z.number().int().min(0).max(4).default(1),
  }),
  output: z.object({
    selector: z.string(),
    matched: z.number().describe('Total DOM elements the selector matched (before limit).'),
    components: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        kind: z.string(),
        tag: z.string().describe('Tag of the matched DOM element.'),
        props: z.unknown(),
        source: sourceSchema,
        isLibrary: z.boolean(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true },
})

export const reactInspectContextContract = defineAgentToolContract({
  name: 'react_inspect_context',
  title: 'Inspect consumed React contexts',
  description:
    'Report which React Contexts a component consumes (by id) and their current provided values — invisible from source, which only shows the useContext call, and from the DOM. Answers "what value is this component actually reading?" and surfaces wrong-provider / stale-context bugs. Values are depth-bounded like react_inspect_component; an empty list means the component consumes no context.',
  group: 'react.inspect',
  input: z.object({
    id: nodeIdSchema,
    depth: z.number().int().min(1).max(6).default(2),
  }),
  output: z.object({
    id: z.number(),
    name: z.string(),
    contexts: z.array(
      z.object({
        name: z.string().describe('The context displayName, or "Context" when unnamed.'),
        value: z.unknown(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true },
})

export const reactOverridePropsContract = defineAgentToolContract({
  name: 'react_override_props',
  title: 'Override component props (dev)',
  description:
    "Live-edit a mounted component's props by id (dev only): merges the given partial props and triggers a re-render. Useful for testing UI states.",
  group: 'action',
  input: z.object({
    id: nodeIdSchema,
    props: z.record(z.string(), z.unknown()),
  }),
  output: z.object({ ok: z.boolean() }),
  annotations: { destructiveHint: true, idempotentHint: false },
})

export const reactOverrideHookStateContract = defineAgentToolContract({
  name: 'react_override_hook_state',
  title: 'Override hook state (dev)',
  description:
    'Set a stateful hook\'s value and re-render — drive a function component into any state (a wizard step, an open modal, an invalid form) without a multi-step UI script. Target the hook with EXACTLY ONE of: `stateIndex` (the 0-based ordinal among only the stateful useState/useReducer hooks — the `stateIndex` react_inspect_component prints on each stateful hook, robust to library hooks shifting flat positions) or `hookIndex` (the raw flat index over ALL hooks). Prefer stateIndex. Only stateful hooks can be overridden; a failed call lists the stateful hooks (flat index, stateIndex, kind, value preview) so you can retry. `path` targets a nested field of the value (e.g. ["filters","page"]); omit it to replace the whole value. The component\'s own next setState takes back control; use react_reset_overrides to clear all overrides at once.',
  group: 'action',
  input: z
    .object({
      id: nodeIdSchema,
      hookIndex: z
        .number()
        .int()
        .min(0)
        .max(MAX_HOOKS - 1)
        .optional()
        .describe('Raw flat hook index over all hooks. Provide this OR stateIndex, not both.'),
      stateIndex: z
        .number()
        .int()
        .min(0)
        .max(MAX_HOOKS - 1)
        .optional()
        .describe(
          'Preferred. 0-based ordinal among only the stateful hooks, as react_inspect_component reports. Provide this OR hookIndex, not both.',
        ),
      path: z
        .array(z.union([z.string(), z.number()]))
        .default([])
        .describe('Path into the hook value; empty replaces the whole value.'),
      value: z.unknown(),
    })
    .refine((input) => (input.hookIndex === undefined) !== (input.stateIndex === undefined), {
      message: 'Provide exactly one of hookIndex or stateIndex.',
    }),
  output: z.object({
    ok: z.boolean(),
    name: z.string(),
    hookIndex: z.number().describe('The resolved flat hook index that was overridden.'),
    stateIndex: z
      .number()
      .nullable()
      .describe('The stateful ordinal, when targeted by stateIndex.'),
  }),
  annotations: { destructiveHint: true, idempotentHint: false },
})

export const reactOverrideContextContract = defineAgentToolContract({
  name: 'react_override_context',
  title: 'Override a context value (dev)',
  description:
    "Override a React Context for a whole subtree by editing the nearest Provider's `value` above a component — test a different theme/locale/flag without touching code. Pass the id of a component that consumes the context (react_inspect_context lists them; `context` picks one by name when it consumes several) or a Provider id directly. A plain-object `value` shallow-merges into the current value; any other value replaces it. Reverts when the Provider's parent re-renders — same lifetime as react_override_props. A context running on its default value (no Provider mounted) cannot be overridden.",
  group: 'action',
  input: z.object({
    id: nodeIdSchema,
    context: z
      .string()
      .optional()
      .describe(
        'Context displayName, from react_inspect_context — required when several are consumed.',
      ),
    value: z.unknown(),
  }),
  output: z.object({ ok: z.boolean(), providerId: z.number(), contextName: z.string() }),
  annotations: { destructiveHint: true, idempotentHint: false },
})

export const reactToggleSuspenseFallbackContract = defineAgentToolContract({
  name: 'react_toggle_suspense_fallback',
  title: 'Force a Suspense fallback (dev)',
  description:
    'Hold the nearest Suspense boundary at/above a component in its fallback (loading) state, or release it — a state normally visible for milliseconds becomes one you can inspect and screenshot to verify loading UI. Pass any component id inside the boundary, or a boundaryId from react_error_state. Persists until released with showFallback:false or a page reload. react_list_overrides shows every active override; react_reset_overrides releases them all at once (works even if this id no longer resolves).',
  group: 'action',
  input: z.object({
    id: nodeIdSchema,
    showFallback: z.boolean().default(true),
  }),
  output: z.object({
    ok: z.boolean(),
    boundaryId: z.number(),
    showingFallback: z.boolean(),
    activeOverrides: z.number().describe('Suspense boundaries currently held in fallback.'),
  }),
  annotations: { destructiveHint: true, idempotentHint: true },
})

export const reactForceErrorBoundaryContract = defineAgentToolContract({
  name: 'react_force_error_boundary',
  title: 'Force an error boundary (dev)',
  description:
    'Make the nearest error boundary at/above a component catch a simulated error, or release it — verify error UI renders and that the intended boundary contains the failure, without manufacturing a real crash. Pass any component id inside the boundary. Release with the returned boundaryId and forceError:false — the original child id unmounts while the boundary is erroring, so its id may no longer resolve on release; if you get "Component N not found", call react_reset_overrides, which clears forced errors from module state without needing the id. Caveat: if the BOUNDARY itself re-mounted while forced (React Native RedBox flows do this), the new instance stays latched in its error state after reset — reload the app to restore the UI. react_list_overrides shows what is currently forced.',
  group: 'action',
  input: z.object({
    id: nodeIdSchema,
    forceError: z.boolean().default(true),
  }),
  output: z.object({
    ok: z.boolean(),
    boundaryId: z.number(),
    boundaryName: z.string(),
    erroring: z.boolean(),
    activeOverrides: z.number().describe('Error boundaries currently forced to error.'),
  }),
  annotations: { destructiveHint: true, idempotentHint: true },
})

export const reactListOverridesContract = defineAgentToolContract({
  name: 'react_list_overrides',
  title: 'List active overrides (dev)',
  description:
    'List every live override genie has applied and not yet reset — props, hook state, context, forced Suspense fallbacks, and forced error boundaries — with the target component, a human-readable detail (e.g. `title="GENIE OVERRIDE" (was "Activities")`, `hook 12 ← true`, `fallback forced`), and whether that target is still mounted. componentId is the live id when the target is still findable from the current root, else null with mounted:false (its subtree may have re-mounted with new ids). Use before react_reset_overrides to see what will be cleared.',
  group: 'action',
  input: z.object({}),
  output: z.object({
    overrides: z.array(
      z.object({
        kind: z.enum(['props', 'hook', 'context', 'suspense', 'error']),
        componentId: z
          .number()
          .nullable()
          .describe('Live id when the target is still mounted, else null.'),
        componentName: z.string(),
        detail: z.string().describe('What was overridden and (for props/context) the prior value.'),
        mounted: z.boolean(),
      }),
    ),
    total: z.number(),
  }),
  annotations: { readOnlyHint: true },
})

export const reactResetOverridesContract = defineAgentToolContract({
  name: 'react_reset_overrides',
  title: 'Reset all overrides (dev)',
  description:
    'Clear every override at once and return the app to its real state — the universal release and the recovery path when a forced-error/suspense boundary left the app stuck and the original id no longer resolves (react_force_error_boundary / react_toggle_suspense_fallback release by id, this does not need one). props, context, and hook overrides restore their captured pre-override value when the target is still mounted ("restored"); a hook target that unmounted or lost its renderer is "released" instead — the overridden value stays until the component\'s own next setState. Forced Suspense/error boundaries are released and re-rendered from module state even if unmounted. Each cleared override reports its outcome.',
  group: 'action',
  input: z.object({}),
  output: z.object({
    ok: z.literal(true),
    cleared: z.array(
      z.object({
        kind: z.enum(['props', 'hook', 'context', 'suspense', 'error']),
        componentName: z.string(),
        outcome: z
          .enum(['restored', 'released', 'skipped-unmounted'])
          .describe(
            'restored = pre-override value re-applied; released = cleared without restoring (forced boundaries, or a hook whose target/renderer is gone); skipped-unmounted = target gone, nothing to re-apply.',
          ),
      }),
    ),
    remaining: z.number().describe('Overrides still tracked after the reset (always 0).'),
  }),
  annotations: { destructiveHint: true, idempotentHint: true },
})

const renderPropChangeSchema = z.object({
  name: z.string(),
  kind: z.literal('props'),
  unstable: z.boolean(),
})

const renderStateChangeBase = z.object({
  name: z.string(),
  kind: z.literal('state'),
  unstable: z.literal(false),
  before: z.unknown().describe('Depth- and size-bounded value before this commit.'),
  after: z.unknown().describe('Depth- and size-bounded value after this commit.'),
})

const renderHookStateChangeSchema = renderStateChangeBase.extend({
  hook: z.object({
    index: z.number().int().describe("Flat position in the component's complete hook chain."),
    stateIndex: z
      .number()
      .int()
      .describe('Position among useState/useReducer hooks; accepted by react_override_hook_state.'),
    kind: z.enum(['state', 'reducer']),
  }),
})

const renderClassStateChangeSchema = renderStateChangeBase.extend({
  name: z.literal('class state'),
})

const renderComponentSchema = z.object({
  id: z.number(),
  name: z.string(),
  renders: z.number(),
  mounts: z.number(),
  updates: z.number(),
  unnecessary: z.number(),
  unstableRenders: z
    .number()
    .describe(
      'Updates whose only changes were unstable-reference props (no state/children change) — wasted renders that React.memo + stable refs would skip.',
    ),
  forget: z.boolean(),
  selfTime: z.number(),
  totalTime: z.number(),
  changes: z.array(
    z.union([renderPropChangeSchema, renderHookStateChangeSchema, renderClassStateChangeSchema]),
  ),
  source: sourceSchema,
  isLibrary: z.boolean(),
})

const renderSummarySchema = z.object({
  commits: z.number(),
  trackedComponents: z.number(),
  totalRenders: z.number(),
  totalUpdates: z.number(),
  unstableComponents: z.number().describe('Components with at least one unstable-prop render.'),
  unnecessaryComponents: z
    .number()
    .describe('Components with at least one fully-unnecessary render.'),
  topUnstableProps: z.array(z.object({ name: z.string(), count: z.number() })),
})

export const reactGetRendersContract = defineAgentToolContract({
  name: 'react_get_renders',
  title: 'Render report (why-did-render)',
  description:
    'Report which components re-rendered, how often, and WHY — changed prop names, exact useState/useReducer slots with bounded before/after values, unstable-reference flags (a new object/function each render that defeats memo), unnecessary renders, React Compiler ("forget") status, and self/total render time. Interact with the app first (or react_clear_renders to reset), then read this.',
  group: 'react.render',
  input: z.object({
    component: z.string().optional().describe('Only components whose name contains this string.'),
    sort: z.enum(['renders', 'unnecessary', 'unstable', 'selfTime']).default('renders'),
    limit: z.number().int().min(1).max(200).default(40),
    appOnly: z
      .boolean()
      .default(true)
      .describe(
        'Exclude library components (node_modules, incl. Vite pre-bundled deps like Base UI / cmdk / devtools). Default true so your own components surface above library noise; set false to include them.',
      ),
  }),
  output: z.object({
    tracking: z.boolean(),
    commits: z.number(),
    summary: renderSummarySchema,
    components: z.array(renderComponentSchema),
    filteredNote: z
      .string()
      .optional()
      .describe(
        'Present only when appOnly hid library components; names how many and how to include them.',
      ),
  }),
  annotations: { readOnlyHint: true },
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
  firesEveryUpdate: z.boolean(),
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
      'True when the effect was created inside a library hook (node_modules), not your code.',
    ),
})

export const reactEffectAuditContract = defineAgentToolContract({
  name: 'react_effect_audit',
  title: 'Effect audit (did effects fire & why)',
  description:
    'Audit useEffect / useLayoutEffect / useInsertionEffect executions: per component and per effect, whether it actually FIRED on each commit, how many of the observed updates it ran on, its dependency mode (none/empty/list), which dependency drove the most recent run, whether it returns a cleanup, and the effect\'s own call-site (file:line) — resolved per-effect, so an effect created inside a library hook resolves to that library, not your component. Surfaces effects re-running every commit — the signature of a refetch/setState loop that render counts alone cannot reveal. appOnly (default true) drops library-origin effects so your own effects surface above hook noise; when it hides any, a top-level filteredNote says how many, so an empty result reads as "filtered" not "no effects exist". Interact with the app (or react_clear_renders to reset) first, then read this.',
  group: 'react.render',
  input: z.object({
    component: z.string().optional().describe('Only components whose name contains this string.'),
    onlyHot: z
      .boolean()
      .default(false)
      .describe('Only components with an effect that re-runs every update or has no deps array.'),
    appOnly: z
      .boolean()
      .default(true)
      .describe(
        'Exclude library components AND library-origin effects (node_modules, incl. Vite pre-bundled deps) so your own effects surface above hook noise; set false to include them.',
      ),
    limit: z.number().int().min(1).max(200).default(40),
  }),
  output: z.object({
    tracking: z.boolean(),
    commits: z.number(),
    components: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        source: sourceSchema.describe("The component's definition site."),
        isLibrary: z.boolean(),
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

export const reactErrorStateContract = defineAgentToolContract({
  name: 'react_error_state',
  title: 'Error & suspense state (why is it blank/stuck?)',
  description:
    'Report error boundaries that have caught an error (with the boundary + throwing component, the message/stack, and their source file:line) and Suspense boundaries currently showing a fallback. Answers "why is the page blank or stuck?" — a render/tree snapshot cannot show a caught error or a suspended subtree. Recorded at commit time, so call it after the blank/stuck state appears. Boundaries you are holding open with react_force_error_boundary / react_toggle_suspense_fallback are included and flagged `forced:true` (release them with react_reset_overrides); real errors/suspends are `forced:false`.',
  group: 'react.render',
  input: z.object({
    includeSource: z
      .boolean()
      .default(true)
      .describe('Resolve the file:line of each boundary/component (async source-map lookup).'),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  output: z.object({
    caughtErrors: z.array(
      z.object({
        boundaryId: z.number(),
        boundaryName: z.string(),
        boundarySource: sourceSchema,
        throwingComponent: z.string().nullable(),
        message: z.string().nullable(),
        stack: z.string().nullable().describe('The thrower’s file:line is in this stack.'),
        isLibraryBoundary: z.boolean(),
        forced: z
          .boolean()
          .describe(
            'true = held open by react_force_error_boundary (no real throw); false = a real caught error.',
          ),
      }),
    ),
    suspended: z.array(
      z.object({
        boundaryId: z.number(),
        boundaryName: z.string(),
        source: sourceSchema,
        isFallbackShowing: z.boolean(),
        forced: z
          .boolean()
          .describe(
            'true = held open by react_toggle_suspense_fallback; false = a real pending resource.',
          ),
      }),
    ),
    blankTreeHint: z.string().nullable(),
  }),
  annotations: { readOnlyHint: true },
})

export const reactClearRendersContract = defineAgentToolContract({
  name: 'react_clear_renders',
  title: 'Clear render data',
  description:
    'Reset the render/commit counters. Call this before an interaction to measure exactly that interaction.',
  group: 'react.render',
  input: z.object({}),
  output: z.object({ ok: z.boolean(), tracking: z.boolean() }),
  annotations: { idempotentHint: true },
})

export const reactProfileStartContract = defineAgentToolContract({
  name: 'react_profile_start',
  title: 'Start profiling',
  description:
    'Begin (or resume) a profiling session — enables commit tracking and clears render counters. Then interact with the app and call react_profile_report, or react_profile_stop to pause. For a before/after regression verdict: react_profile_snapshot (label the "before"), make the change, then react_renders_diff — no hand-diffing two JSON dumps.',
  group: 'react.profile',
  input: z.object({}),
  output: z.object({ ok: z.boolean(), tracking: z.boolean() }),
  annotations: { idempotentHint: true },
})

const renderDeltaSchema = z.object({
  name: z.string(),
  source: z.string().optional().describe('file:line when resolved.'),
  deltaMs: z.number().describe('after.selfTime − before.selfTime, ms (positive = slower).'),
  before: z.object({ renders: z.number(), selfTime: z.number() }),
  after: z.object({ renders: z.number(), selfTime: z.number() }),
})

export const reactProfileStopContract = defineAgentToolContract({
  name: 'react_profile_stop',
  title: 'Stop profiling',
  description:
    'Pause the profiling session — the commit counter freezes and isTracking() reports false until react_profile_start resumes. The captured aggregates and any snapshots are kept, so react_profile_report and react_renders_diff still work after stopping. The underlying instrumentation stays installed (React commits simply stop being recorded); this is the symmetric counterpart to react_profile_start.',
  group: 'react.profile',
  input: z.object({}),
  output: z.object({
    ok: z.literal(true),
    tracking: z.literal(false),
    commits: z.number().describe('Commits recorded up to the stop.'),
  }),
  annotations: { idempotentHint: true },
})

export const reactProfileSnapshotContract = defineAgentToolContract({
  name: 'react_profile_snapshot',
  title: 'Snapshot render aggregates',
  description:
    'Capture the current per-component render aggregates (renders/mounts/updates, self & total time, unnecessary & unstable renders) under a label, as the "before" baseline for react_renders_diff. Take one before applying a fix (e.g. adding memo/useCallback), make the change and interact, then call react_renders_diff to get the regression/improvement verdict. Re-using a label overwrites that snapshot. Library components are excluded, matching the other react reads.',
  group: 'react.profile',
  input: z.object({
    label: z
      .string()
      .default('baseline')
      .describe(
        'Name for this snapshot; react_renders_diff reads it back. Reused labels overwrite.',
      ),
  }),
  output: z.object({
    ok: z.literal(true),
    label: z.string(),
    commits: z.number(),
    components: z.number().describe('Components captured in this snapshot.'),
  }),
  annotations: { readOnlyHint: true },
})

export const reactRendersDiffContract = defineAgentToolContract({
  name: 'react_renders_diff',
  title: 'Diff renders vs a snapshot',
  description:
    'The before/after regression verdict: joins a react_profile_snapshot baseline against the CURRENT live aggregates (by component name + source file:line when resolved, else name) and reports which components got slower (regressed) or faster (improved) by more than thresholdMs of self-time, plus components that appeared (added) or vanished (removed) and the overall self-time change. Sorted by |delta| so the biggest movers lead. Take a snapshot, apply your change, interact, then call this — no hand-diffing two react_get_renders dumps. Check clearsSinceBaseline to know what you compared: 0 means the baseline shares this session (after includes before), ≥1 means counters were cleared since the snapshot (react_clear_renders or react_profile_start), so this is a session-vs-session compare — only meaningful when both sessions drove the same interaction, and "removed" then just means "has not re-rendered since the clear".',
  group: 'react.profile',
  input: z.object({
    baseline: z
      .string()
      .default('baseline')
      .describe('Snapshot label from react_profile_snapshot to compare against.'),
    thresholdMs: z
      .number()
      .default(0.5)
      .describe('Minimum self-time delta (ms) for a component to count as regressed/improved.'),
  }),
  output: z.object({
    baseline: z.string(),
    commits: z.object({ before: z.number(), after: z.number() }),
    clearsSinceBaseline: z
      .number()
      .describe(
        'How many times counters were cleared after the snapshot; 0 = additive same-session compare, ≥1 = session-vs-session (commits.before can exceed commits.after).',
      ),
    selfTimeMs: z.object({
      before: z.number(),
      after: z.number(),
      delta: z.number(),
      pct: z
        .number()
        .nullable()
        .describe('delta/before*100 to 1dp; null when the baseline self-time was 0.'),
    }),
    regressed: z.array(renderDeltaSchema),
    improved: z.array(renderDeltaSchema),
    added: z.array(z.object({ name: z.string(), renders: z.number(), selfTime: z.number() })),
    removed: z.array(z.object({ name: z.string() })),
  }),
  annotations: { readOnlyHint: true },
})

export const reactProfileReportContract = defineAgentToolContract({
  name: 'react_profile_report',
  title: 'Profiling report',
  description:
    'Summarize the profiling session: slowest components by render time, most re-rendered, most unnecessary renders, and most renders wasted on unstable-reference props.',
  group: 'react.profile',
  input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
  output: z.object({
    commits: z.number(),
    tracking: z.boolean(),
    slowest: z.array(
      z.object({ id: z.number(), name: z.string(), selfTime: z.number(), renders: z.number() }),
    ),
    mostRerendered: z.array(
      z.object({ id: z.number(), name: z.string(), renders: z.number(), unnecessary: z.number() }),
    ),
    mostUnnecessary: z.array(
      z.object({ id: z.number(), name: z.string(), unnecessary: z.number(), renders: z.number() }),
    ),
    mostUnstable: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        unstableRenders: z.number(),
        renders: z.number(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true },
})
