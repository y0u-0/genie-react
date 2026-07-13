import { getAnalysisGeneration, getDocumentCommitId } from './observation'
import type { ReportAttribution } from './render-model'

export interface ReportEpoch {
  documentCommitId: number
  analysisGeneration: number
}

export function captureReportEpoch(): ReportEpoch {
  return {
    documentCommitId: getDocumentCommitId(),
    analysisGeneration: getAnalysisGeneration(),
  }
}

export function reportStateMatches(epoch: ReportEpoch): boolean {
  return (
    getDocumentCommitId() === epoch.documentCommitId &&
    getAnalysisGeneration() === epoch.analysisGeneration
  )
}

export function reportAttribution(epoch: ReportEpoch): ReportAttribution {
  const completedAtDocumentCommitId = getDocumentCommitId()
  const completedAtAnalysisGeneration = getAnalysisGeneration()
  return {
    status:
      completedAtDocumentCommitId === epoch.documentCommitId &&
      completedAtAnalysisGeneration === epoch.analysisGeneration
        ? 'current'
        : 'stale',
    startedAtDocumentCommitId: epoch.documentCommitId,
    completedAtDocumentCommitId,
    startedAtAnalysisGeneration: epoch.analysisGeneration,
    completedAtAnalysisGeneration,
  }
}
