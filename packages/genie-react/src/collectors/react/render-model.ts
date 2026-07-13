import type { Fiber } from 'bippy'
import type { InstanceDescriptor } from './instance-identity'
import type { RenderInputCoverage } from './render-budget'
import {
  emptyCauseCounts,
  type RenderCause,
  type RenderCauseCounts,
  type RenderNecessity,
} from './render-causes'
import type { RenderChange } from './render-inputs'
import { pendingRenderAssessment, type RenderAssessment } from './render-outcomes'
import type { ResolvedSource, sourceAttributionForSource } from './source'

export interface RenderRecord {
  id: number
  name: string
  instance: InstanceDescriptor
  renders: number
  mounts: number
  updates: number
  unnecessary: number
  referenceOnlyPropRenders: number
  /** Legacy alias for referenceOnlyPropRenders. */
  unstableRenders: number
  forget: boolean
  selfTime: number
  totalTime: number
  /** Sum across every observed render in the current measurement window. */
  cumulativeSelfTime: number
  cumulativeTotalTime: number
  changes: RenderChange[]
  latestCommitId: number
  latestDocumentCommitId: number
  latestRenderEventId: string | null
  causes: RenderCause[]
  causeCounts: RenderCauseCounts
  necessity: RenderNecessity
  assessment: RenderAssessment
  inputCoverage: RenderInputCoverage
  /** Live handle used only for report-time source classification. */
  fiber: Fiber
}

export interface RenderReport extends Omit<RenderRecord, 'fiber' | 'latestRenderEventId'> {
  noObservedInputChange: number
  compiler: {
    memoCacheObserved: boolean
    evidence: 'exact'
    compilationStatus: 'unknown'
    limitation: 'runtime-memo-cache-presence-only'
  }
  source: ResolvedSource | null
  sourceAttribution: ReturnType<typeof sourceAttributionForSource>
  sourceOwnership: 'app' | 'library' | 'unknown'
  isLibrary: boolean
}

export interface RenderSummary {
  commits: number
  trackedComponents: number
  totalRenders: number
  totalUpdates: number
  unstableComponents: number
  referenceOnlyPropComponents: number
  unnecessaryComponents: number
  noObservedInputChangeComponents: number
  topUnstableProps: { name: string; count: number }[]
  topReferenceOnlyProps: { name: string; count: number }[]
}

export interface ReportAttribution {
  status: 'current' | 'stale'
  startedAtDocumentCommitId: number
  completedAtDocumentCommitId: number
  startedAtAnalysisGeneration: number
  completedAtAnalysisGeneration: number
}

export interface RetainedRenderCauseEvent {
  renderEventId: string
  observationId: string | null
  commitId: number
  documentCommitId: number
  componentId: number
  componentName: string
  instance: InstanceDescriptor
  causes: RenderCause[]
  necessity: RenderNecessity
  assessment: RenderAssessment
  inputCoverage: RenderInputCoverage
}

export interface RenderRecordDraftInput {
  id: number
  name: string
  instance: InstanceDescriptor
  fiber: Fiber
  forget: boolean
  timings: { selfTime: number; totalTime: number }
  commitId: number
  documentCommitId: number
}

/** Create an unpublished record draft so failed analysis cannot mutate shared measurement state. */
export function draftRenderRecord(
  existing: RenderRecord | undefined,
  input: RenderRecordDraftInput,
): RenderRecord {
  const record: RenderRecord = existing
    ? { ...existing, causeCounts: { ...existing.causeCounts } }
    : {
        id: input.id,
        name: input.name,
        instance: input.instance,
        renders: 0,
        mounts: 0,
        updates: 0,
        unnecessary: 0,
        referenceOnlyPropRenders: 0,
        unstableRenders: 0,
        forget: input.forget,
        selfTime: 0,
        totalTime: 0,
        cumulativeSelfTime: 0,
        cumulativeTotalTime: 0,
        changes: [],
        latestCommitId: input.commitId,
        latestDocumentCommitId: input.documentCommitId,
        latestRenderEventId: null,
        causes: [],
        causeCounts: emptyCauseCounts(),
        necessity: 'unknown',
        assessment: pendingRenderAssessment(),
        inputCoverage: {
          complete: false,
          omittedInputs: 0,
          scanTruncated: true,
          propsNotEnumerated: false,
        },
        fiber: input.fiber,
      }
  record.fiber = input.fiber
  record.instance = input.instance
  record.selfTime = Math.max(record.selfTime, input.timings.selfTime)
  record.totalTime = Math.max(record.totalTime, input.timings.totalTime)
  record.cumulativeSelfTime += input.timings.selfTime
  record.cumulativeTotalTime += input.timings.totalTime
  record.latestCommitId = input.commitId
  record.latestDocumentCommitId = input.documentCommitId
  return record
}
