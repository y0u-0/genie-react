import type { BridgeStatusMessage } from 'genie-react/protocol'
import { describe, expect, it } from 'vitest'
import {
  formatGroupIndex,
  formatToolDetail,
  formatToolsListing,
  relatedActions,
  resolveToolsSelector,
} from './tool-output'

type ToolDescriptor = BridgeStatusMessage['tools'][number]

function listing(tools: ToolDescriptor[]): string {
  return formatToolsListing({ app: { name: 'Test App' }, tools })
}

function tool(partial: Partial<ToolDescriptor> & { name: string }): ToolDescriptor {
  return { title: partial.name, group: 'query', ...partial } as ToolDescriptor
}

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
      properties: {
        pluginId: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
      required: ['pluginId'],
    },
  }),
]

describe('tool output', () => {
  it('marks optional params and lists required params bare', () => {
    const output = listing([
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

    expect(output).toContain('plugin_get_events — Get plugin events')
    expect(output).toContain('pluginId: string, limit?: integer')
  })

  it('renders enum unions and no-argument tools', () => {
    const output = listing([
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

    expect(output).toContain('sort?: "renders" | "unstable"')
    expect(output).toContain('query_clear')
    expect(output).toContain('(no args)')
  })

  it('unwraps the allOf wrapper a refined schema emits', () => {
    const output = listing([
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

    expect(output).toContain('queryHash?: string, queryKey?: array')
  })

  it('renders group counts, previews, and the drill-down command', () => {
    const index = formatGroupIndex('Demo', CATALOG)
    expect(index).toContain('4 tools from Demo · 3 groups')
    expect(index).toContain('react.render')
    expect(index).toContain('react_get_renders, react_clear_renders')
    expect(index).toContain('genie-react tools <group>')
    expect(index).not.toContain('staleOnly')
  })

  it('selects exact tools, then groups, then suggestions', () => {
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

  it('surfaces a domain’s mutations from the shared action group', () => {
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

  it('shows constraints and a runnable example in one tool detail', () => {
    const descriptor = CATALOG.find((candidate) => candidate.name === 'plugin_get_events')
    if (!descriptor) throw new Error('missing plugin_get_events fixture')
    const detail = formatToolDetail(descriptor)
    expect(detail).toContain('plugin_get_events — Get plugin events [plugin]')
    expect(detail).toContain('Read buffered plugin events.')
    expect(detail).toContain('pluginId: string [length >=1]')
    expect(detail).toContain('limit?: integer [1..100] (default 50)')
    expect(detail).toContain(
      `example: genie-react call plugin_get_events '{"pluginId":"<pluginId>"}'`,
    )
  })
})
