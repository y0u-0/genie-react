import type { BridgeStatusMessage } from 'genie-react/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatGroupIndex,
  formatToolDetail,
  formatToolsListing,
  parseBatchItems,
  projectFields,
  relatedActions,
  renderResult,
  resolveSession,
  resolveToolsSelector,
  summarizeEffects,
  summarizeErrorState,
  summarizeFps,
  summarizeInspect,
  summarizeListOverrides,
  summarizeProfile,
  summarizeProfileSnapshot,
  summarizeQueryList,
  summarizeRenders,
  summarizeRendersDiff,
  summarizeResetOverrides,
  summarizeRouterRoutes,
  summarizeRouterState,
  summarizeStatus,
  summarizeTree,
} from './agent'

type ToolDescriptor = BridgeStatusMessage['tools'][number]

function listing(tools: ToolDescriptor[]): string {
  return formatToolsListing({
    app: { name: 'Test App' },
    tools,
  } as unknown as BridgeStatusMessage)
}

function tool(partial: Partial<ToolDescriptor> & { name: string }): ToolDescriptor {
  return { title: partial.name, group: 'query', ...partial } as ToolDescriptor
}

describe('formatToolsListing', () => {
  it('marks optional params with ? and lists required params bare', () => {
    const out = listing([
      tool({
        name: 'plugin_get_events',
        title: 'Get plugin events',
        group: 'plugin',
        inputJsonSchema: {
          type: 'object',
          properties: { pluginId: { type: 'string' }, limit: { type: 'integer' } },
          required: ['pluginId'],
        },
      }),
    ])

    expect(out).toContain('plugin_get_events — Get plugin events')
    expect(out).toContain('pluginId: string, limit?: integer')
  })

  it('renders enum unions and (no args)', () => {
    const out = listing([
      tool({
        name: 'react_get_renders',
        group: 'react.render',
        inputJsonSchema: {
          type: 'object',
          properties: { sort: { enum: ['renders', 'unstable'] } },
          required: [],
        },
      }),
      tool({
        name: 'query_clear',
        group: 'query',
        inputJsonSchema: { type: 'object', properties: {} },
      }),
    ])

    expect(out).toContain('sort?: "renders" | "unstable"')
    expect(out).toContain('query_clear')
    expect(out).toContain('(no args)')
  })

  it('unwraps the allOf wrapper a refined zod schema emits', () => {
    const out = listing([
      tool({
        name: 'query_get',
        inputJsonSchema: {
          allOf: [
            {
              type: 'object',
              properties: { queryHash: { type: 'string' }, queryKey: { type: 'array' } },
              required: [],
            },
          ],
        },
      }),
    ])

    expect(out).toContain('queryHash?: string, queryKey?: array')
  })
})

const rendersPayload = {
  tracking: true,
  commits: 6,
  summary: {
    commits: 6,
    trackedComponents: 2,
    totalRenders: 9,
    totalUpdates: 7,
    unstableComponents: 1,
    unnecessaryComponents: 1,
    topUnstableProps: [
      { name: 'onClick', count: 3 },
      { name: 'style', count: 2 },
    ],
  },
  components: [
    {
      id: 1,
      name: 'Dashboard',
      renders: 5,
      mounts: 1,
      updates: 4,
      unnecessary: 2,
      unstableRenders: 3,
      forget: false,
      selfTime: 1.23,
      totalTime: 5,
      changes: [
        { name: 'onClick', kind: 'props', unstable: true },
        { name: 'count', kind: 'props', unstable: false },
      ],
    },
    {
      id: 2,
      name: 'Row',
      renders: 4,
      mounts: 4,
      updates: 0,
      unnecessary: 0,
      unstableRenders: 0,
      forget: true,
      selfTime: 0.4,
      totalTime: 1,
      changes: [],
    },
  ],
}

