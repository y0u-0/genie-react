import { isDataDescriptor, safeOwnPropertyDescriptor } from '../causal/safe-object'

export { isDataDescriptor, safeOwnPropertyDescriptor } from '../causal/safe-object'

export type DeepDiffValue =
  | null
  | string
  | number
  | boolean
  | { type: 'string'; value: string; truncated: true }
  | { type: 'undefined' }
  | { type: 'number'; value: 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { type: 'bigint'; value: string }
  | { type: 'symbol'; value: string }
  | { type: 'array' | 'object' | 'date' | 'map' | 'set' | 'function' | 'instance' }

export type DeepDiffChange =
  | { kind: 'value'; path: string; before: DeepDiffValue; after: DeepDiffValue }
  | { kind: 'added'; path: string; after: DeepDiffValue }
  | { kind: 'removed'; path: string; before: DeepDiffValue }
  | { kind: 'reference-only'; path: string }

export interface DeepDiffOptions {
  maxDepth?: number
  maxVisited?: number
  maxChanges?: number
  budget?: DeepDiffBudget
}

export interface DeepDiffBudget {
  remainingVisited: number
  remainingChanges: number
  /** Optional outer commit guard shared with sibling input analyses. */
  consumeVisit?: () => boolean
}

export interface DeepDiffResult {
  changes: DeepDiffChange[]
  /** Number of value pairs or one-sided properties inspected. Never exceeds maxVisited. */
  visited: number
  /** True when a depth, work, or output limit prevented a complete structural comparison. */
  truncated: boolean
}

const DEFAULT_MAX_DEPTH = 4
const DEFAULT_MAX_VISITED = 200
const DEFAULT_MAX_CHANGES = 20

// Caller limits stay capped because commit analysis must never perform an unbounded object walk.
const HARD_MAX_DEPTH = 20
const HARD_MAX_VISITED = 5_000
const HARD_MAX_CHANGES = 500
const MAX_TEXT_CODE_UNITS = 200
const MAX_POINTER_SEGMENT_CODE_UNITS = 120
const MAX_POINTER_CODE_UNITS = 500
const MAX_EXACT_BIGINT = 10n ** 100n

type ContainerKind = 'array'

interface DiffState {
  changes: DeepDiffChange[]
  visited: number
  truncated: boolean
  workExhausted: boolean
  changesExhausted: boolean
  maxDepth: number
  maxVisited: number
  maxChanges: number
  remainingPropertyScans: number
  activePairs: WeakMap<object, WeakSet<object>>
  outerBudget: DeepDiffBudget | undefined
}

export function createDeepDiffBudget(
  maxVisited = DEFAULT_MAX_VISITED,
  maxChanges = DEFAULT_MAX_CHANGES,
  consumeVisit?: () => boolean,
): DeepDiffBudget {
  return {
    remainingVisited: boundedLimit(maxVisited, DEFAULT_MAX_VISITED, HARD_MAX_VISITED),
    remainingChanges: boundedLimit(maxChanges, DEFAULT_MAX_CHANGES, HARD_MAX_CHANGES),
    ...(consumeVisit ? { consumeVisit } : {}),
  }
}

/** Compare scalars and arrays with bounded RFC 6901 paths; arbitrary objects stay opaque. */
export function deepDiff(
  before: unknown,
  after: unknown,
  options: DeepDiffOptions = {},
): DeepDiffResult {
  const budget = options.budget
  const state: DiffState = {
    changes: [],
    visited: 0,
    truncated: false,
    workExhausted: false,
    changesExhausted: false,
    maxDepth: boundedLimit(options.maxDepth, DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH),
    maxVisited: Math.min(
      boundedLimit(options.maxVisited, DEFAULT_MAX_VISITED, HARD_MAX_VISITED),
      budget?.remainingVisited ?? HARD_MAX_VISITED,
    ),
    maxChanges: Math.min(
      boundedLimit(options.maxChanges, DEFAULT_MAX_CHANGES, HARD_MAX_CHANGES),
      budget?.remainingChanges ?? HARD_MAX_CHANGES,
    ),
    remainingPropertyScans:
      2 *
      Math.min(
        boundedLimit(options.maxVisited, DEFAULT_MAX_VISITED, HARD_MAX_VISITED),
        budget?.remainingVisited ?? HARD_MAX_VISITED,
      ),
    activePairs: new WeakMap(),
    outerBudget: budget,
  }

  walk(before, after, '', 0, state)
  if (budget) {
    budget.remainingVisited = Math.max(0, budget.remainingVisited - state.visited)
    budget.remainingChanges = Math.max(0, budget.remainingChanges - state.changes.length)
  }
  return { changes: state.changes, visited: state.visited, truncated: state.truncated }
}

function walk(
  before: unknown,
  after: unknown,
  path: string,
  depth: number,
  state: DiffState,
): boolean {
  if (!consumeVisit(state)) return true
  if (Object.is(before, after)) return false

  const beforeKind = containerKind(before)
  const afterKind = containerKind(after)
  if (beforeKind !== null && beforeKind === afterKind) {
    return walkContainers(before as object, after as object, path, depth, state)
  }

  if (isUnsupportedReference(before) || isUnsupportedReference(after)) {
    /* Structural reflection can invoke unbounded Proxy traps. Keep only incomplete identity. */
    state.truncated = true
    recordChange(state, { kind: 'reference-only', path })
  } else {
    recordChange(state, {
      kind: 'value',
      path,
      before: snapshotValue(before, state),
      after: snapshotValue(after, state),
    })
  }
  return true
}

function walkContainers(
  before: object,
  after: object,
  path: string,
  depth: number,
  state: DiffState,
): boolean {
  if (depth >= state.maxDepth) {
    state.truncated = true
    recordChange(state, { kind: 'reference-only', path })
    return true
  }
  if (hasActivePair(state, before, after)) {
    recordChange(state, { kind: 'reference-only', path })
    return true
  }

  const beforeScan = scanArrayProperties(before, state)
  const afterScan = scanArrayProperties(after, state)
  if (!beforeScan.complete || !afterScan.complete) state.truncated = true

  addActivePair(state, before, after)
  let childChanged =
    Array.isArray(before) && Array.isArray(after)
      ? recordArrayLengthChange(before, after, path, state)
      : false
  try {
    const beforeByKey = new Map(
      beforeScan.properties.map(({ key, descriptor }) => [key, descriptor] as const),
    )
    const afterByKey = new Map(
      afterScan.properties.map(({ key, descriptor }) => [key, descriptor] as const),
    )
    const keys = [...beforeByKey.keys()]
    for (const key of afterByKey.keys()) {
      if (!beforeByKey.has(key)) keys.push(key)
    }
    for (const key of keys) {
      if (state.workExhausted || state.changesExhausted) break
      const beforeDescriptor = beforeByKey.get(key) ?? null
      const afterDescriptor = afterByKey.get(key) ?? null
      const beforeHas = beforeDescriptor !== null
      const afterHas = afterDescriptor !== null
      // An absent key is knowable only when that side's enumeration completed.
      if ((!beforeHas && !beforeScan.complete) || (!afterHas && !afterScan.complete)) continue
      const childPath = appendPointer(path, key, state)
      if (!beforeHas) {
        if (!consumeVisit(state)) break
        recordChange(
          state,
          isDataDescriptor(afterDescriptor)
            ? { kind: 'added', path: childPath, after: snapshotValue(afterDescriptor.value, state) }
            : { kind: 'reference-only', path: childPath },
        )
        childChanged = true
        continue
      }
      if (!afterHas) {
        if (!consumeVisit(state)) break
        recordChange(
          state,
          isDataDescriptor(beforeDescriptor)
            ? {
                kind: 'removed',
                path: childPath,
                before: snapshotValue(beforeDescriptor.value, state),
              }
            : { kind: 'reference-only', path: childPath },
        )
        childChanged = true
        continue
      }
      if (!isDataDescriptor(beforeDescriptor) || !isDataDescriptor(afterDescriptor)) {
        if (!consumeVisit(state)) break
        state.truncated = true
        recordChange(state, { kind: 'reference-only', path: childPath })
        childChanged = true
        continue
      }

      childChanged =
        walk(beforeDescriptor.value, afterDescriptor.value, childPath, depth + 1, state) ||
        childChanged
    }
  } finally {
    removeActivePair(state, before, after)
  }

  if (
    !childChanged &&
    beforeScan.complete &&
    afterScan.complete &&
    !state.workExhausted &&
    !state.changesExhausted
  ) {
    recordChange(state, { kind: 'reference-only', path })
  }
  return true
}

function recordArrayLengthChange(
  before: object,
  after: object,
  path: string,
  state: DiffState,
): boolean {
  const beforeLength = safeOwnPropertyDescriptor(before, 'length')
  const afterLength = safeOwnPropertyDescriptor(after, 'length')
  const lengthPath = appendPointer(path, 'length', state)
  if (!isDataDescriptor(beforeLength) || !isDataDescriptor(afterLength)) {
    state.truncated = true
    if (consumeVisit(state)) recordChange(state, { kind: 'reference-only', path: lengthPath })
    return true
  }
  if (Object.is(beforeLength.value, afterLength.value)) return false
  if (!consumeVisit(state)) return true
  recordChange(state, {
    kind: 'value',
    path: lengthPath,
    before: snapshotValue(beforeLength.value, state),
    after: snapshotValue(afterLength.value, state),
  })
  return true
}

function consumeVisit(state: DiffState): boolean {
  if (state.outerBudget?.consumeVisit && !state.outerBudget.consumeVisit()) {
    state.truncated = true
    state.workExhausted = true
    return false
  }
  if (state.visited >= state.maxVisited) {
    state.truncated = true
    state.workExhausted = true
    return false
  }
  state.visited += 1
  return true
}

function recordChange(state: DiffState, change: DeepDiffChange): void {
  if (state.changes.length >= state.maxChanges) {
    state.truncated = true
    state.changesExhausted = true
    return
  }
  state.changes.push(change)
}

function containerKind(value: unknown): ContainerKind | null {
  return Array.isArray(value) ? 'array' : null
}

function isUnsupportedReference(value: unknown): boolean {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null && containerKind(value) === null)
  )
}

