import { type Fiber, getRDTHook } from 'bippy'
import { defineCollector, defineCollectorTool, type GenieCollector } from '../../client'
import type { NodeId } from './contracts'
import {
  reactClearRendersContract,
  reactComponentForDomContract,
  reactDomForComponentContract,
  reactEffectAuditContract,
  reactErrorStateContract,
  reactFindComponentsContract,
  reactForceErrorBoundaryContract,
  reactGetRendersContract,
  reactGetTreeContract,
  reactInspectComponentContract,
  reactInspectContextContract,
  reactListOverridesContract,
  reactOverrideContextContract,
  reactOverrideHookStateContract,
  reactOverridePropsContract,
  reactProfileReportContract,
  reactProfileSnapshotContract,
  reactProfileStartContract,
  reactProfileStopContract,
  reactRefreshEventsContract,
  reactRenderCausesContract,
  reactRendersDiffContract,
  reactResetOverridesContract,
  reactToggleSuspenseFallbackContract,
} from './contracts'
import { getEffectAuditReport } from './effect-tracker'
import { getErrorState } from './error-tracker'
import {
  appOnlyFilteredNote,
  buildTree,
  contextsForFiber,
  domForFiber,
  findByName,
  findFiberById,
  findRootFiber,
  inspectFiber,
  matchDetail,
  nameOf,
  owningComponentFor,
  registerFiber,
} from './fiber'
import {
  applyContextOverride,
  applyErrorOverride,
  applyHookStateOverride,
  applySuspenseOverride,
  listOverrides,
  overrideFiberProps,
  resetOverrides,
} from './overrides'
import { getRefreshEvents, startRefreshTracking } from './refresh-tracker'
import {
  clearRenders,
  getCommitCount,
  getRenderCauseEventsReport,
  getRenderSummary,
  getRendersLeaderboards,
  getRendersReport,
  isTracking,
  rendersDiff,
  setCommitListener,
  startRenderTracking,
  stopRenderTracking,
  takeSnapshot,
} from './render-tracker'
import { classifyFiber, classifyFibersWithinBudget } from './source'

export function hasDomLookupRuntime(): boolean {
  const globals = globalThis as {
    navigator?: { product?: string }
    document?: { querySelectorAll?: unknown; body?: unknown }
    Element?: unknown
  }
  if (globals.navigator?.product === 'ReactNative') return false
  return (
    typeof globals.document?.querySelectorAll === 'function' &&
    globals.document.body !== undefined &&
    typeof globals.Element === 'function'
  )
}

