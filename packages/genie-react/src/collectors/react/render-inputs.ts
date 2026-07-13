import { ClassComponentTag, type Fiber, type MemoizedState, type Props } from 'bippy'
import { type DeepDiffResult, isDataDescriptor, safeOwnPropertyDescriptor } from './deep-diff'
import { classifyHook, isStatefulHook } from './fiber'
import {
  createRenderEvidenceBudget,
  diffWithBudget,
  markPropsNotEnumerated,
  type RenderEvidenceBudget,
  retainInputEvidence,
  scanInputEvidence,
  truncateInputScan,
} from './render-budget'
import { diffContextChanges, HOOK_WALK_LIMIT, stateValue } from './render-causes'

export interface PropRenderChange {
  name: string
  kind: 'props'
  /** Exact fact: both values are non-primitive references and identity changed. */
  referenceChanged: boolean
  /** Bounded deep comparison found no value change, only a reference change. */
  referenceOnly: boolean
  /** Legacy alias for referenceChanged. */
  unstable: boolean
  beforePresent: boolean
  afterPresent: boolean
  before: unknown
  after: unknown
  deepDiff: DeepDiffResult
}

interface StateRenderChangeBase {
  name: string
  kind: 'state'
  unstable: false
  before: unknown
  after: unknown
  deepDiff: DeepDiffResult
}

export interface HookStateRenderChange extends StateRenderChangeBase {
  hook: {
    index: number
    stateIndex: number
    kind: 'state' | 'reducer'
  }
}

export interface ClassStateRenderChange extends StateRenderChangeBase {
  name: 'class state'
}

export type StateRenderChange = HookStateRenderChange | ClassStateRenderChange
export type RenderChange = PropRenderChange | StateRenderChange

export function childrenChanged(fiber: Fiber, evidence?: RenderEvidenceBudget): boolean {
  if (evidence && !scanInputEvidence(evidence, 'children')) return false
  const next: Props | null = fiber.memoizedProps
  const prev: Props | null = fiber.alternate?.memoizedProps ?? null
  if (!next || !prev) return false
  const before = safeOwnPropertyDescriptor(prev, 'children')
  const after = safeOwnPropertyDescriptor(next, 'children')
  if (before === undefined || after === undefined) {
    if (evidence) truncateInputScan(evidence)
    return false
  }
  if (
    (before !== null && !isDataDescriptor(before)) ||
    (after !== null && !isDataDescriptor(after))
  ) {
    if (evidence) truncateInputScan(evidence)
    return false
  }
  return !Object.is(before?.value, after?.value)
}

export function diffProps(
  fiber: Fiber,
  evidence = createRenderEvidenceBudget(),
): PropRenderChange[] {
  const next: Props | null = fiber.memoizedProps
  const prev: Props | null = fiber.alternate?.memoizedProps ?? null
  if (!next || !prev || typeof next !== 'object' || typeof prev !== 'object') return []

  if (!Object.is(next, prev)) {
    /* Arbitrary props cannot be enumerated without Proxy traps; fixed inputs are read separately. */
    markPropsNotEnumerated(evidence)
  }
  return []
}

/** Reports changed useState/useReducer slots in one guarded hook-chain pass. */
export function diffStateChanges(
  fiber: Fiber,
  evidence = createRenderEvidenceBudget(),
): StateRenderChange[] {
  if (fiber.tag === ClassComponentTag) {
    const before = fiber.alternate?.memoizedState ?? null
    const after = fiber.memoizedState
    return Object.is(before, after) || !retainInputEvidence(evidence)
      ? []
      : [
          {
            name: 'class state',
            kind: 'state',
            unstable: false,
            before: stateValue(before, evidence),
            after: stateValue(after, evidence),
            deepDiff: diffWithBudget(before, after, evidence),
          },
        ]
  }

  const changes: StateRenderChange[] = []
  let cur: MemoizedState | null = fiber.memoizedState
  let alt: MemoizedState | null = fiber.alternate?.memoizedState ?? null
  let index = 0
  let stateIndex = 0
  while (cur && alt && index < HOOK_WALK_LIMIT) {
    if (!scanInputEvidence(evidence, 'state')) break
    const currentStateful = isStatefulHook(cur)
    const previousStateful = isStatefulHook(alt)
    if (currentStateful || previousStateful) {
      if (!Object.is(cur.memoizedState, alt.memoizedState)) {
        if (!retainInputEvidence(evidence)) {
          cur = cur.next
          alt = alt.next
          index += 1
          stateIndex += 1
          continue
        }
        const classified = classifyHook(currentStateful ? cur : alt)
        const kind = classified === 'reducer' ? 'reducer' : 'state'
        changes.push({
          name: `${kind}[${stateIndex}]`,
          kind: 'state',
          unstable: false,
          hook: { index, stateIndex, kind },
          before: stateValue(alt.memoizedState, evidence),
          after: stateValue(cur.memoizedState, evidence),
          deepDiff: diffWithBudget(alt.memoizedState, cur.memoizedState, evidence),
        })
      }
      stateIndex += 1
    }
    cur = cur.next
    alt = alt.next
    index += 1
  }
  if (cur || alt) truncateInputScan(evidence)
  return changes
}

/** Backward-compatible predicate; detailed reports intentionally narrow to stateful hooks. */
export function stateChanged(fiber: Fiber): boolean {
  if (fiber.tag === ClassComponentTag) {
    return !Object.is(fiber.memoizedState, fiber.alternate?.memoizedState ?? null)
  }
  let cur: MemoizedState | null = fiber.memoizedState
  let alt: MemoizedState | null = fiber.alternate?.memoizedState ?? null
  let guard = 0
  while (cur && alt && guard < HOOK_WALK_LIMIT) {
    if (!Object.is(cur.memoizedState, alt.memoizedState)) return true
    cur = cur.next
    alt = alt.next
    guard += 1
  }
  return false
}

export function contextChanged(fiber: Fiber): boolean {
  return diffContextChanges(fiber).length > 0
}