describe('summarizeRenders', () => {
  it('renders a header, unstable-prop line, and one padded line per component', () => {
    const lines = summarizeRenders(rendersPayload)?.split('\n')
    expect(lines?.[0]).toBe(
      '6 commits · 2 components · 9 renders · 7 updates · 1 unstable · 1 unnecessary',
    )
    expect(lines?.[1]).toBe('unstable props: onClick×3, style×2')
    expect(lines?.[2]).toBe(
      '  Dashboard #1 5× (1m 4u) · 2 unnec · 3 unstable · self 1.2ms · ↻ props: onClick(unstable), count',
    )
    expect(lines?.[3]).toContain('Row')
    expect(lines?.[3]).toContain('4× (4m 0u) · forget · self 0.4ms')
    expect(lines?.[3]).not.toContain('unnec')
    expect(lines?.[3]).not.toContain('unstable')
  })

  it('tolerates components both with and without the optional source field', () => {
    const withSource = {
      ...rendersPayload,
      components: [
        {
          ...rendersPayload.components[0],
          source: {
            file: 'src/components/Dashboard.tsx',
            line: 12,
            column: 4,
            functionName: 'Dashboard',
          },
          isLibrary: false,
        },
      ],
    }
    expect(summarizeRenders(withSource)).toContain('(Dashboard.tsx:12)')
    expect(summarizeRenders(rendersPayload)).not.toContain('Dashboard.tsx')
  })

  it('returns null on a malformed shape', () => {
    expect(summarizeRenders(null)).toBeNull()
    expect(summarizeRenders({})).toBeNull()
    expect(summarizeRenders({ summary: {}, components: 'nope' })).toBeNull()
  })

  it('keeps the legacy generic state marker from older app clients', () => {
    const payload = {
      ...rendersPayload,
      components: [
        {
          ...rendersPayload.components[0],
          changes: [
            { name: 'style', kind: 'props', unstable: true },
            { name: 'onClick', kind: 'props', unstable: false },
            { name: '(state/hooks)', kind: 'state', unstable: false },
          ],
        },
      ],
    }
    const line = summarizeRenders(payload)?.split('\n')[2]
    expect(line).toContain('↻ props: style(unstable), onClick · state')
  })

  it('shows a bare legacy state marker when only state changed', () => {
    const payload = {
      ...rendersPayload,
      components: [
        {
          ...rendersPayload.components[0],
          changes: [{ name: '(state/hooks)', kind: 'state', unstable: false }],
        },
      ],
    }
    expect(summarizeRenders(payload)?.split('\n')[2]).toContain('↻ state')
  })

  it('shows exact state and reducer slots with compact before/after values', () => {
    const payload = {
      ...rendersPayload,
      components: [
        {
          ...rendersPayload.components[0],
          changes: [
            {
              name: 'state[0]',
              kind: 'state',
              unstable: false,
              hook: { index: 0, stateIndex: 0, kind: 'state' },
              before: false,
              after: true,
            },
            {
              name: 'reducer[1]',
              kind: 'state',
              unstable: false,
              hook: { index: 2, stateIndex: 1, kind: 'reducer' },
              before: { items: 1 },
              after: { items: 2 },
            },
          ],
        },
      ],
    }

    expect(summarizeRenders(payload)?.split('\n')[2]).toContain(
      '↻ state[0] false→true · reducer[1] items=1→items=2',
    )
  })
})

const effectsPayload = {
  tracking: true,
  commits: 4,
  components: [
    {
      id: 7,
      name: 'Search',
      effects: [
        {
          index: 0,
          kind: 'effect',
          depsMode: 'list',
          depCount: 2,
          fired: 4,
          updates: 4,
          firesEveryUpdate: true,
          lastChangedDep: 1,
          hasCleanup: false,
          note: 'refetch on every keystroke',
        },
        {
          index: 1,
          kind: 'layout',
          depsMode: 'empty',
          depCount: 0,
          fired: 0,
          updates: 4,
          firesEveryUpdate: false,
          lastChangedDep: null,
          hasCleanup: true,
        },
      ],
    },
  ],
}

describe('summarizeEffects', () => {
  it('renders a header and one line per effect with flags and notes', () => {
    const lines = summarizeEffects(effectsPayload)?.split('\n')
    expect(lines?.[0]).toBe('4 commits · 1 components with effects')
    expect(lines?.[1]).toBe(
      '  Search #7 [0] effect deps=list(2) fired 4/4 EVERY no-cleanup · ⚠ refetch on every keystroke',
    )
    expect(lines?.[2]).toBe('  Search #7 [1] layout deps=empty(0) fired 0/4 cleanup')
  })

  it('tolerates effects both with and without the optional source field', () => {
    const withSource = {
      commits: 4,
      components: [
        {
          id: 7,
          name: 'Search',
          effects: [
            {
              index: 0,
              kind: 'effect',
              depsMode: 'list',
              depCount: 2,
              fired: 4,
              updates: 4,
              firesEveryUpdate: true,
              hasCleanup: false,
              source: { file: 'src/Search.tsx', line: 30, column: 2, functionName: 'Search' },
              isLibrary: false,
            },
          ],
        },
      ],
    }
    expect(summarizeEffects(withSource)).toContain('(Search.tsx:30)')
    expect(summarizeEffects(effectsPayload)).not.toContain('Search.tsx')
  })

  it('returns null on a malformed shape', () => {
    expect(summarizeEffects(42)).toBeNull()
    expect(summarizeEffects({ components: 'nope' })).toBeNull()
  })
})