/** React collector: tree, search, inspection, live overrides; why-did-render + profiling need commit instrumentation from `genie-react/hook`. */
export function reactCollector(): GenieCollector {
  return defineCollector({
    meta: { id: 'react', title: 'React', description: 'Tree, inspect, renders, profiling' },
    capabilities: ['react'],
    appInfo: () => {
      const reactVersion = detectReactVersion()
      return reactVersion ? { reactVersion } : {}
    },
    start: (ctx) => {
      // Fallback for setups that did not load the hook early — captures future commits only.
      startRefreshTracking()
      startRenderTracking()
      // Ride the commit loop with a throttled heartbeat so an animation- or list-saturated thread stays live.
      setCommitListener(ctx.markActivity)
      return () => setCommitListener(null)
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
        handler: async ({ query, exact, limit }) => {
          const root = findRootFiber()
          if (!root) return { matches: [] }
          const found = findByName(root, query, exact, limit)
          const { classes } = await classifyFibersWithinBudget(found.map(({ fiber }) => fiber))
          const matches = found.map(({ id, name, path, fiber }, index) => {
            const { kind, props } = matchDetail(fiber, 1)
            const { source, isLibrary } = classes[index] ?? { source: null, isLibrary: false }
            return { id, name, path, kind, props, source, isLibrary }
          })
          return { matches }
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
        handler: ({ id, hookIndex, stateIndex, path, value }) => {
          const fiber = requireFiber(id)
          const resolved = applyHookStateOverride(fiber, { hookIndex, stateIndex }, path, value)
          return {
            ok: true,
            name: nameOf(fiber),
            hookIndex: resolved.flatIndex,
            stateIndex: resolved.stateIndex,
          }
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
          const { boundary, active } = applySuspenseOverride(
            requireFiberForToggle(id, showFallback),
            showFallback,
          )
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
          const { boundary, active } = applyErrorOverride(
            requireFiberForToggle(id, forceError),
            forceError,
          )
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
        contract: reactListOverridesContract,
        handler: () => listOverrides(),
      }),
      defineCollectorTool({
        contract: reactResetOverridesContract,
        handler: () => resetOverrides(),
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
        contract: reactComponentForDomContract,
        handler: async ({ selector, limit, propsDepth }) => {
          if (!hasDomLookupRuntime()) throw new Error('No DOM in this environment.')
          let elements: Element[]
          try {
            elements = Array.from(document.querySelectorAll(selector))
          } catch {
            throw new Error(`Invalid CSS selector: ${JSON.stringify(selector)}`)
          }
          const seen = new Set<number>()
          const components = []
          for (const element of elements.slice(0, limit)) {
            const owner = owningComponentFor(element, propsDepth)
            if (!owner || seen.has(owner.id)) continue
            seen.add(owner.id)
            const { source, isLibrary } = await classifyFiber(owner.fiber)
            components.push({
              id: owner.id as number,
              name: owner.name,
              kind: owner.kind,
              tag: element.tagName.toLowerCase(),
              props: owner.props,
              source,
              isLibrary,
            })
          }
          return { selector, matched: elements.length, components }
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
          const [summary, { components, libraryHidden }] = await Promise.all([
            getRenderSummary(appOnly),
            getRendersReport({ component, sort, limit, appOnly }),
          ])
          const filteredNote = appOnly
            ? appOnlyFilteredNote(components.length, libraryHidden, 'components')
            : undefined
          return {
            tracking: isTracking(),
            commits: getCommitCount(),
            summary,
            components,
            filteredNote,
          }
        },
      }),
      defineCollectorTool({
        contract: reactRenderCausesContract,
        handler: async ({ commit, afterCommit, component, limit, appOnly }) => {
          const { events, libraryHidden } = await getRenderCauseEventsReport({
            commit,
            afterCommit,
            component,
            limit,
            appOnly,
          })
          return {
            tracking: isTracking(),
            commits: getCommitCount(),
            events,
            filteredNote: appOnly
              ? appOnlyFilteredNote(events.length, libraryHidden, 'components')
              : undefined,
          }
        },
      }),
      defineCollectorTool({
        contract: reactEffectAuditContract,
        handler: async ({ component, onlyHot, appOnly, minUpdates, minFireRate, limit }) => {
          const { components, libraryEffectsHidden, hotnessCriteria } = await getEffectAuditReport({
            component,
            onlyHot,
            appOnly,
            minUpdates,
            minFireRate,
            limit,
          })
          const appEffects = components.reduce((sum, c) => sum + c.effects.length, 0)
          const filteredNote = appOnly
            ? appOnlyFilteredNote(appEffects, libraryEffectsHidden, 'effects')
            : undefined
          return {
            tracking: isTracking(),
            commits: getCommitCount(),
            hotnessCriteria,
            components,
            filteredNote,
          }
        },
      }),
      defineCollectorTool({
        contract: reactErrorStateContract,
        handler: ({ includeSource, limit }) => getErrorState({ includeSource, limit }),
      }),
      defineCollectorTool({
        contract: reactRefreshEventsContract,
        handler: ({ afterSequence, limit, includeSource }) =>
          getRefreshEvents({ afterSequence, limit, includeSource }),
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
        contract: reactProfileStopContract,
        handler: () => {
          stopRenderTracking()
          return { ok: true as const, tracking: false as const, commits: getCommitCount() }
        },
      }),
      defineCollectorTool({
        contract: reactProfileSnapshotContract,
        handler: async ({ label }) => {
          const result = await takeSnapshot(label)
          return { ok: true as const, ...result }
        },
      }),
      defineCollectorTool({
        contract: reactRendersDiffContract,
        handler: ({ baseline, thresholdMs }) => rendersDiff(baseline, thresholdMs),
      }),
      defineCollectorTool({
        contract: reactProfileReportContract,
        handler: async ({ limit }) => {
          const boards = await getRendersLeaderboards(limit)
          const bySelfTime = boards.slowest
          const byRenders = boards.mostRerendered
          const byUnnecessary = boards.mostUnnecessary
          const byUnstable = boards.mostUnstable
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

// A release-shaped toggle (showFallback:false / forceError:false) whose id no longer resolves is the stuck case: the forced boundary's subtree re-id'd on unmount, so point the agent at the id-free recovery.
function requireFiberForToggle(id: NodeId, activating: boolean): Fiber {
  try {
    return requireFiber(id)
  } catch (error) {
    if (activating) throw error
    throw new Error(
      `Component ${id} not found — its subtree likely re-mounted with new ids while forced. Call react_reset_overrides to release all forced boundaries without an id.`,
    )
  }
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
