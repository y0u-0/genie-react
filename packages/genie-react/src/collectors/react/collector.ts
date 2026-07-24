import { type Fiber, getRDTHook } from 'bippy'
import { defineCollector, defineCollectorTool, type GenieCollector } from '../../client'
import type { NodeId } from './contracts'
import {
  reactClearRendersContract,
  reactComponentCohortContract,
  reactComponentForDomContract,
  reactDomForComponentContract,
  reactEffectAuditContract,
  reactEffectEventsContract,
  reactEffectTimelineContract,
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
  reactProvenanceContract,
  reactRefreshEventsContract,
  reactRenderCausesContract,
  reactRendersDiffContract,
  reactResetOverridesContract,
  reactToggleSuspenseFallbackContract,
} from './contracts'
import { getEffectScheduleEvents } from './effect-events'
import { getEffectAuditReport, getEffectTrackingCoverage } from './effect-tracker'
import { getErrorState } from './error-tracker'
import {
  appOnlyFilteredNote,
  buildProvenanceReport,
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
import { getAnalysisGeneration, getDocumentCommitId } from './observation'
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
import { getRenderCohort } from './render-cohort'
import {
  buildRenderTrackingCoverage,
  renderEvidenceComparability,
  renderSummarySemantics,
} from './render-snapshots'
import {
  clearRenders,
  getAnalysisFailedFiberCount,
  getBudgetExhaustedCommitCount,
  getBudgetExhaustedSubsystems,
  getCommitCount,
  getDroppedPendingUnmountFiberCount,
  getPropsNotEnumeratedFiberCount,
  getRenderCauseMeasurement,
  getRenderObservationConfig,
  getRendersLeaderboardsMeasurement,
  getRendersMeasurement,
  getRenderTrackingCoverage,
  getSkippedCommitFiberCount,
  getTruncatedInputFiberCount,
  isTracking,
  rendersDiff,
  setCommitListener,
  startRenderTracking,
  stopRenderTracking,
  takeSnapshot,
} from './render-tracker'
import { classifyFiber, classifyFibersWithinBudget } from './source'

function currentEffectCoverage() {
  const renderCoverage = getRenderTrackingCoverage('measurement')
  const { truncatedEffectLists } = getEffectTrackingCoverage()
  return {
    ...renderCoverage,
    complete: renderCoverage.complete && truncatedEffectLists === 0,
    truncatedEffectLists,
  }
}

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
    meta: {
      id: 'react',
      title: 'React',
      description: 'Tree, inspect, renders, profiling',
    },
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
        handler: ({ rootId, depth, includeHost, maxNodes, appOnly }) => {
          const root = findRootFiber()
          if (!root)
            return {
              rootId: null,
              nodes: [],
              total: 0,
              truncated: false,
              truncatedBy: null,
            }
          if (rootId === undefined) {
            return buildTree(root, { depth, includeHost, maxNodes, appOnly })
          }
          const subtreeRoot = findFiberById(root, rootId)
          if (!subtreeRoot) {
            throw new Error(`Component ${rootId} not found (it may have unmounted).`)
          }
          return buildTree(subtreeRoot, {
            depth,
            includeHost,
            maxNodes,
            appOnly,
            includeRoot: true,
          })
        },
      }),
      defineCollectorTool({
        contract: reactProvenanceContract,
        handler: ({ component, limit, appOnly }) =>
          buildProvenanceReport(findRootFiber(), { component, limit, appOnly }),
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
            const { source, isLibrary } = classes[index] ?? {
              source: null,
              isLibrary: false,
            }
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
          const report = await getRendersMeasurement({
            component,
            sort,
            limit,
            appOnly,
          })
          const { summary, components, libraryHidden, omittedByLimit } = report
          const filteredNote = appOnly
            ? appOnlyFilteredNote(components.length, libraryHidden, 'components')
            : undefined
          const coverageInput = {
            skippedCommitFibers: report.skippedCommitFibers,
            droppedUnmountFibers: report.droppedUnmountFibers,
            analysisFailedFibers: report.analysisFailedFibers,
            truncatedInputFibers: report.truncatedInputFibers,
            propsNotEnumeratedFibers: report.propsNotEnumeratedFibers,
            budgetExhaustedCommits: report.budgetExhaustedCommits,
            budgetExhaustedSubsystems: report.budgetExhaustedSubsystems,
          }
          const coverage = buildRenderTrackingCoverage(coverageInput, 'causal')
          const measurementCoverage = buildRenderTrackingCoverage(coverageInput, 'measurement')
          const comparability = renderEvidenceComparability(coverage, report.attribution.status)
          return {
            tracking: report.tracking,
            commits: report.commits,
            documentCommitId: report.documentCommitId,
            observation: report.observation,
            attribution: report.attribution,
            summary: {
              ...summary,
              semantics: renderSummarySemantics(measurementCoverage, summary.totalRenders),
              coverageDomain: 'render-measurement' as const,
            },
            components,
            omittedByLimit,
            ...comparability,
            coverage,
            filteredNote,
          }
        },
      }),
      defineCollectorTool({
        contract: reactRenderCausesContract,
        handler: async ({ commit, afterCommit, component, limit, appOnly }) => {
          const report = await getRenderCauseMeasurement({
            commit,
            afterCommit,
            component,
            limit,
            appOnly,
          })
          const { events, libraryHidden, omittedByLimit } = report
          const coverage = buildRenderTrackingCoverage(
            {
              skippedCommitFibers: report.skippedCommitFibers,
              droppedUnmountFibers: report.droppedUnmountFibers,
              analysisFailedFibers: report.analysisFailedFibers,
              truncatedInputFibers: report.truncatedInputFibers,
              propsNotEnumeratedFibers: report.propsNotEnumeratedFibers,
              budgetExhaustedCommits: report.budgetExhaustedCommits,
              budgetExhaustedSubsystems: report.budgetExhaustedSubsystems,
            },
            'causal',
          )
          return {
            tracking: report.tracking,
            commits: report.commits,
            documentCommitId: report.documentCommitId,
            observation: report.observation,
            attribution: report.attribution,
            events,
            omittedByLimit,
            renderEventRetention: report.renderEventRetention,
            coverage: {
              ...coverage,
              complete: coverage.complete && report.renderEventRetention.evictedEvents === 0,
              semantics:
                coverage.complete && report.renderEventRetention.evictedEvents === 0
                  ? ('exact' as const)
                  : ('lower-bound' as const),
              droppedRenderEvents: report.renderEventRetention.evictedEvents,
            },
            filteredNote: appOnly
              ? appOnlyFilteredNote(events.length, libraryHidden, 'components')
              : undefined,
          }
        },
      }),
      defineCollectorTool({
        contract: reactComponentCohortContract,
        handler: ({ component, exact, limit }) =>
          getRenderCohort(
            findRootFiber(),
            { component, exact, limit },
            {
              skippedCommitFibers: getSkippedCommitFiberCount(),
              droppedUnmountFibers: getDroppedPendingUnmountFiberCount(),
              analysisFailedFibers: getAnalysisFailedFiberCount(),
              truncatedInputFibers: getTruncatedInputFiberCount(),
              propsNotEnumeratedFibers: getPropsNotEnumeratedFiberCount(),
              budgetExhaustedCommits: getBudgetExhaustedCommitCount(),
              budgetExhaustedSubsystems: getBudgetExhaustedSubsystems(),
            },
          ),
      }),
      defineCollectorTool({
        contract: reactEffectAuditContract,
        handler: async ({
          component,
          onlyHot,
          appOnly,
          packageName,
          minUpdates,
          minFireRate,
          minScheduleRate,
          limit,
        }) => {
          const tracking = isTracking()
          const commits = getCommitCount()
          const documentCommitId = getDocumentCommitId()
          const analysisGeneration = getAnalysisGeneration()
          const coverage = currentEffectCoverage()
          const {
            components,
            omittedByLimit,
            effectsOmittedByLimit,
            libraryEffectsHidden,
            hotnessCriteria,
            packageFilter,
          } = await getEffectAuditReport({
            component,
            onlyHot,
            appOnly,
            packageName,
            minUpdates,
            minFireRate,
            minScheduleRate,
            limit,
            isAttributionCurrent: () =>
              getDocumentCommitId() === documentCommitId &&
              getAnalysisGeneration() === analysisGeneration,
          })
          const completedAtDocumentCommitId = getDocumentCommitId()
          const completedAtAnalysisGeneration = getAnalysisGeneration()
          const appEffects = components.reduce((sum, c) => sum + c.effects.length, 0)
          const filteredNote = appOnly
            ? appOnlyFilteredNote(appEffects, libraryEffectsHidden, 'effects')
            : undefined
          return {
            tracking,
            commits,
            documentCommitId,
            attribution: {
              status:
                completedAtDocumentCommitId === documentCommitId &&
                completedAtAnalysisGeneration === analysisGeneration
                  ? ('current' as const)
                  : ('stale' as const),
              startedAtDocumentCommitId: documentCommitId,
              completedAtDocumentCommitId,
              startedAtAnalysisGeneration: analysisGeneration,
              completedAtAnalysisGeneration,
            },
            hotnessCriteria,
            components,
            omittedByLimit,
            effectsOmittedByLimit,
            coverage,
            filteredNote,
            packageFilter,
          }
        },
      }),
      defineCollectorTool({
        contract: reactEffectEventsContract,
        handler: ({ component, afterDocumentCommitId, limit }) => {
          const tracking = isTracking()
          const documentCommitId = getDocumentCommitId()
          const coverage = currentEffectCoverage()
          return {
            tracking,
            documentCommitId,
            ...getEffectScheduleEvents({
              component,
              afterDocumentCommitId,
              limit,
            }),
            coverage,
          }
        },
      }),
      defineCollectorTool({
        contract: reactEffectTimelineContract,
        handler: ({ component, afterDocumentCommitId, limit }) => {
          const tracking = isTracking()
          const documentCommitId = getDocumentCommitId()
          const coverage = currentEffectCoverage()
          return {
            tracking,
            documentCommitId,
            ...getEffectScheduleEvents({
              component,
              afterDocumentCommitId,
              limit,
            }),
            coverage,
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
        handler: ({ components, roots, budget, lifecycle }) => {
          startRefreshTracking()
          startRenderTracking()
          const observation = clearRenders({ components, roots, budget, lifecycle })
          return {
            ok: true,
            tracking: isTracking(),
            documentCommitId: getDocumentCommitId(),
            observation,
            observationConfig: getRenderObservationConfig(),
          }
        },
      }),
      defineCollectorTool({
        contract: reactProfileStartContract,
        handler: ({ components, roots, budget, lifecycle }) => {
          startRefreshTracking()
          startRenderTracking()
          const observation = clearRenders({ components, roots, budget, lifecycle })
          return {
            ok: true,
            tracking: isTracking(),
            documentCommitId: getDocumentCommitId(),
            observation,
            observationConfig: getRenderObservationConfig(),
          }
        },
      }),
      defineCollectorTool({
        contract: reactProfileStopContract,
        handler: () => {
          stopRenderTracking()
          return {
            ok: true as const,
            tracking: false as const,
            commits: getCommitCount(),
          }
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
          const measurement = await getRendersLeaderboardsMeasurement(limit)
          const { boards } = measurement
          const bySelfTime = boards.slowest
          const byRenders = boards.mostRerendered
          const byUnnecessary = boards.mostUnnecessary
          const byUnstable = boards.mostUnstable
          return {
            commits: measurement.commits,
            tracking: measurement.tracking,
            documentCommitId: measurement.documentCommitId,
            attribution: measurement.attribution,
            coverage: measurement.coverage,
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
            mostReferenceOnly: byUnstable
              .filter((r) => r.referenceOnlyPropRenders > 0)
              .map((r) => ({
                id: r.id,
                name: r.name,
                referenceOnlyPropRenders: r.referenceOnlyPropRenders,
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
