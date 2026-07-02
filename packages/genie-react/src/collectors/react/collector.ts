import { type Fiber, getRDTHook } from 'bippy'
import { defineCollector, defineCollectorTool, type GenieCollector } from '../../client'
import type { NodeId } from './contracts'
import {
  reactClearRendersContract,
  reactDomForComponentContract,
  reactEffectAuditContract,
  reactErrorStateContract,
  reactFindComponentsContract,
  reactForceErrorBoundaryContract,
  reactGetRendersContract,
  reactGetTreeContract,
  reactInspectComponentContract,
  reactInspectContextContract,
  reactOverrideContextContract,
  reactOverrideHookStateContract,
  reactOverridePropsContract,
  reactProfileReportContract,
  reactProfileStartContract,
  reactToggleSuspenseFallbackContract,
} from './contracts'
import { getEffectAudit } from './effect-tracker'
import { getErrorState } from './error-tracker'
import {
  buildTree,
  contextsForFiber,
  domForFiber,
  findByName,
  findFiberById,
  findRootFiber,
  inspectFiber,
  nameOf,
  registerFiber,
} from './fiber'
import {
  applyContextOverride,
  applyErrorOverride,
  applyHookStateOverride,
  applySuspenseOverride,
  overrideFiberProps,
} from './overrides'
import {
  clearRenders,
  getCommitCount,
  getRenderSummary,
  getRenders,
  isTracking,
  startRenderTracking,
} from './render-tracker'

