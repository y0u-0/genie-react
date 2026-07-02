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
      .default(false)
      .describe(
        'Fold each library subtree (node_modules, incl. Vite pre-bundled deps) into a single node and label anonymous nodes by file:line. Off by default (structural view).',
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
  }),
  annotations: { readOnlyHint: true },
})

export const reactFindComponentsContract = defineAgentToolContract({
  name: 'react_find_components',
  title: 'Find React components',
  description:
    'Find mounted components by display name (substring match, or exact). Returns ids and an ancestor path for each match.',
  group: 'react.tree',
  input: z.object({
    query: z.string().min(1),
    exact: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    matches: z.array(z.object({ id: z.number(), name: z.string(), path: z.string() })),
  }),
  annotations: { readOnlyHint: true },
})

export const reactInspectComponentContract = defineAgentToolContract({
  name: 'react_inspect_component',
  title: 'Inspect a React component',
  description:
    'Inspect a component by id: its props, plus state (class components) or hooks (function components), depth-bounded. Pass `path` to hydrate deeper into a nested prop value.',
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
    hooks: z.array(z.unknown()),
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
    'Set a hook\'s state by index and re-render — drive a function component into any state (a wizard step, an open modal, an invalid form) without a multi-step UI script. hookIndex is the index react_inspect_component reports; only stateful hooks (useState/useReducer) can be overridden. `path` targets a nested field of the state value (e.g. ["filters","page"]); omit it to replace the whole value. The component\'s own next setState takes back control.',
  group: 'action',
  input: z.object({
    id: nodeIdSchema,
    hookIndex: z
      .number()
      .int()
      .min(0)
      .max(MAX_HOOKS - 1)
      .describe('Hook index as shown by react_inspect_component.'),
    path: z
      .array(z.union([z.string(), z.number()]))
      .default([])
      .describe('Path into the hook value; empty replaces the whole value.'),
    value: z.unknown(),
  }),
  output: z.object({ ok: z.boolean(), name: z.string(), hookIndex: z.number() }),
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
    'Hold the nearest Suspense boundary at/above a component in its fallback (loading) state, or release it — a state normally visible for milliseconds becomes one you can inspect and screenshot to verify loading UI. Pass any component id inside the boundary, or a boundaryId from react_error_state. Persists until released with showFallback:false or a page reload.',
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
    'Make the nearest error boundary at/above a component catch a simulated error, or release it — verify error UI renders and that the intended boundary contains the failure, without manufacturing a real crash. Pass any component id inside the boundary. Release with the returned boundaryId and forceError:false — the original child id unmounts while the boundary is erroring; children then remount fresh.',
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
  changes: z.array(z.object({ name: z.string(), kind: z.string(), unstable: z.boolean() })),
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
    'Report which components re-rendered, how often, and WHY — prop/state changes with unstable-reference flags (a new object/function each render that defeats memo), how many renders were unnecessary, React Compiler ("forget") status, and self/total render time. Interact with the app first (or react_clear_renders to reset), then read this.',
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
    "Audit useEffect / useLayoutEffect / useInsertionEffect executions: per component and per effect, whether it actually FIRED on each commit, how many of the observed updates it ran on, its dependency mode (none/empty/list), which dependency drove the most recent run, whether it returns a cleanup, and the effect's own call-site (file:line) — resolved per-effect, so an effect created inside a library hook resolves to that library, not your component. Surfaces effects re-running every commit — the signature of a refetch/setState loop that render counts alone cannot reveal. appOnly (default true) drops library-origin effects so your own effects surface above hook noise. Interact with the app (or react_clear_renders to reset) first, then read this.",
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
  }),
  annotations: { readOnlyHint: true },
})

export const reactErrorStateContract = defineAgentToolContract({
  name: 'react_error_state',
  title: 'Error & suspense state (why is it blank/stuck?)',
  description:
    'Report error boundaries that have caught an error (with the boundary + throwing component, the message/stack, and their source file:line) and Suspense boundaries currently showing a fallback. Answers "why is the page blank or stuck?" — a render/tree snapshot cannot show a caught error or a suspended subtree. Recorded at commit time, so call it after the blank/stuck state appears.',
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
      }),
    ),
    suspended: z.array(
      z.object({
        boundaryId: z.number(),
        boundaryName: z.string(),
        source: sourceSchema,
        isFallbackShowing: z.boolean(),
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
    'Begin a profiling session (clears render counters). Then interact with the app and call react_profile_report.',
  group: 'react.profile',
  input: z.object({}),
  output: z.object({ ok: z.boolean(), tracking: z.boolean() }),
  annotations: { idempotentHint: true },
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