const treePayload = {
  rootId: 1,
  total: 5,
  truncated: true,
  truncatedBy: 'maxNodes',
  nodes: [
    { id: 1, parentId: null, name: 'App', key: null, kind: 'component' },
    { id: 2, parentId: 1, name: 'Layout', key: null, kind: 'component' },
    { id: 3, parentId: 2, name: 'div', key: null, kind: 'host' },
    { id: 4, parentId: 2, name: 'Row', key: 'a', kind: 'component' },
  ],
}

describe('summarizeInspect', () => {
  it('renders each hook with its kind, stateful ordinal, and value in the text view', () => {
    const text = summarizeInspect({
      id: 7,
      name: 'Wizard',
      kind: 'function',
      props: { step: 1 },
      hooks: [
        { index: 0, kind: 'state', stateful: true, stateIndex: 0, value: false },
        { index: 1, kind: 'effect', stateful: false },
      ],
    })
    expect(text).toContain('hooks: 2')
    expect(text).toContain('[0] state stateIndex 0 = false')
    expect(text).toContain('[1] effect')
  })
})

describe('summarizeTree', () => {
  it('renders a header and a depth-indented outline reconstructed from parentId', () => {
    const lines = summarizeTree(treePayload)?.split('\n')
    expect(lines?.[0]).toBe('4/5 nodes · root #1 · truncated by maxNodes')
    expect(lines?.[1]).toBe('App')
    expect(lines?.[2]).toBe('  Layout')
    expect(lines?.[3]).toBe('    <div>')
    expect(lines?.[4]).toBe('    Row key=a')
  })

  it('returns null on a malformed shape', () => {
    expect(summarizeTree(null)).toBeNull()
    expect(summarizeTree({ nodes: 'nope' })).toBeNull()
  })
})

describe('renderResult', () => {
  it('returns terse output for a known tool with a valid shape', () => {
    const out = renderResult('react_get_renders', rendersPayload)
    expect(out).toContain('6 commits · 2 components')
    expect(out).not.toBe(JSON.stringify(rendersPayload, null, 2))
  })

  it('prints compact machine JSON when json is true', () => {
    expect(renderResult('react_get_renders', rendersPayload, true)).toBe(
      JSON.stringify(rendersPayload),
    )
  })

  it('falls back to pretty JSON for an unknown tool', () => {
    const payload = { a: 1, b: [2, 3] }
    expect(renderResult('devtools_status', payload)).toBe(JSON.stringify(payload, null, 2))
  })

  it('falls back to pretty JSON when the summarizer returns null', () => {
    const malformed = { summary: {}, components: 'nope' }
    expect(renderResult('react_get_renders', malformed)).toBe(JSON.stringify(malformed, null, 2))
  })
})

const CATALOG = [
  tool({ name: 'react_get_renders', title: 'Why-did-render', group: 'react.render' }),
  tool({ name: 'react_clear_renders', title: 'Clear counters', group: 'react.render' }),
  tool({
    name: 'query_list',
    title: 'List queries',
    group: 'query',
    inputJsonSchema: {
      type: 'object',
      properties: {
        staleOnly: { type: 'boolean', default: false },
        limit: { type: 'integer', default: 100, description: 'Max entries.' },
      },
      required: [],
    },
  }),
  tool({
    name: 'plugin_get_events',
    title: 'Get plugin events',
    group: 'plugin',
    description: 'Read buffered plugin events.',
    inputJsonSchema: {
      type: 'object',
      properties: { pluginId: { type: 'string' }, limit: { type: 'integer', default: 50 } },
      required: ['pluginId'],
    },
  }),
]

