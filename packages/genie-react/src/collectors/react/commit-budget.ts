const DEFAULT_OPERATION_LIMIT = 20_000
const DEFAULT_TIME_LIMIT_MS = 8

export interface CommitWorkBudget {
  remainingOperations: number
  deadlineAt: number
  exhaustedSubsystems: Set<string>
  readonly now: () => number
}

export interface CommitWorkBudgetOptions {
  operationLimit?: number
  timeLimitMs?: number
  now?: () => number
}

function monotonicNow(): number {
  return globalThis.performance?.now?.() ?? Date.now()
}

/** One shared guard for every synchronous analysis step performed by a React commit. */
export function createCommitWorkBudget(options: CommitWorkBudgetOptions = {}): CommitWorkBudget {
  const now = options.now ?? monotonicNow
  const operationLimit = boundedPositiveInteger(options.operationLimit, DEFAULT_OPERATION_LIMIT)
  const timeLimitMs = boundedPositiveNumber(options.timeLimitMs, DEFAULT_TIME_LIMIT_MS)
  return {
    remainingOperations: operationLimit,
    deadlineAt: now() + timeLimitMs,
    exhaustedSubsystems: new Set(),
    now,
  }
}

/** Consume bounded work before touching app-owned Fiber data. False means skip and disclose. */
export function consumeCommitWork(
  budget: CommitWorkBudget | undefined,
  subsystem: string,
  operations = 1,
): boolean {
  if (!budget) return true
  if (budget.now() >= budget.deadlineAt) {
    budget.exhaustedSubsystems.add(subsystem)
    return false
  }
  const cost = Math.max(1, Math.ceil(operations))
  if (budget.remainingOperations < cost) {
    budget.exhaustedSubsystems.add(subsystem)
    budget.remainingOperations = 0
    return false
  }
  budget.remainingOperations -= cost
  return true
}

export function commitWorkExhaustions(budget: CommitWorkBudget): string[] {
  return [...budget.exhaustedSubsystems].sort()
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}

function boundedPositiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0.1, value)
}