/** React collector: tree, search, inspection, live overrides; why-did-render + profiling need commit instrumentation from `genie-react/hook`. */
export function reactCollector(): GenieCollector {
  return defineCollector({
    meta: { id: 'react', title: 'React', description: 'Tree, inspect, renders, profiling' },
    capabilities: ['react'],
    appInfo: () => {
      const reactVersion = detectReactVersion()
      return reactVersion ? { reactVersion } : {}
    },
    start: () => {
      // Fallback for setups that did not load the hook early — captures future commits only.
      startRenderTracking()
    },
    tools: [
      defineCollectorTool({
        contract: reactGetTreeContract,
        handler: ({ depth, includeHost, maxNodes, appOnly }) => {
          const root = findRootFiber()
          if (!root)
            return { rootId: null, nodes: [], total: 0, truncated: false, truncatedBy: null }
          return buildTree(root, { depth, includeHost, maxNodes, appOnly })
        },
      }),
      defineCollectorTool({
        contract: reactFindComponentsContract,
        handler: ({ query, exact, limit }) => {
          const root = findRootFiber()
          return { matches: root ? findByName(root, query, exact, limit) : [] }
        },
      }),
      defineCollectorTool({
        contract: reactInspectComponentContract,
        handler: ({ id, path, depth }) => {
          const root = findRootFiber()
          const fiber = root ? findFiberById(root, id) : null
          if (!fiber) throw new Error(`Component ${id} not found (it may have unmounted).`)
          return inspectFiber(fiber, { path, depth })
        },
      }),
      defineCollectorTool({
        contract: reactOverridePropsContract,
        handler: ({ id, props }) => {
          overrideFiberProps(requireFiber(id), props)
          return { ok: true }
        },
      }),
      defineCollectorTool({
        contract: reactOverrideHookStateContract,
        handler: ({ id, hookIndex, path, value }) => {
          const fiber = requireFiber(id)
          applyHookStateOverride(fiber, hookIndex, path, value)
          return { ok: true, name: nameOf(fiber), hookIndex }
        },
      }),
      defineCollectorTool({
        contract: reactOverrideContextContract,
        handler: ({ id, context, value }) => {
          const match = applyContextOverride(requireFiber(id), context, value)
          return {
            ok: true,
            providerId: registerFiber(match.provider),
            contextName: match.contextName,
          }
        },
      }),
      defineCollectorTool({
        contract: reactToggleSuspenseFallbackContract,
        handler: ({ id, showFallback }) => {
          const { boundary, active } = applySuspenseOverride(requireFiber(id), showFallback)
          return {
            ok: true,
            boundaryId: registerFiber(boundary),
            showingFallback: showFallback,
            activeOverrides: active,
          }
        },
      }),
      defineCollectorTool({
        contract: reactForceErrorBoundaryContract,
        handler: ({ id, forceError }) => {
          const { boundary, active } = applyErrorOverride(requireFiber(id), forceError)
          return {
            ok: true,
            boundaryId: registerFiber(boundary),
            boundaryName: nameOf(boundary),
            erroring: forceError,
            activeOverrides: active,
          }
        },
      }),
      defineCollectorTool({
        contract: reactDomForComponentContract,
        handler: ({ id, limit }) => {
          const root = findRootFiber()
          const fiber = root ? findFiberById(root, id) : null
          if (!fiber) throw new Error(`Component ${id} not found (it may have unmounted).`)
          return domForFiber(fiber, { limit })
        },
      }),
      defineCollectorTool({
        contract: reactInspectContextContract,
        handler: ({ id, depth }) => {
          const root = findRootFiber()
          const fiber = root ? findFiberById(root, id) : null
          if (!fiber) throw new Error(`Component ${id} not found (it may have unmounted).`)
          return contextsForFiber(fiber, { depth })
        },
      }),
      defineCollectorTool({
        contract: reactGetRendersContract,
        handler: async ({ component, sort, limit, appOnly }) => {
          const [summary, components] = await Promise.all([
            getRenderSummary(appOnly),
            getRenders({ component, sort, limit, appOnly }),
          ])
          return { tracking: isTracking(), commits: getCommitCount(), summary, components }
        },
      }),
      defineCollectorTool({
        contract: reactEffectAuditContract,
        handler: async ({ component, onlyHot, appOnly, limit }) => ({
          tracking: isTracking(),
          commits: getCommitCount(),
          components: await getEffectAudit({ component, onlyHot, appOnly, limit }),
        }),
      }),
      defineCollectorTool({
        contract: reactErrorStateContract,
        handler: ({ includeSource, limit }) => getErrorState({ includeSource, limit }),
      }),
      defineCollectorTool({
        contract: reactClearRendersContract,
        handler: () => {
          clearRenders()
          return { ok: true, tracking: isTracking() }
        },
      }),
      defineCollectorTool({
        contract: reactProfileStartContract,
        handler: () => {
          startRenderTracking()
          clearRenders()
          return { ok: true, tracking: isTracking() }
        },
      }),
      defineCollectorTool({
        contract: reactProfileReportContract,
        handler: async ({ limit }) => {
          const [bySelfTime, byRenders, byUnnecessary, byUnstable] = await Promise.all([
            getRenders({ sort: 'selfTime', limit }),
            getRenders({ sort: 'renders', limit }),
            getRenders({ sort: 'unnecessary', limit }),
            getRenders({ sort: 'unstable', limit }),
          ])
          return {
            commits: getCommitCount(),
            tracking: isTracking(),
            slowest: bySelfTime.map((r) => ({
              id: r.id,
              name: r.name,
              selfTime: r.selfTime,
              renders: r.renders,
            })),
            mostRerendered: byRenders.map((r) => ({
              id: r.id,
              name: r.name,
              renders: r.renders,
              unnecessary: r.unnecessary,
            })),
            mostUnnecessary: byUnnecessary
              .filter((r) => r.unnecessary > 0)
              .map((r) => ({
                id: r.id,
                name: r.name,
                unnecessary: r.unnecessary,
                renders: r.renders,
              })),
            mostUnstable: byUnstable
              .filter((r) => r.unstableRenders > 0)
              .map((r) => ({
                id: r.id,
                name: r.name,
                unstableRenders: r.unstableRenders,
                renders: r.renders,
              })),
          }
        },
      }),
    ],
  })
}

function requireFiber(id: NodeId): Fiber {
  const root = findRootFiber()
  const fiber = root ? findFiberById(root, id) : null
  if (!fiber) throw new Error(`Component ${id} not found (it may have unmounted).`)
  return fiber
}

function detectReactVersion(): string | undefined {
  try {
    const hook = getRDTHook()
    if (hook?.renderers) {
      for (const renderer of hook.renderers.values()) {
        if (renderer.version) return renderer.version
      }
    }
  } catch {
    // hook not available
  }
  return undefined
}