describe('progressive tools discovery', () => {
  it('formatGroupIndex renders counts, previews, and the drill-down footer', () => {
    const index = formatGroupIndex('Demo', CATALOG)
    expect(index).toContain('4 tools from Demo · 3 groups')
    expect(index).toContain('react.render')
    expect(index).toContain('react_get_renders, react_clear_renders')
    expect(index).toContain('genie-react tools <group>')
    expect(index).not.toContain('staleOnly')
  })

  it('resolveToolsSelector prefers exact tool, then group, then suggests', () => {
    expect(resolveToolsSelector(CATALOG, 'query_list')).toMatchObject({ kind: 'tool' })
    const group = resolveToolsSelector(CATALOG, 'react.render')
    expect(group.kind).toBe('group')
    if (group.kind === 'group') expect(group.tools).toHaveLength(2)
    const unknown = resolveToolsSelector(CATALOG, 'renders')
    expect(unknown.kind).toBe('unknown')
    if (unknown.kind === 'unknown') {
      expect(unknown.message).toContain('react_get_renders')
      expect(unknown.message).toContain('Groups: plugin, query, react.render')
    }
  })

  it('relatedActions surfaces a domain’s mutations pooled in the action group', () => {
    const catalog = [
      ...CATALOG,
      tool({ name: 'router_navigate', title: 'Navigate', group: 'action' }),
      tool({ name: 'query_invalidate', title: 'Invalidate', group: 'action' }),
      tool({ name: 'react_override_props', title: 'Override', group: 'action' }),
    ]
    expect(relatedActions(catalog, 'router')).toEqual(['router_navigate'])
    expect(relatedActions(catalog, 'query')).toEqual(['query_invalidate'])
    expect(relatedActions(catalog, 'react.render')).toEqual(['react_override_props'])
    expect(relatedActions(catalog, 'action')).toEqual([])
    expect(relatedActions(catalog, 'memory')).toEqual([])
  })

  it('formatToolDetail shows the description, per-param lines, and a runnable example', () => {
    const detail = formatToolDetail(CATALOG[3] as never)
    expect(detail).toContain('plugin_get_events — Get plugin events [plugin]')
    expect(detail).toContain('Read buffered plugin events.')
    expect(detail).toContain('pluginId: string')
    expect(detail).toContain('limit?: integer (default 50)')
    expect(detail).toContain(
      `example: genie-react call plugin_get_events '{"pluginId":"<pluginId>"}'`,
    )
  })
})

