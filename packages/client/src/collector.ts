import type { AgentToolContract, AppInfo, CollectorMeta } from '@genie-react/core'
import type { z } from 'zod'

/** Handed to each collector so it can stream live state and refresh the advertised tool list. */
export interface CollectorContext {
  pushSnapshot: (domain: string, data: unknown) => void
  pushEvent: (domain: string, event: unknown) => void
  refreshTools: () => void
}

export interface CollectorTool<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  contract: AgentToolContract<I, O>
  handler: (args: z.infer<I>, ctx: CollectorContext) => z.infer<O> | Promise<z.infer<O>>
}

/** Type-erased tool as stored by the registry; the `never` arg keeps every concrete {@link CollectorTool} contravariantly assignable. */
export interface ErasedCollectorTool {
  contract: AgentToolContract
  handler: (args: never, ctx: CollectorContext) => unknown
}

/** The extension seam: built-in and third-party collectors implement this; the client aggregates their tools and app info. */
export interface GenieCollector {
  meta: CollectorMeta
  capabilities?: string[]
  tools?: ErasedCollectorTool[]
  appInfo?: () => Partial<AppInfo>
  // biome-ignore lint/suspicious/noConfusingVoidType: cleanup-or-nothing, like a React effect callback
  start?: (ctx: CollectorContext) => void | (() => void)
}

export function defineCollector(collector: GenieCollector): GenieCollector {
  return collector
}

export function defineCollectorTool<I extends z.ZodType, O extends z.ZodType>(
  tool: CollectorTool<I, O>,
): CollectorTool<I, O> {
  return tool
}
