import type { BridgeStatusMessage } from 'genie-react/protocol'
import { describe, expect, it } from 'vitest'
import {
  formatToolsListing,
  renderResult,
  summarizeEffects,
  summarizeRenders,
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
      '  Dashboard #1 5× (1m 4u) · 2 unnec · 3 unstable · self 1.2ms · ↻ onClick',
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

  it('falls back to pretty JSON when json is true', () => {
    expect(renderResult('react_get_renders', rendersPayload, true)).toBe(
      JSON.stringify(rendersPayload, null, 2),
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