describe('new summarizers', () => {
  it('summarizeStatus: single session is one line; multi-session lists full ids', () => {
    expect(
      summarizeStatus({
        connected: true,
        app: { name: 'Demo', reactVersion: '19.2.7' },
        toolCount: 51,
        sessions: [{ sessionId: 'abc', app: { name: 'Demo' }, current: true }],
      }),
    ).toBe('connected · Demo · react 19.2.7 · 51 tools')
    const multi = summarizeStatus({
      connected: true,
      app: { name: 'Demo' },
      toolCount: 51,
      sessions: [
        { sessionId: 'aaa-111', app: { url: 'http://x/?_genie=a' }, current: true },
        { sessionId: 'bbb-222', app: { url: 'http://x/?_genie=b' }, current: false },
      ],
    })
    expect(multi).toContain('2 sessions')
    expect(multi).toContain('aaa-111 · http://x/?_genie=a · (current)')
    expect(multi).toContain('--session <id>')
    expect(summarizeStatus({ connected: false, sessions: [] })).toContain('not connected')
    expect(summarizeStatus({ nope: 1 })).toBeNull()
  })

  it('summarizeQueryList: header flags + one line per query', () => {
    const outText = summarizeQueryList({
      total: 2,
      churn: { orphaned: 1, families: [] },
      queries: [
        {
          queryHash: '["a"]',
          queryKey: ['a'],
          status: 'success',
          fetchStatus: 'idle',
          isStale: true,
          isActive: true,
          observerCount: 1,
          dataUpdatedAt: 1,
          recentFetches: 3,
        },
      ],
    })
    expect(outText).toContain('2 queries (showing 1) · 1 stale · ⚠ 1 orphaned (churn)')
    expect(outText).toContain('["a"] · success · stale · 1 obs · ⚠ 3 fetches/10s')
    expect(summarizeQueryList({ queries: 'nope' })).toBeNull()
  })

  it('summarizeErrorState: caught + suspended + hint; empty state is one calm line', () => {
    const outText = summarizeErrorState({
      caughtErrors: [
        {
          boundaryId: 47,
          boundaryName: 'LabErrorBoundary',
          boundarySource: { file: 'src/App.tsx', line: 59, column: 1, functionName: null },
          throwingComponent: 'Bomb',
          message: 'boom',
          stack: null,
          isLibraryBoundary: false,
        },
      ],
      suspended: [
        {
          boundaryId: 71,
          boundaryName: 'Zone',
          source: null,
          isFallbackShowing: true,
        },
      ],
      blankTreeHint: 'subtree unmounted',
    })
    expect(outText).toContain('1 caught · 1 suspended')
    expect(outText).toContain('LabErrorBoundary #47 caught "boom" from Bomb (src/App.tsx:59)')
    expect(outText).toContain('Zone #71 fallback SHOWING')
    expect(outText).toContain('hint: subtree unmounted')
    expect(summarizeErrorState({ caughtErrors: [], suspended: [] })).toBe(
      'no caught errors · nothing suspended',
    )
  })

  it('summarizeProfile: four leaderboards on one screen', () => {
    const outText = summarizeProfile({
      commits: 5,
      tracking: true,
      slowest: [{ id: 1, name: 'Dash', selfTime: 12.06, renders: 5 }],
      mostRerendered: [{ id: 2, name: 'Row', renders: 9, unnecessary: 4 }],
      mostUnnecessary: [{ id: 2, name: 'Row', unnecessary: 4, renders: 9 }],
      mostUnstable: [{ id: 3, name: 'Badge', unstableRenders: 3, renders: 5 }],
    })
    expect(outText).toContain('5 commits')
    expect(outText).toContain('slowest: Dash 12.1ms×5')
    expect(outText).toContain('re-rendered: Row 9×')
    expect(outText).toContain('unnecessary: Row 4/9')
    expect(outText).toContain('unstable: Badge 3/5')
  })

  it('summarizeFps: verdict, average, and stall detail on one line', () => {
    const outText = summarizeFps({
      durationMs: 2000,
      frames: 96,
      avgFps: 48,
      worstFrameMs: 87.3,
      longFrames: 4,
      droppedFrames: 22,
      refreshRate: 60,
      hidden: false,
      verdict: 'degraded',
    })
    expect(outText).toContain('degraded · avg 48 fps over 2000ms (96 frames @ 60Hz)')
    expect(outText).toContain('22 dropped')
    expect(outText).toContain('4 long (>50ms), worst 87.3ms')
    expect(outText).not.toContain('hidden')
    expect(summarizeFps({ nope: true })).toBeNull()
  })

  it('summarizeFps: flags a hidden tab as unreliable', () => {
    const outText = summarizeFps({
      durationMs: 2000,
      frames: 10,
      avgFps: 5,
      worstFrameMs: 900,
      longFrames: 1,
      droppedFrames: 50,
      refreshRate: 60,
      hidden: true,
      verdict: 'janky',
    })
    expect(outText).toContain('⚠ tab was hidden — unreliable')
  })

  it('summarizeRouterRoutes: total + one line per route with loader flags', () => {
    const outText = summarizeRouterRoutes({
      total: 3,
      routes: [
        { routeId: '__root__', fullPath: '/', hasLoader: false, hasBeforeLoad: false },
        { routeId: '/error', fullPath: '/error', hasLoader: true, hasBeforeLoad: false },
      ],
    })
    expect(outText).toContain('3 routes')
    expect(outText).toContain('  /error · loader')
    expect(summarizeRouterRoutes({ routes: 'nope' })).toBeNull()
  })

  it('bounds array-valued data previews instead of dumping the array', () => {
    const metrics = Array.from({ length: 50 }, (_, index) => ({ t: index, value: index * 2 }))
    const outText = renderResult('query_get', {
      queryHash: '["m"]',
      queryKey: ['m'],
      status: 'success',
      fetchStatus: 'idle',
      isStale: false,
      data: metrics,
    })
    expect(outText).toContain('data: [50 items] first: {t, value}')
    expect(outText.length).toBeLessThan(200)
  })

  it('small flat action results render as one line instead of pretty JSON', () => {
    expect(renderResult('router_navigate', { ok: true, pathname: '/error' })).toBe(
      'ok=true · pathname="/error"',
    )
    expect(renderResult('react_clear_renders', { ok: true, tracking: true })).toBe(
      'ok=true · tracking=true',
    )
  })

  it('generic basenames keep one parent segment in source suffixes', () => {
    const payload = {
      ...rendersPayload,
      components: [
        {
          ...rendersPayload.components[0],
          source: { file: 'src/routes/index.tsx', line: 106, column: 2, functionName: null },
        },
      ],
    }
    expect(summarizeRenders(payload)).toContain('(routes/index.tsx:106)')
  })

  it('summarizeRouterState: one line with location, status, and match counts', () => {
    expect(
      summarizeRouterState({
        pathname: '/dash',
        searchStr: '?tab=kpi',
        href: '/dash?tab=kpi',
        status: 'idle',
        isLoading: false,
        isTransitioning: false,
        matchCount: 2,
        pendingMatchCount: 0,
      }),
    ).toBe('"/dash?tab=kpi" · idle · 2 matches')
  })
})

