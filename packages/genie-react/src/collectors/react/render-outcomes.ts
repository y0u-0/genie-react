import {
  didFiberCommit,
  type Fiber,
  HostTextTag,
  isHostFiber,
  type MemoizedState,
  type RenderPhase,
} from 'bippy'
import { type CommitWorkBudget, consumeCommitWork } from './commit-budget'
import type { RenderCause } from './render-causes'

const HOST_SCAN_LIMIT = 500
const HOOK_SCAN_LIMIT = 1_000

export const UNOBSERVED_BEHAVIOR_DOMAINS = [
  'focus',
  'url',
  'network',
  'transition',
  'freshness',
  'effect-execution',
] as const

export type UnobservedBehaviorDomain = (typeof UNOBSERVED_BEHAVIOR_DOMAINS)[number]
export type RenderInputEvidence = 'mount' | 'changed' | 'none-observed' | 'incomplete'

export interface RenderAssessment {
  inputEvidence: RenderInputEvidence
  observedInputKinds: RenderCause['kind'][]
  behaviorEvidence: {
    subtreeHostMutations: {
      status: 'observed' | 'none-observed' | 'incomplete'
      count: number
      /** Frontier subtrees not scanned after the bound was reached. */
      pendingSubtrees: number
      /** Legacy alias for pendingSubtrees; not an exact omitted-Fiber count. */
      omittedByLimit: number
    }
    scheduledEffects: {
      status: 'observed' | 'none-observed' | 'incomplete'
      count: number
    }
    unobservedDomains: UnobservedBehaviorDomain[]
  }
  optimizationSafety: 'not-proven-safe'
  requiredValidation: ('dom' | 'aria' | 'focus' | 'url' | 'network' | 'transition')[]
}

interface HostMutationScan {
  count: number
  pendingSubtrees: number
  complete: boolean
}

export interface CurrentCommitEvidence {
  renderedFibers: Set<Fiber>
  hostMutationFibers: Set<Fiber>
  hostMutationCaptureComplete: boolean
}

/** Internal initialization value; recordRender replaces it before publishing the record. */
export function pendingRenderAssessment(): RenderAssessment {
  return {
    inputEvidence: 'incomplete',
    observedInputKinds: [],
    behaviorEvidence: {
      subtreeHostMutations: {
        status: 'incomplete',
        count: 0,
        pendingSubtrees: 0,
        omittedByLimit: 0,
      },
      scheduledEffects: { status: 'none-observed', count: 0 },
      unobservedDomains: [...UNOBSERVED_BEHAVIOR_DOMAINS],
    },
    optimizationSafety: 'not-proven-safe',
    requiredValidation: ['dom', 'aria', 'focus', 'url', 'network', 'transition'],
  }
}

/** Inspect only this component's descendants so sibling mutations are never misattributed. */
export function scanSubtreeHostMutations(
  fiber: Fiber,
  limit = HOST_SCAN_LIMIT,
  budget?: CommitWorkBudget,
  commitEvidence?: CurrentCommitEvidence,
): HostMutationScan {
  if (!commitEvidence) return { count: 0, pendingSubtrees: 0, complete: false }
  try {
    const stack: Fiber[] = []
    if (fiber.child) stack.push(fiber.child)
    let visited = 0
    let count = 0
    let directCaptureComplete = true

    while (stack.length > 0 && visited < limit) {
      if (!consumeCommitWork(budget, 'host-mutations')) break
      const node = stack.pop()
      if (!node) continue
      visited += 1
      if (isHostFiber(node) && commitEvidence.hostMutationFibers.has(node)) count += 1
      if (node.tag === HostTextTag) {
        try {
          if (didFiberCommit(node)) count += 1
        } catch {
          directCaptureComplete = false
        }
      }
      if (node.sibling) stack.push(node.sibling)
      if (node.child) stack.push(node.child)
    }

    return {
      count,
      pendingSubtrees: stack.length,
      complete:
        stack.length === 0 && commitEvidence.hostMutationCaptureComplete && directCaptureComplete,
    }
  } catch {
    return { count: 0, pendingSubtrees: 0, complete: false }
  }
}

/** Hook/context pairing is complete only when both Fiber buffers line up within the bound. */
export function inputComparisonComplete(fiber: Fiber, budget?: CommitWorkBudget): boolean {
  try {
    let currentHook: MemoizedState | null = fiber.memoizedState
    let previousHook: MemoizedState | null = fiber.alternate?.memoizedState ?? null
    let hooksVisited = 0
    while ((currentHook || previousHook) && hooksVisited < HOOK_SCAN_LIMIT) {
      if (!consumeCommitWork(budget, 'input-completeness')) return false
      if (!currentHook || !previousHook) return false
      currentHook = currentHook.next
      previousHook = previousHook.next
      hooksVisited += 1
    }
    if (currentHook || previousHook) return false

    let currentContext = fiber.dependencies?.firstContext ?? null
    let previousContext = fiber.alternate?.dependencies?.firstContext ?? null
    let contextsVisited = 0
    while ((currentContext || previousContext) && contextsVisited < HOOK_SCAN_LIMIT) {
      if (!consumeCommitWork(budget, 'input-completeness')) return false
      if (
        !currentContext ||
        !previousContext ||
        currentContext.context !== previousContext.context
      ) {
        return false
      }
      currentContext = currentContext.next
      previousContext = previousContext.next
      contextsVisited += 1
    }
    return !currentContext && !previousContext
  } catch {
    return false
  }
}

export function assessRender(
  fiber: Fiber,
  phase: RenderPhase,
  causes: RenderCause[],
  scheduledEffects: number,
  inputComplete = true,
  budget?: CommitWorkBudget,
  effectAnalysisComplete = true,
  commitEvidence?: CurrentCommitEvidence,
): RenderAssessment {
  const observedInputKinds = causes
    .filter((cause) => cause.evidence === 'exact' && cause.kind !== 'mount')
    .map((cause) => cause.kind)
  const inputEvidence: RenderInputEvidence =
    phase === 'mount'
      ? 'mount'
      : !inputComplete
        ? 'incomplete'
        : observedInputKinds.length > 0
          ? 'changed'
          : inputComparisonComplete(fiber, budget)
            ? 'none-observed'
            : 'incomplete'
  const host = scanSubtreeHostMutations(fiber, HOST_SCAN_LIMIT, budget, commitEvidence)

  return {
    inputEvidence,
    observedInputKinds: [...new Set(observedInputKinds)],
    behaviorEvidence: {
      subtreeHostMutations: {
        status: host.complete ? (host.count > 0 ? 'observed' : 'none-observed') : 'incomplete',
        count: host.count,
        pendingSubtrees: host.pendingSubtrees,
        omittedByLimit: host.pendingSubtrees,
      },
      scheduledEffects: {
        status: !effectAnalysisComplete
          ? 'incomplete'
          : scheduledEffects > 0
            ? 'observed'
            : 'none-observed',
        count: scheduledEffects,
      },
      unobservedDomains: [...UNOBSERVED_BEHAVIOR_DOMAINS],
    },
    optimizationSafety: 'not-proven-safe',
    requiredValidation: ['dom', 'aria', 'focus', 'url', 'network', 'transition'],
  }
}
