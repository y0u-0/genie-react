import type { Fiber } from 'bippy'
import { countExternalStoreHooks, type RenderCause } from './render-causes'
import {
  type ExternalStoreSourceResolution,
  isLibraryFile,
  type ResolvedSource,
  resolveExternalStoreSourceResolutionBeforeDeadline,
} from './source'

const HOOK_SOURCE_ATTRIBUTION_LIMIT = 80
const HOOK_SOURCE_ATTRIBUTION_BUDGET_MS = 500

export function withReportEvidence(
  causes: RenderCause[],
  source: ResolvedSource | null,
  hookSources: ExternalStoreSourceResolution | undefined,
  externalStoreCount: number,
  unavailableReason?: 'component-unmounted' | 'event-not-latest' | 'report-state-advanced',
): RenderCause[] {
  return causes.map((cause) => {
    if (cause.kind === 'props') {
      if (cause.referenceOnly !== true) return cause
      return {
        ...cause,
        producerCandidate: {
          source,
          evidence: source ? ('inferred' as const) : ('unknown' as const),
          reason: 'component-jsx-usage-or-definition-fallback' as const,
        },
      }
    }
    if (cause.kind === 'external-store' || cause.kind === 'query' || cause.kind === 'router') {
      return {
        ...cause,
        hookProvenance: externalStoreHookProvenance(
          cause.externalStoreIndex,
          hookSources,
          externalStoreCount,
          unavailableReason,
        ),
      }
    }
    return cause
  })
}

/** Exact app hook evidence keeps a record in appOnly reports even when a framework wrapper supplied the component source fallback. */
export function hasExactAppExternalStoreCallsite(
  resolution: ExternalStoreSourceResolution | undefined,
  expectedCount: number,
): boolean {
  if (resolution?.status !== 'resolved' || resolution.hooks?.length !== expectedCount) return false
  return resolution.hooks.some(
    (hook) => hook.callsite !== null && !isLibraryFile(hook.callsite.file),
  )
}

function externalStoreHookProvenance(
  index: number,
  resolution: ExternalStoreSourceResolution | undefined,
  expectedCount: number,
  unavailableReason?: 'component-unmounted' | 'event-not-latest' | 'report-state-advanced',
): NonNullable<Extract<RenderCause, { kind: 'external-store' }>['hookProvenance']> {
  if (!resolution) {
    return {
      status: 'unavailable',
      evidence: 'unknown',
      reason: unavailableReason ?? 'component-unmounted',
    }
  }
  if (resolution.status === 'deadline-exceeded') {
    return { status: 'unavailable', evidence: 'unknown', reason: 'attribution-budget-exhausted' }
  }
  if (resolution.status === 'report-state-advanced') {
    return { status: 'unavailable', evidence: 'unknown', reason: 'report-state-advanced' }
  }
  if (resolution.status === 'inspection-unavailable') {
    return { status: 'unavailable', evidence: 'unknown', reason: 'hook-inspection-unavailable' }
  }
  if (resolution.status === 'inspection-truncated') {
    return { status: 'unavailable', evidence: 'unknown', reason: 'inspection-truncated' }
  }
  if (resolution.status === 'shadow-render-disabled') {
    return { status: 'unavailable', evidence: 'unknown', reason: 'shadow-render-disabled' }
  }
  if (resolution.status === 'no-external-stores') {
    return { status: 'unavailable', evidence: 'unknown', reason: 'no-external-store-callsite' }
  }
  const hooks = resolution.hooks ?? []
  const hook = hooks[index]
  if (hooks.length !== expectedCount || !hook) {
    return { status: 'unavailable', evidence: 'unknown', reason: 'hook-count-mismatch' }
  }
  if (!hook.callsite && !hook.primitiveSource) {
    return { status: 'unavailable', evidence: 'unknown', reason: 'hook-source-unresolved' }
  }
  return {
    status: 'exact',
    evidence: 'exact',
    callsite: hook.callsite,
    primitiveSource: hook.primitiveSource,
    hookAncestry: hook.hookAncestry,
  }
}

export async function resolveExternalStoreSourcesWithinBudget(
  fibers: Fiber[],
): Promise<ExternalStoreSourceResolution[]> {
  const resolutions: ExternalStoreSourceResolution[] = fibers.map(() => ({
    status: 'deadline-exceeded',
    hooks: null,
  }))
  const startedAt = Date.now()
  const limit = Math.min(fibers.length, HOOK_SOURCE_ATTRIBUTION_LIMIT)
  for (let index = 0; index < limit; index += 1) {
    const remaining = HOOK_SOURCE_ATTRIBUTION_BUDGET_MS - (Date.now() - startedAt)
    if (remaining <= 0) break
    const fiber = fibers[index]
    if (!fiber) break
    if (countExternalStoreHooks(fiber) === 0) {
      resolutions[index] = { status: 'no-external-stores', hooks: [] }
      continue
    }
    resolutions[index] = await resolveExternalStoreSourceResolutionBeforeDeadline(fiber, remaining)
  }
  return resolutions
}
