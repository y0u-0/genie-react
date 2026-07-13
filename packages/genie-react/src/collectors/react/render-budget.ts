import { type CommitWorkBudget, consumeCommitWork } from './commit-budget'
import {
  createDeepDiffBudget,
  type DeepDiffBudget,
  type DeepDiffResult,
  deepDiff,
} from './deep-diff'

const INPUT_EVIDENCE_LIMIT = 50
const DEEP_DIFF_VISIT_LIMIT = 500
const DEEP_DIFF_CHANGE_LIMIT = 50

export interface RenderEvidenceBudget {
  remainingInputs: number
  omittedInputs: number
  scanTruncated: boolean
  propsNotEnumerated: boolean
  deepDiff: DeepDiffBudget
  commitWork: CommitWorkBudget | undefined
}

export interface RenderInputCoverage {
  complete: boolean
  omittedInputs: number
  scanTruncated: boolean
  propsNotEnumerated: boolean
}

export function createRenderEvidenceBudget(commitWork?: CommitWorkBudget): RenderEvidenceBudget {
  return {
    remainingInputs: INPUT_EVIDENCE_LIMIT,
    omittedInputs: 0,
    scanTruncated: false,
    propsNotEnumerated: false,
    deepDiff: createDeepDiffBudget(DEEP_DIFF_VISIT_LIMIT, DEEP_DIFF_CHANGE_LIMIT, () =>
      consumeCommitWork(commitWork, 'deep-diff'),
    ),
    commitWork,
  }
}

export function scanInputEvidence(budget: RenderEvidenceBudget, subsystem: string): boolean {
  if (consumeCommitWork(budget.commitWork, subsystem)) return true
  truncateInputScan(budget)
  return false
}

export function retainInputEvidence(budget: RenderEvidenceBudget): boolean {
  if (budget.remainingInputs > 0) {
    budget.remainingInputs -= 1
    return true
  }
  budget.omittedInputs += 1
  return false
}

export function truncateInputScan(budget: RenderEvidenceBudget): void {
  budget.scanTruncated = true
}

export function markPropsNotEnumerated(budget: RenderEvidenceBudget): void {
  budget.propsNotEnumerated = true
}

export function diffWithBudget(
  before: unknown,
  after: unknown,
  budget: RenderEvidenceBudget,
): DeepDiffResult {
  return deepDiff(before, after, { budget: budget.deepDiff })
}

export function inputCoverage(budget: RenderEvidenceBudget): RenderInputCoverage {
  return {
    complete: budget.omittedInputs === 0 && !budget.scanTruncated && !budget.propsNotEnumerated,
    omittedInputs: budget.omittedInputs,
    scanTruncated: budget.scanTruncated,
    propsNotEnumerated: budget.propsNotEnumerated,
  }
}
