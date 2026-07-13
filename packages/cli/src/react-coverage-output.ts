import { isRecord } from './guards'
import { num } from './react-output-utils'

export function coverageSuffix(value: unknown): string {
  const label = coverageLabel(value)
  return label ? ` · ${label}` : ''
}

export function coverageLabel(value: unknown): string | null {
  if (!isRecord(value) || value.complete !== false) return null
  const issues: string[] = []
  if (value.rootAvailable === false) issues.push('React root unavailable')
  const skipped = num(value.skippedCommitFibers)
  const dropped = num(value.droppedUnmountFibers)
  const failed = num(value.analysisFailedFibers)
  const truncatedInputs = num(value.truncatedInputFibers)
  const opaqueProps = num(value.propsNotEnumeratedFibers)
  const generationEvictions = num(value.generationHistoryEvictions)
  const budgetExhausted = num(value.budgetExhaustedCommits)
  if (skipped > 0) issues.push(`${skipped} commit fibers skipped`)
  if (dropped > 0) issues.push(`${dropped} component unmounts dropped`)
  if (failed > 0) issues.push(`${failed} component analyses failed`)
  if (truncatedInputs > 0) issues.push(`${truncatedInputs} component input scans truncated`)
  if (opaqueProps > 0)
    issues.push(
      `${opaqueProps} prop container${opaqueProps === 1 ? '' : 's'} not enumerated; inspect an explicit component prop or path`,
    )
  if (generationEvictions > 0)
    issues.push(`${generationEvictions} generation-history entries evicted`)
  if (budgetExhausted > 0) {
    const subsystems = Array.isArray(value.budgetExhaustedSubsystems)
      ? value.budgetExhaustedSubsystems
          .filter(isRecord)
          .map((entry) => String(entry.subsystem))
          .slice(0, 6)
          .join(',')
      : ''
    issues.push(
      `${budgetExhausted} commit budgets exhausted${subsystems ? ` in ${subsystems}` : ''}`,
    )
  }
  if (value.rootScopeComplete === false && typeof value.rootScope === 'string')
    issues.push(`root scope ${value.rootScope}`)
  return issues.length > 0 ? `coverage incomplete (${issues.join('; ')})` : 'coverage incomplete'
}

export function inputAttributionSuffix(value: unknown): string {
  if (!isRecord(value) || value.complete === false || value.inputAttributionComplete !== false)
    return ''
  const opaqueProps = num(value.propsNotEnumeratedFibers)
  return opaqueProps > 0
    ? ` · input attribution partial (${opaqueProps} prop container${opaqueProps === 1 ? '' : 's'} not enumerated; inspect an explicit prop or path)`
    : ' · input attribution partial'
}

export function attributionSuffix(value: unknown): string {
  if (!isRecord(value) || value.status !== 'stale') return ''
  const startedCommit = num(value.startedAtDocumentCommitId)
  const completedCommit = num(value.completedAtDocumentCommitId)
  const startedGeneration = value.startedAtAnalysisGeneration
  const completedGeneration = value.completedAtAnalysisGeneration
  const range =
    startedCommit !== completedCommit ||
    typeof startedGeneration !== 'number' ||
    typeof completedGeneration !== 'number'
      ? `${startedCommit}→${completedCommit}`
      : `analysis generation ${startedGeneration}→${completedGeneration}`
  return ` · attribution stale (${range}; retry when commits settle)`
}

export function renderEventRetentionSuffix(value: unknown): string {
  if (!isRecord(value)) return ''
  const evicted = num(value.evictedEvents)
  return evicted > 0
    ? ` · ${evicted} render event${evicted === 1 ? '' : 's'} evicted (clear, repeat, and read sooner)`
    : ''
}

export function effectCoverageSuffix(value: unknown): string {
  const label = effectCoverageLabel(value)
  return label ? ` · ${label}` : ''
}

export function effectCoverageLabel(value: unknown): string | null {
  if (!isRecord(value) || value.complete !== false) return null
  const issues: string[] = []
  appendCount(issues, value.skippedCommitFibers, 'skipped commit fiber', 'skipped commit fibers')
  appendCount(issues, value.droppedUnmountFibers, 'dropped unmount fiber', 'dropped unmount fibers')
  appendCount(issues, value.analysisFailedFibers, 'failed fiber analysis', 'failed fiber analyses')
  appendCount(issues, value.truncatedInputFibers, 'truncated input scan', 'truncated input scans')
  appendCount(issues, value.truncatedEffectLists, 'truncated effect list', 'truncated effect lists')
  appendCount(
    issues,
    value.budgetExhaustedCommits,
    'exhausted commit budget',
    'exhausted commit budgets',
  )
  if (Array.isArray(value.budgetExhaustedSubsystems)) {
    const subsystems = value.budgetExhaustedSubsystems
      .filter(isRecord)
      .map((entry) => String(entry.subsystem))
      .slice(0, 6)
    if (subsystems.length > 0) issues.push(`budget stopped ${subsystems.join(',')}`)
  }
  const details = issues.length > 0 ? ` (${issues.join('; ')})` : ''
  return `coverage incomplete${details} · action: call react_clear_renders, repeat the interaction, then rerun with a narrower component filter`
}

function appendCount(target: string[], value: unknown, singular: string, plural: string): void {
  const count = num(value)
  if (count > 0) target.push(`${count} ${count === 1 ? singular : plural}`)
}
