import { z } from 'zod'
import { defineCollector, defineCollectorTool, type GenieCollector } from '../../client'
import { defineAgentToolContract, dehydrate } from '../../protocol'
import {
  type DevtoolsBusEvent,
  emitToDevtoolsBus,
  pluginIdFromEvent,
  subscribeToDevtoolsBus,
} from './bus'

const MAX_EVENTS_PER_PLUGIN = 200
const PAYLOAD_DEPTH = 3

interface BufferedEvent {
  type: string
  payload: unknown
  ts: number
}

interface PluginBuffer {
  pluginId: string
  events: BufferedEvent[]
}

export const pluginListContract = defineAgentToolContract({
  name: 'plugin_list',
  title: 'List DevTools plugins',
  description:
    'List every TanStack DevTools plugin (built-in and third-party) that has emitted traffic on the client event bus, with how many recent events each has buffered. Discovery is traffic-based — a plugin only appears after its first event — except ids declared via <Genie plugins>, which are listed immediately with eventCount 0 until traffic arrives. Use a pluginId with plugin_get_events.',
  group: 'plugin',
  input: z.object({}),
  output: z.object({
    plugins: z.array(
      z.object({
        pluginId: z.string(),
        eventCount: z.number(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true },
})

export const pluginGetEventsContract = defineAgentToolContract({
  name: 'plugin_get_events',
  title: 'Get plugin events',
  description:
    'Get the most recent buffered events for one DevTools plugin by pluginId, newest last. Payloads are depth-bounded. Use plugin_list to discover plugin ids. Nested synchronous dispatch can buffer a response BEFORE the request that triggered it, so read a wide `limit` and do not assume request-then-response order.',
  group: 'plugin',
  input: z.object({
    pluginId: z.string(),
    limit: z.number().int().min(1).max(MAX_EVENTS_PER_PLUGIN).default(50),
  }),
  output: z.object({
    events: z.array(
      z.object({
        type: z.string(),
        payload: z.unknown(),
        ts: z.number(),
      }),
    ),
  }),
  annotations: { readOnlyHint: true },
})

export const pluginEmitContract = defineAgentToolContract({
  name: 'plugin_emit',
  title: 'Emit a plugin event',
  description:
    'Emit an event onto the TanStack DevTools event bus so browser plugins receive it. `type` is the full event name a plugin listens for (e.g. "my-plugin:refresh"); pass the same `type` you observed via plugin_get_events to replay it. Returns ok=false when no DevTools bus is present.',
  group: 'action',
  input: z.object({
    pluginId: z.string(),
    type: z.string(),
    payload: z.unknown().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  annotations: { openWorldHint: true },
})

export interface PluginPassthroughOptions {
  /** Plugin ids to list before any traffic arrives, so silent plugins are still discoverable. */
  plugins?: readonly string[]
}

export function pluginPassthroughCollector(options: PluginPassthroughOptions = {}): GenieCollector {
  const buffers = new Map<string, PluginBuffer>()
  for (const pluginId of options.plugins ?? []) {
    buffers.set(pluginId, { pluginId, events: [] })
  }

  const record = (event: DevtoolsBusEvent): void => {
    const pluginId = pluginIdFromEvent(event)
    let buffer = buffers.get(pluginId)
    if (!buffer) {
      buffer = { pluginId, events: [] }
      buffers.set(pluginId, buffer)
    }
    buffer.events.push({
      type: event.type,
      payload: dehydrate(event.payload, { depth: PAYLOAD_DEPTH }),
      ts: Date.now(),
    })
    if (buffer.events.length > MAX_EVENTS_PER_PLUGIN) {
      buffer.events.splice(0, buffer.events.length - MAX_EVENTS_PER_PLUGIN)
    }
  }

  return defineCollector({
    meta: {
      id: 'plugin-passthrough',
      title: 'DevTools Plugins',
      description: 'Buffers TanStack DevTools plugin events and replays them onto the bus.',
    },
    capabilities: ['plugin'],
    start: (ctx) => {
      let pending = false
      const pushSnapshot = () => {
        pending = false
        ctx.pushSnapshot('plugin', {
          plugins: [...buffers.values()].map((buffer) => ({
            pluginId: buffer.pluginId,
            eventCount: buffer.events.length,
          })),
        })
      }
      const unsubscribe = subscribeToDevtoolsBus((event) => {
        record(event)
        if (!pending) {
          pending = true
          queueMicrotask(pushSnapshot)
        }
      })
      pushSnapshot()
      return unsubscribe
    },
    tools: [
      defineCollectorTool({
        contract: pluginListContract,
        handler: () => ({
          plugins: [...buffers.values()].map((buffer) => ({
            pluginId: buffer.pluginId,
            eventCount: buffer.events.length,
          })),
        }),
      }),
      defineCollectorTool({
        contract: pluginGetEventsContract,
        handler: ({ pluginId, limit }) => {
          const buffer = buffers.get(pluginId)
          if (!buffer) return { events: [] }
          return { events: buffer.events.slice(-limit) }
        },
      }),
      defineCollectorTool({
        contract: pluginEmitContract,
        handler: ({ pluginId, type, payload }) => ({
          ok: emitToDevtoolsBus({ pluginId, type, payload }),
        }),
      }),
    ],
  })
}
