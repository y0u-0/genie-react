export interface ObservationWindow {
  /** Unique within this browser document. */
  id: string
  epoch: number
  /** The last document-wide React commit observed before this window started. */
  startedAfterDocumentCommitId: number
}

export type CausalEventKind = 'render' | 'effect' | 'notification'

let observationEpoch = 0
let documentCommitId = 0
let analysisGeneration = 0
let eventSequence = 0
let activeObservation: ObservationWindow | null = null

/** Start one explicit measurement window. This is not called an interaction: no user input is implied. */
export function beginObservation(): ObservationWindow {
  analysisGeneration += 1
  observationEpoch += 1
  activeObservation = {
    id: `observation:${observationEpoch}`,
    epoch: observationEpoch,
    startedAfterDocumentCommitId: documentCommitId,
  }
  return { ...activeObservation }
}

/** Advance the document-wide commit sequence. Unlike profile counters, this never resets on clear. */
export function noteDocumentCommit(): number {
  documentCommitId += 1
  analysisGeneration += 1
  return documentCommitId
}

export function getDocumentCommitId(): number {
  return documentCommitId
}

/** Advance when report inputs change without a document commit, such as HMR teardown. */
export function noteAnalysisInvalidation(): number {
  analysisGeneration += 1
  return analysisGeneration
}

export function getAnalysisGeneration(): number {
  return analysisGeneration
}

export function getActiveObservation(): ObservationWindow | null {
  return activeObservation ? { ...activeObservation } : null
}

/** Event IDs are document-local and monotonic, so clears cannot create collisions. */
export function nextCausalEventId(kind: CausalEventKind): string {
  eventSequence += 1
  return `${kind}:${documentCommitId}:${eventSequence}`
}

/** Test-only reset for deterministic isolated module tests. Runtime clears must use beginObservation(). */
export function resetObservationStateForTests(): void {
  observationEpoch = 0
  documentCommitId = 0
  analysisGeneration = 0
  eventSequence = 0
  activeObservation = null
}
