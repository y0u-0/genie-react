import { isRecord } from './guards'

export function summarizeCapture(result: unknown): string | null {
  if (
    !isRecord(result) ||
    typeof result.captureId !== 'string' ||
    typeof result.name !== 'string' ||
    !Array.isArray(result.include) ||
    !isRecord(result.consistency) ||
    !isRecord(result.sections)
  ) {
    return null
  }
  const consistency = result.consistency
  const stable = consistency.kind === 'react-commit-stable'
  const consistencyText = stable
    ? `stable at React commit ${num(consistency.reactCommit)}`
    : `best effort after ${num(consistency.attempts)} attempt${num(consistency.attempts) === 1 ? '' : 's'}`
  const completeSections = Object.values(result.sections).filter(
    (section) => isRecord(section) && section.status === 'ok',
  ).length
  const lines = [
    `capture ${JSON.stringify(result.name)} · ${consistencyText} · ${completeSections}/${result.include.length} sections · ${result.complete === true ? 'complete' : 'incomplete'} · ${formatBytes(num(result.sizeBytes))} · ${result.captureId}`,
  ]
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter((warning): warning is string => typeof warning === 'string')
    : []
  for (const warning of warnings.slice(0, 3)) lines.push(`  ! ${warning}`)
  if (warnings.length > 3) lines.push(`  ! +${warnings.length - 3} more warnings`)
  return lines.join('\n')
}

export function summarizeCaptureList(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.captures)) return null
  const captures = result.captures.filter(isRecord)
  const total = num(result.total)
  const maxRetained = num(result.maxRetained)
  if (captures.length === 0) return `no retained captures · max ${maxRetained}`
  const lines = [
    `${total} retained capture${total === 1 ? '' : 's'} · max ${maxRetained} · newest first`,
  ]
  for (const capture of captures) {
    const consistency = isRecord(capture.consistency) ? capture.consistency : {}
    const consistencyText =
      consistency.kind === 'react-commit-stable'
        ? `commit ${num(consistency.reactCommit)}`
        : 'best effort'
    lines.push(
      `  ${String(capture.captureId)} · ${JSON.stringify(String(capture.name))} · ${consistencyText} · ${capture.complete === true ? 'complete' : 'incomplete'} · ${formatBytes(num(capture.sizeBytes))}`,
    )
  }
  return lines.join('\n')
}

export function summarizeCaptureComparison(result: unknown): string | null {
  if (
    !isRecord(result) ||
    result.kind !== 'capture-comparison' ||
    typeof result.comparisonId !== 'string' ||
    !Array.isArray(result.baselineCaptureIds) ||
    !Array.isArray(result.candidateCaptureIds) ||
    !Array.isArray(result.metrics)
  ) {
    return null
  }
  const lines = [
    `${String(result.overall).toUpperCase()} comparison · ${result.baselineCaptureIds.length} baseline vs ${result.candidateCaptureIds.length} candidate · min ${num(result.minimumRuns)} runs · ${result.comparisonId}`,
  ]
  for (const metric of result.metrics.filter(isRecord)) {
    const baseline = isRecord(metric.baseline) ? metric.baseline : {}
    const candidate = isRecord(metric.candidate) ? metric.candidate : {}
    const delta = isRecord(metric.delta) ? metric.delta : {}
    const regression =
      typeof delta.regressionPct === 'number' ? ` · regression ${signed(delta.regressionPct)}%` : ''
    const spread = `p95 ${statValue(baseline.p95)}→${statValue(candidate.p95)} · MAD ${statValue(baseline.mad)}→${statValue(candidate.mad)}`
    lines.push(
      `  ${String(metric.verdict).toUpperCase()} ${String(metric.metric)} · median ${statValue(baseline.median)}→${statValue(candidate.median)}${regression} · ${spread} · ${String(metric.confidence)} confidence${budgetSuffix(metric.budget)}`,
    )
    if (Array.isArray(metric.reasons)) {
      for (const reason of metric.reasons.slice(0, 3)) lines.push(`    ! ${String(reason)}`)
    }
  }
  if (Array.isArray(result.warnings)) {
    for (const warning of result.warnings.slice(0, 3)) lines.push(`  ! ${String(warning)}`)
  }
  return lines.join('\n')
}

const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
const round = (value: number): number => Math.round(value * 10) / 10
const signed = (value: number): string => (value > 0 ? `+${round(value)}` : String(round(value)))

function statValue(value: unknown): string {
  return typeof value === 'number' ? String(round(value)) : 'n/a'
}

function budgetSuffix(value: unknown): string {
  if (!isRecord(value)) return ''
  const constraints: string[] = []
  if (typeof value.maxRegressionPct === 'number')
    constraints.push(`regression≤${round(value.maxRegressionPct)}%`)
  if (typeof value.maxValue === 'number') constraints.push(`value≤${round(value.maxValue)}`)
  if (typeof value.minValue === 'number') constraints.push(`value≥${round(value.minValue)}`)
  return constraints.length > 0 ? ` · budget ${constraints.join(', ')}` : ''
}

function formatBytes(bytes: number): string {
  return bytes < 1_000 ? `${bytes} B` : `${round(bytes / 1_000)} KB`
}
