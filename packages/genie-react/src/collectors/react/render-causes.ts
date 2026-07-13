import type { ContextDependency, Fiber, MemoizedState } from 'bippy'
import { dehydrate, type ToolOutput } from '../../protocol'
import type { reactRenderCausesContract } from './contracts'

export type RenderCauseEvent = ToolOutput<typeof reactRenderCausesContract>['events'][number]
export type RenderCause = RenderCauseEvent['causes'][number]
export type RenderNecessity = RenderCauseEvent['necessity']
export type RenderCauseKind = RenderCause['kind']
export type RenderCauseCounts = Record<RenderCauseKind, number>

export const HOOK_WALK_LIMIT = 1_000
const STATE_VALUE_DEPTH = 2
const STATE_VALUE_MAX_ENTRIES = 20
const STATE_VALUE_MAX_STRING_LENGTH = 200
const RENDER_CAUSE_KINDS: RenderCauseKind[] = [
  'mount',
  'props',
  'state',
  'children',
  'context',
  'external-store',
  'query',
  'router',
  'parent',
  'unknown',
]

/** Bound causal values before retention; render tracking never pins an app's full state graph. */
export function stateValue(value: unknown): unknown {
  return dehydrate(value, {
    depth: STATE_VALUE_DEPTH,
    maxEntries: STATE_VALUE_MAX_ENTRIES,
    maxStringLength: STATE_VALUE_MAX_STRING_LENGTH,
  })
}

export function emptyCauseCounts(): RenderCauseCounts {
  return Object.fromEntries(RENDER_CAUSE_KINDS.map((kind) => [kind, 0])) as RenderCauseCounts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isExternalStoreHook(hook: MemoizedState | null): boolean {
  if (!hook || !isRecord(hook.queue)) return false
  return 'value' in hook.queue && typeof hook.queue.getSnapshot === 'function'
}

function changedSnapshotFields(before: unknown, after: unknown): string[] {
  if (!isRecord(before) || !isRecord(after) || Array.isArray(before) || Array.isArray(after)) {
    return Object.is(before, after) ? [] : ['$value']
  }
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !Object.is(before[key], after[key]))
    .slice(0, 50)
}

function snapshotDomain(value: unknown): 'query' | 'router' | 'external-store' {
  if (!isRecord(value)) return 'external-store'
  if ('dataUpdatedAt' in value && 'fetchStatus' in value && 'status' in value) return 'query'
  const location = value.location
  if (
    ('matches' in value && isRecord(location)) ||
    'resolvedLocation' in value ||
    (isRecord(location) && ('pathname' in location || 'href' in location)) ||
    (typeof value.pathname === 'string' &&
      ('href' in value || 'routeId' in value || 'searchStr' in value || 'params' in value))
  ) {
    return 'router'
  }
  return 'external-store'
}

function queryHashNearHook(fiber: Fiber, stopIndex: number): string | undefined {
  let hook: MemoizedState | null = fiber.memoizedState
  let index = 0
  while (hook && index <= stopIndex && index < HOOK_WALK_LIMIT) {
    if (isRecord(hook.memoizedState)) {
      const options = hook.memoizedState.options
      if (isRecord(options) && typeof options.queryHash === 'string') return options.queryHash
    }
    hook = hook.next
    index += 1
  }
  return undefined
}

/** Exact useSyncExternalStore snapshot changes; Query/Router labels are bounded medium-confidence shape inference. */
export function diffExternalStoreChanges(fiber: Fiber): RenderCause[] {
  const causes: RenderCause[] = []
  let current: MemoizedState | null = fiber.memoizedState
  let previous: MemoizedState | null = fiber.alternate?.memoizedState ?? null
  let index = 0
  while (current && previous && index < HOOK_WALK_LIMIT) {
    if (
      (isExternalStoreHook(current) || isExternalStoreHook(previous)) &&
      !Object.is(current.memoizedState, previous.memoizedState)
    ) {
      const domain = snapshotDomain(current.memoizedState)
      const common = {
        hookIndex: index,
        before: stateValue(previous.memoizedState),
        after: stateValue(current.memoizedState),
        changedFields: changedSnapshotFields(previous.memoizedState, current.memoizedState),
      }
      if (domain === 'query') {
        const queryHash = queryHashNearHook(fiber, index)
        causes.push({
          kind: 'query',
          confidence: 'medium',
          reason: 'query-result-shape',
          ...common,
          ...(queryHash ? { queryHash } : {}),
        })
      } else if (domain === 'router') {
        causes.push({
          kind: 'router',
          confidence: 'medium',
          reason: 'router-state-shape',
          ...common,
        })
      } else {
        causes.push({
          kind: 'external-store',
          confidence: 'high',
          reason: 'sync-external-store-snapshot-changed',
          ...common,
        })
      }
    }
    current = current.next
    previous = previous.next
    index += 1
  }
  return causes
}

/** Exact consumed-context value changes retained as bounded before/after evidence. */
export function diffContextChanges(fiber: Fiber): RenderCause[] {
  const causes: RenderCause[] = []
  let current = firstContextDependency(fiber)
  let previous = firstContextDependency(fiber.alternate)
  let index = 0
  while (current && previous && index < HOOK_WALK_LIMIT) {
    if (!Object.is(current.memoizedValue, previous.memoizedValue)) {
      const context = current.context as { displayName?: unknown }
      causes.push({
        kind: 'context',
        confidence: 'high',
        contextIndex: index,
        name: typeof context.displayName === 'string' ? context.displayName : `Context[${index}]`,
        before: stateValue(previous.memoizedValue),
        after: stateValue(current.memoizedValue),
      })
    }
    current = current.next
    previous = previous.next
    index += 1
  }
  return causes
}

export function firstContextDependency(
  fiber: Fiber | null | undefined,
): ContextDependency<unknown> | null {
  return fiber?.dependencies?.firstContext ?? null
}
