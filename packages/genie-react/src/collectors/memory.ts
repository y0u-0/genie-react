import { z } from 'zod'
import { defineCollector, defineCollectorTool, type GenieCollector } from '../client'
import { defineAgentToolContract } from '../protocol'

interface PerformanceMemory {
  readonly usedJSHeapSize: number
  readonly totalJSHeapSize: number
  readonly jsHeapSizeLimit: number
}

interface MemoryAttribution {
  readonly url: string
  readonly scope: string
  readonly container?: { readonly id: string; readonly src: string }
}

interface MemoryBreakdownEntry {
  readonly bytes: number
  readonly attribution: readonly MemoryAttribution[]
  readonly types: readonly string[]
}

interface MemoryMeasurement {
  readonly bytes: number
  readonly breakdown: readonly MemoryBreakdownEntry[]
}

type PerformanceWithMemory = Performance & {
  memory?: PerformanceMemory
  measureUserAgentSpecificMemory?: () => Promise<MemoryMeasurement>
}

function getPerformance(): PerformanceWithMemory | undefined {
  return typeof performance === 'undefined' ? undefined : performance
}

function getPerformanceMemory(): PerformanceMemory | undefined {
  return getPerformance()?.memory
}

function getMeasureMemory(): (() => Promise<MemoryMeasurement>) | undefined {
  const perf = getPerformance()
  const measure = perf?.measureUserAgentSpecificMemory
  return typeof measure === 'function' ? measure.bind(perf) : undefined
}

function isCrossOriginIsolated(): boolean | undefined {
  return typeof crossOriginIsolated === 'undefined' ? undefined : crossOriginIsolated
}

const memoryBreakdownEntrySchema = z.object({
  bytes: z.number(),
  attribution: z.array(
    z.object({
      url: z.string().optional(),
      scope: z.string().optional(),
      container: z.object({ id: z.string(), src: z.string().optional() }).optional(),
    }),
  ),
  types: z.array(z.string()),
})

const browserGetMemoryContract = defineAgentToolContract({
  name: 'browser_get_memory',
  title: 'Browser JS heap usage',
  description:
    'Read the current browser JavaScript heap size (used/total/limit, in bytes) via the non-standard, Chromium-only performance.memory. This is the V8 heap for the whole page, NOT React-specific memory, and the browser coarsens the values for security. Returns supported:false with a note on non-Chromium browsers (Firefox, Safari) and non-browser runtimes.',
  group: 'memory',
  input: z.object({}),
  output: z.object({
    supported: z.boolean(),
    usedJSHeapSize: z.number().optional(),
    totalJSHeapSize: z.number().optional(),
    jsHeapSizeLimit: z.number().optional(),
    note: z.string(),
  }),
  annotations: { readOnlyHint: true },
})

const browserMeasureMemoryContract = defineAgentToolContract({
  name: 'browser_measure_memory',
  title: 'Measure page memory (standardized)',
  description:
    'Estimate the memory used by this page via the standardized performance.measureUserAgentSpecificMemory(). Returns total bytes plus a per-realm breakdown (JS heap, DOM, etc.) — page-wide browser memory, NOT React-specific memory. Requires a Chromium-based browser and a cross-origin-isolated context (COOP+COEP headers); otherwise returns supported:false with a note. Sampling can be delayed by the browser.',
  group: 'memory',
  input: z.object({}),
  output: z.object({
    supported: z.boolean(),
    bytes: z.number().optional(),
    breakdown: z.array(memoryBreakdownEntrySchema).optional(),
    note: z.string(),
  }),
  annotations: { readOnlyHint: true },
})

export function memoryCollector(): GenieCollector {
  return defineCollector({
    meta: {
      id: 'memory',
      title: 'Browser memory',
      description: 'Browser JS heap readings (not React-specific memory)',
    },
    capabilities: ['memory'],
    tools: [
      defineCollectorTool({
        contract: browserGetMemoryContract,
        handler: () => {
          const memory = getPerformanceMemory()
          if (!memory) {
            return {
              supported: false,
              note: 'performance.memory is unavailable. It is a non-standard, Chromium-only API not exposed by Firefox, Safari, or most non-browser runtimes.',
            }
          }
          return {
            supported: true,
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            jsHeapSizeLimit: memory.jsHeapSizeLimit,
            note: 'Browser JavaScript (V8) heap for the whole page, not React-specific memory. Values are coarsened by the browser for security.',
          }
        },
      }),
      defineCollectorTool({
        contract: browserMeasureMemoryContract,
        handler: async () => {
          const measure = getMeasureMemory()
          if (!measure) {
            return {
              supported: false,
              note: 'performance.measureUserAgentSpecificMemory() is unavailable. It requires a Chromium-based browser and a cross-origin-isolated context (COOP "same-origin" + COEP "require-corp" headers).',
            }
          }
          if (isCrossOriginIsolated() === false) {
            return {
              supported: false,
              note: 'performance.measureUserAgentSpecificMemory() requires a cross-origin-isolated context, but crossOriginIsolated is false. Serve the app with COOP "same-origin" and COEP "require-corp" headers.',
            }
          }
          const measurement = await measure()
          return {
            supported: true,
            bytes: measurement.bytes,
            breakdown: measurement.breakdown.map((entry) => ({
              bytes: entry.bytes,
              attribution: entry.attribution.map((attribution) => ({
                url: attribution.url,
                scope: attribution.scope,
                ...(attribution.container ? { container: { ...attribution.container } } : {}),
              })),
              types: [...entry.types],
            })),
            note: 'Page-wide browser memory estimate across all realms (JS heap, DOM, etc.), not React-specific memory. The browser may delay sampling.',
          }
        },
      }),
    ],
  })
}
