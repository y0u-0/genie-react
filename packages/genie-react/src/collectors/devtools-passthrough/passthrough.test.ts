import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollectorContext, ErasedCollectorTool } from '../../client'
import { pluginPassthroughCollector } from './passthrough'

const noopContext: CollectorContext = {
  pushSnapshot: vi.fn(),
  pushEvent: vi.fn(),
  refreshTools: vi.fn(),
}

function toolByName(tools: ErasedCollectorTool[] | undefined, name: string): ErasedCollectorTool {
  const tool = tools?.find((candidate) => candidate.contract.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

function callTool(tool: ErasedCollectorTool, args: unknown): unknown {
  return tool.handler(args as never, noopContext)
}

afterEach(() => {
  globalThis.__TANSTACK_EVENT_TARGET__ = undefined
})

describe('pluginPassthroughCollector declared plugins', () => {
  it('lists declared plugins with eventCount 0 before any traffic', () => {
    const collector = pluginPassthroughCollector({ plugins: ['cart-devtools', 'metrics-devtools'] })

    expect(callTool(toolByName(collector.tools, 'plugin_list'), {})).toEqual({
      plugins: [
        { pluginId: 'cart-devtools', eventCount: 0 },
        { pluginId: 'metrics-devtools', eventCount: 0 },
      ],
    })
  })

  it('merges traffic into the seeded buffer instead of duplicating the plugin', () => {
    const target = new EventTarget()
    globalThis.__TANSTACK_EVENT_TARGET__ = target
    const collector = pluginPassthroughCollector({ plugins: ['cart-devtools'] })
    collector.start?.(noopContext)

    target.dispatchEvent(
      new CustomEvent('tanstack-devtools-global', {
        detail: {
          type: 'cart-devtools:cart-updated',
          payload: { items: [], total: 0 },
          pluginId: 'cart-devtools',
        },
      }),
    )

    expect(callTool(toolByName(collector.tools, 'plugin_list'), {})).toEqual({
      plugins: [{ pluginId: 'cart-devtools', eventCount: 1 }],
    })
  })

  it('lists nothing when no plugins are declared and no traffic has arrived', () => {
    const collector = pluginPassthroughCollector()

    expect(callTool(toolByName(collector.tools, 'plugin_list'), {})).toEqual({ plugins: [] })
  })
})