describe('override + diff summarizers', () => {
  it('summarizeListOverrides: header + one line each, (unmounted) flag, and a calm zero state', () => {
    const outText = summarizeListOverrides({
      total: 2,
      overrides: [
        {
          kind: 'props',
          componentId: 12,
          componentName: 'Button',
          detail: 'disabled=true',
          mounted: true,
        },
        {
          kind: 'hook',
          componentId: null,
          componentName: 'useAuth',
          detail: 'user=null',
          mounted: false,
        },
      ],
    })
    expect(outText).toContain('2 active overrides')
    expect(outText).toContain('  [props] Button #12 — disabled=true')
    expect(outText).toContain('  [hook] useAuth — user=null (unmounted)')
    expect(summarizeListOverrides({ total: 0, overrides: [] })).toBe('no active overrides')
    expect(summarizeListOverrides({ nope: 1 })).toBeNull()
  })

  it('summarizeResetOverrides: cleared/remaining header + one line per entry', () => {
    const outText = summarizeResetOverrides({
      ok: true,
      cleared: [
        { kind: 'props', componentName: 'Button', outcome: 'restored' },
        { kind: 'hook', componentName: 'useAuth', outcome: 'skipped-unmounted' },
      ],
      remaining: 1,
    })
    expect(outText).toContain('cleared 2 overrides · 1 remaining')
    expect(outText).toContain('  [props] Button — restored')
    expect(outText).toContain('  [hook] useAuth — skipped-unmounted')
    expect(summarizeResetOverrides({ nope: 1 })).toBeNull()
  })

  it('summarizeRendersDiff: verdict header with sign + top regressed/improved lines', () => {
    const outText = summarizeRendersDiff({
      baseline: 'before-fix',
      commits: { before: 10, after: 6 },
      selfTimeMs: { before: 40, after: 25, delta: -15, pct: -37.5 },
      regressed: [
        {
          name: 'Row',
          deltaMs: 3.2,
          before: { renders: 2, selfTime: 1 },
          after: { renders: 5, selfTime: 4.2 },
        },
      ],
      improved: [
        {
          name: 'Dashboard',
          deltaMs: -18.2,
          before: { renders: 9, selfTime: 20 },
          after: { renders: 3, selfTime: 1.8 },
        },
      ],
    })
    expect(outText).toContain('40ms → 25ms (-37.5%) · commits 10→6 · 1 regressed · 1 improved')
    expect(outText).toContain('  Row +3.2ms')
    expect(outText).toContain('  Dashboard -18.2ms')
    expect(summarizeRendersDiff({ nope: 1 })).toBeNull()
  })

  it('summarizeRendersDiff: positive pct gets a + sign', () => {
    const outText = summarizeRendersDiff({
      baseline: 'b',
      commits: { before: 4, after: 8 },
      selfTimeMs: { before: 10, after: 22, delta: 12, pct: 120 },
      regressed: [],
      improved: [],
    })
    expect(outText).toContain('10ms → 22ms (+120%)')
  })

  it('summarizeProfileSnapshot: a single line', () => {
    expect(
      summarizeProfileSnapshot({ ok: true, label: 'baseline', commits: 6, components: 12 }),
    ).toBe('snapshot "baseline" · 6 commits · 12 components')
    expect(summarizeProfileSnapshot({ nope: 1 })).toBeNull()
  })
})