function scanArrayProperties(
  value: object,
  state: DiffState,
): { properties: { key: string; descriptor: PropertyDescriptor }[]; complete: boolean } {
  const lengthDescriptor = safeOwnPropertyDescriptor(value, 'length')
  if (!isDataDescriptor(lengthDescriptor) || typeof lengthDescriptor.value !== 'number') {
    return { properties: [], complete: false }
  }
  const length = Math.max(0, Math.floor(lengthDescriptor.value))
  const properties: { key: string; descriptor: PropertyDescriptor }[] = []
  const limit = Math.min(length, state.maxVisited, state.remainingPropertyScans)
  for (let index = 0; index < limit; index += 1) {
    if (state.outerBudget?.consumeVisit && !state.outerBudget.consumeVisit()) {
      state.truncated = true
      state.workExhausted = true
      return { properties, complete: false }
    }
    state.remainingPropertyScans -= 1
    const descriptor = safeOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined) return { properties, complete: false }
    if (descriptor?.enumerable) properties.push({ key: String(index), descriptor })
  }
  return { properties, complete: limit === length }
}

function snapshotValue(value: unknown, state: DiffState): DeepDiffValue {
  if (value === null) return value
  if (typeof value === 'string') {
    if (value.length <= MAX_TEXT_CODE_UNITS) return value
    state.truncated = true
    return { type: 'string', value: `${value.slice(0, MAX_TEXT_CODE_UNITS)}…`, truncated: true }
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { type: 'number', value: 'NaN' }
    if (value === Number.POSITIVE_INFINITY) return { type: 'number', value: 'Infinity' }
    if (value === Number.NEGATIVE_INFINITY) return { type: 'number', value: '-Infinity' }
    if (Object.is(value, -0)) return { type: 'number', value: '-0' }
    return value
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'undefined') return { type: 'undefined' }
  if (typeof value === 'bigint') {
    if (value > MAX_EXACT_BIGINT || value < -MAX_EXACT_BIGINT) {
      state.truncated = true
      return { type: 'bigint', value: value < 0 ? '-[large]' : '[large]' }
    }
    return { type: 'bigint', value: value.toString() }
  }
  if (typeof value === 'symbol') {
    const description = value.description ?? ''
    if (description.length > MAX_TEXT_CODE_UNITS) state.truncated = true
    return {
      type: 'symbol',
      value: `Symbol(${description.slice(0, MAX_TEXT_CODE_UNITS)}${description.length > MAX_TEXT_CODE_UNITS ? '…' : ''})`,
    }
  }
  if (typeof value === 'function') return { type: 'function' }

  return Array.isArray(value) ? { type: 'array' } : { type: 'instance' }
}

function appendPointer(path: string, segment: string, state: DiffState): string {
  const boundedSegment =
    segment.length > MAX_POINTER_SEGMENT_CODE_UNITS
      ? `${segment.slice(0, MAX_POINTER_SEGMENT_CODE_UNITS)}…`
      : segment
  if (boundedSegment !== segment) state.truncated = true
  const next = `${path}/${boundedSegment.replaceAll('~', '~0').replaceAll('/', '~1')}`
  if (next.length <= MAX_POINTER_CODE_UNITS) return next
  state.truncated = true
  return `${next.slice(0, MAX_POINTER_CODE_UNITS)}…`
}

function hasActivePair(state: DiffState, before: object, after: object): boolean {
  return state.activePairs.get(before)?.has(after) === true
}

function addActivePair(state: DiffState, before: object, after: object): void {
  let afterValues = state.activePairs.get(before)
  if (!afterValues) {
    afterValues = new WeakSet()
    state.activePairs.set(before, afterValues)
  }
  afterValues.add(after)
}

function removeActivePair(state: DiffState, before: object, after: object): void {
  state.activePairs.get(before)?.delete(after)
}

function boundedLimit(value: number | undefined, fallback: number, hardMax: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(hardMax, Math.max(0, Math.floor(value)))
}