describe('renderResult: --fields projection', () => {
  it('projects the first array-of-records to JSONL with only the requested keys', () => {
    const result = {
      total: 2,
      matches: [
        { id: 1, name: 'Button', path: 'App/Button', extra: 'drop-me' },
        { id: 2, name: 'Row', path: 'App/Row' },
      ],
    }
    const outText = renderResult('react_find_components', result, false, ['id', 'name'])
    expect(outText.split('\n')).toEqual(['{"id":1,"name":"Button"}', '{"id":2,"name":"Row"}'])
  })

  it('omits missing keys rather than emitting undefined', () => {
    const outText = projectFields({ nodes: [{ id: 1 }, { id: 2, name: 'x' }] }, ['id', 'name'])
    expect(outText.split('\n')).toEqual(['{"id":1}', '{"id":2,"name":"x"}'])
  })

  it('projects the top-level object when there is no array-of-records', () => {
    const outText = renderResult('devtools_status', { connected: true, toolCount: 51 }, false, [
      'connected',
      'missing',
    ])
    expect(outText).toBe('{"connected":true}')
  })

  it('--fields wins over --json and over summarizers', () => {
    expect(renderResult('react_get_renders', rendersPayload, true, ['id'])).toBe(
      renderResult('react_get_renders', rendersPayload, false, ['id']),
    )
    expect(renderResult('react_get_renders', rendersPayload, true, ['id'])).not.toBe(
      JSON.stringify(rendersPayload),
    )
  })
})

describe('renderResult: filteredNote passthrough', () => {
  it('appends a non-empty filteredNote after a summarizer output line', () => {
    const result = {
      commits: 1,
      components: [],
      filteredNote: '0 app effects (37 library effects hidden — set appOnly:false to include)',
    }
    const outText = renderResult('react_effect_audit', result)
    expect(outText).toContain('37 library effects hidden')
    expect(outText.split('\n').at(-1)).toBe(result.filteredNote)
  })

  it('appends a filteredNote on the small-flat-record path too', () => {
    const outText = renderResult('react_reset_overrides', {
      ok: true,
      filteredNote: 'note here',
    })
    expect(outText.split('\n').at(-1)).toBe('note here')
  })

  it('never crashes on odd filteredNote shapes and never appends an empty note', () => {
    expect(() => renderResult('x', { a: 1, filteredNote: 42 })).not.toThrow()
    // Empty note: nothing is appended, so the small-record line is unchanged.
    expect(renderResult('x', { a: 1, filteredNote: '' })).toBe('a=1 · filteredNote=""')
  })
})

describe('parseBatchItems', () => {
  it('parses an array of {tool, args?} objects, defaulting missing args to {}', () => {
    const parsed = parseBatchItems('[{"tool":"a","args":{"x":1}},{"tool":"b"}]')
    expect('items' in parsed && parsed.items).toEqual([
      { tool: 'a', args: { x: 1 } },
      { tool: 'b', args: {} },
    ])
  })

  it('rejects non-arrays, missing tool, and non-object args', () => {
    expect(parseBatchItems('not json')).toMatchObject({
      error: expect.stringContaining('invalid JSON'),
    })
    expect(parseBatchItems('{}')).toMatchObject({
      error: expect.stringContaining('must be a JSON array'),
    })
    expect(parseBatchItems('[{"args":{}}]')).toMatchObject({
      error: expect.stringContaining('string "tool"'),
    })
    expect(parseBatchItems('[{"tool":"a","args":5}]')).toMatchObject({
      error: expect.stringContaining('args must be an object'),
    })
  })
})

describe('resolveSession', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('prefers the explicit --session flag over the env pin', () => {
    vi.stubEnv('GENIE_SESSION', 'env-tab')
    expect(resolveSession('flag-tab')).toBe('flag-tab')
  })

  it('falls back to GENIE_SESSION so an agent shell pins its tab once', () => {
    vi.stubEnv('GENIE_SESSION', 'env-tab')
    expect(resolveSession(undefined)).toBe('env-tab')
  })

  it('returns undefined when neither is set (most-recent-tab routing)', () => {
    expect(resolveSession(undefined)).toBeUndefined()
  })
})
