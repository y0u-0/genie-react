import { wrapperAncestryOf } from './fiber'
import { countExternalStoreHooks, type RenderCauseEvent } from './render-causes'
import {
  hasExactAppExternalStoreCallsite,
  resolveExternalStoreSourcesWithinBudget,
  withReportEvidence,
} from './render-evidence'
import type {
  RenderRecord,
  RenderReport,
  RenderSummary,
  RetainedRenderCauseEvent,
} from './render-model'
import type { ComponentAggregate } from './render-snapshots'
import {
  classifyFibersWithinBudget,
  type ExternalStoreSourceResolution,
  type FiberClassification,
  sourceAttributionForSource,
  sourceLabel,
  sourceProvenanceForSource,
} from './source'

const SOURCE_CLASSIFY_LIMIT = 120
const SOURCE_CLASSIFY_BUDGET_MS = 500
const UNCLASSIFIED_FIBER: FiberClassification = { source: null, isLibrary: false }

export interface RenderQuery {
  component?: string
  limit: number
  sort: 'renders' | 'unnecessary' | 'referenceOnly' | 'unstable' | 'selfTime'
  appOnly?: boolean
}

export interface RenderCauseQuery {
  commit?: number
  afterCommit?: number
  component?: string
  limit: number
  appOnly?: boolean
}

export interface ReportAttributionGuard {
  isCurrent: () => boolean
}

type ClassifiedRecord = {
  record: RenderRecord
  report: RenderReport
  libraryOnly: boolean
  appOwned: boolean
}

interface RecordSourceEvidence extends FiberClassification {
  hookSources: ExternalStoreSourceResolution
  externalStoreCount: number
  libraryOnly: boolean
  appOwned: boolean
}

async function selectRecords(
  records: Map<number, RenderRecord>,
  query: RenderQuery,
  guard?: ReportAttributionGuard,
): Promise<{ kept: ClassifiedRecord[]; libraryHidden: number }> {
  return selectClassifiedRecords(await classifyRecordReports([...records.values()], guard), query)
}

function selectClassifiedRecords(
  classified: ClassifiedRecord[],
  query: Pick<RenderQuery, 'component' | 'appOnly'>,
): { kept: ClassifiedRecord[]; libraryHidden: number } {
  let list = classified
  if (query.component) {
    const needle = query.component.toLowerCase()
    list = list.filter((entry) => entry.record.name.toLowerCase().includes(needle))
  }
  if (query.appOnly !== true) return { kept: list, libraryHidden: 0 }
  const kept = list.filter((entry) => entry.appOwned)
  return { kept, libraryHidden: list.length - kept.length }
}

async function classifyRecordReports(
  list: RenderRecord[],
  guard?: ReportAttributionGuard,
): Promise<ClassifiedRecord[]> {
  const resolvedEvidence = await recordSourceEvidence(list)
  const evidence =
    guard?.isCurrent() === false ? list.map(() => staleRecordSourceEvidence()) : resolvedEvidence
  return list.map((record, index): ClassifiedRecord => {
    const entry = evidence[index] ?? unknownRecordSourceEvidence()
    const { source, isLibrary, hookSources, externalStoreCount, libraryOnly, appOwned } = entry
    const { fiber: _fiber, latestRenderEventId: _latestRenderEventId, ...rest } = record
    return {
      record,
      libraryOnly,
      appOwned,
      report: {
        ...rest,
        causes: withReportEvidence(rest.causes, source, hookSources, externalStoreCount),
        noObservedInputChange: rest.unnecessary,
        compiler: {
          memoCacheObserved: rest.forget,
          evidence: 'exact',
          compilationStatus: 'unknown',
          limitation: 'runtime-memo-cache-presence-only',
        },
        instance: rest.instance,
        name: rest.name === 'Anonymous' ? (sourceLabel(source) ?? rest.name) : rest.name,
        source,
        sourceAttribution: sourceAttributionForSource(source),
        sourceProvenance: sourceProvenanceForSource(source),
        sourceOwnership: source ? (isLibrary ? 'library' : 'app') : 'unknown',
        isLibrary,
        wrapperAncestry: wrapperAncestryOf(record.fiber),
      },
    }
  })
}

async function recordSourceEvidence(records: RenderRecord[]): Promise<RecordSourceEvidence[]> {
  const [classes, hookSources] = await Promise.all([
    classifyRecordsWithinBudget(records),
    resolveExternalStoreSourcesWithinBudget(records.map((record) => record.fiber)),
  ])
  return records.map((record, index) => {
    const classification = classes[index] ?? UNCLASSIFIED_FIBER
    const hooks = hookSources[index] ?? { status: 'deadline-exceeded', hooks: null }
    const externalStoreCount = countExternalStoreHooks(record.fiber)
    const exactAppHook = hasExactAppExternalStoreCallsite(hooks, externalStoreCount)
    const appOwned = (classification.source !== null && !classification.isLibrary) || exactAppHook
    return {
      ...classification,
      hookSources: hooks,
      externalStoreCount,
      libraryOnly: classification.isLibrary && !exactAppHook,
      appOwned,
    }
  })
}

function unknownRecordSourceEvidence(): RecordSourceEvidence {
  return {
    ...UNCLASSIFIED_FIBER,
    hookSources: { status: 'deadline-exceeded', hooks: null },
    externalStoreCount: 0,
    libraryOnly: false,
    appOwned: false,
  }
}

function staleRecordSourceEvidence(): RecordSourceEvidence {
  return {
    ...UNCLASSIFIED_FIBER,
    hookSources: { status: 'report-state-advanced', hooks: null },
    externalStoreCount: 0,
    libraryOnly: false,
    appOwned: false,
  }
}

async function classifyRecordsWithinBudget(
  records: RenderRecord[],
): Promise<FiberClassification[]> {
  const { classes } = await classifyFibersWithinBudget(
    records.map((record) => record.fiber),
    { limit: SOURCE_CLASSIFY_LIMIT, budgetMs: SOURCE_CLASSIFY_BUDGET_MS },
  )
  return classes
}

function sortReports(entries: ClassifiedRecord[], sort: RenderQuery['sort']): ClassifiedRecord[] {
  return [...entries].sort((left, right) => {
    const before = left.report
    const after = right.report
    if (sort === 'selfTime') return after.selfTime - before.selfTime
    if (sort === 'unnecessary') return after.unnecessary - before.unnecessary
    if (sort === 'referenceOnly' || sort === 'unstable') {
      return after.referenceOnlyPropRenders - before.referenceOnlyPropRenders
    }
    return after.renders - before.renders
  })
}

export async function buildRenders(
  records: Map<number, RenderRecord>,
  query: RenderQuery,
): Promise<RenderReport[]> {
  const { kept } = await selectRecords(records, query)
  return sortReports(kept, query.sort)
    .slice(0, query.limit)
    .map((entry) => entry.report)
}

export async function buildRendersReport(
  records: Map<number, RenderRecord>,
  query: RenderQuery,
): Promise<{ components: RenderReport[]; libraryHidden: number; omittedByLimit: number }> {
  const { kept, libraryHidden } = await selectRecords(records, query)
  const components = sortReports(kept, query.sort)
    .slice(0, query.limit)
    .map((entry) => entry.report)
  return { components, libraryHidden, omittedByLimit: Math.max(0, kept.length - query.limit) }
}

/** Resolve source/hook evidence once so a measurement's summary and page use the same ownership set. */
export async function buildRendersMeasurementReport(
  records: Map<number, RenderRecord>,
  commits: number,
  query: RenderQuery,
  guard?: ReportAttributionGuard,
): Promise<{
  summary: RenderSummary
  components: RenderReport[]
  libraryHidden: number
  omittedByLimit: number
}> {
  const classified = await classifyRecordReports([...records.values()], guard)
  const { kept, libraryHidden } = selectClassifiedRecords(classified, query)
  return {
    summary: summarizeRecords(
      kept.map((entry) => entry.record),
      commits,
    ),
    components: sortReports(kept, query.sort)
      .slice(0, query.limit)
      .map((entry) => entry.report),
    libraryHidden,
    omittedByLimit: Math.max(0, kept.length - query.limit),
  }
}

export async function buildRenderCauseEventsReport(
  records: Map<number, RenderRecord>,
  recentEvents: readonly RetainedRenderCauseEvent[],
  query: RenderCauseQuery,
  guard?: ReportAttributionGuard,
): Promise<{ events: RenderCauseEvent[]; libraryHidden: number; omittedByLimit: number }> {
  const needle = query.component?.toLowerCase()
  const matching = recentEvents
    .filter((event) => query.commit === undefined || event.commitId === query.commit)
    .filter((event) => query.afterCommit === undefined || event.commitId > query.afterCommit)
    .filter((event) => !needle || event.componentName.toLowerCase().includes(needle))
  const liveRecords = [
    ...new Map(
      matching
        .map((event) => records.get(event.componentId))
        .filter((record): record is RenderRecord => record !== undefined)
        .map((record) => [record.id, record]),
    ).values(),
  ]
  const resolvedEvidence = await recordSourceEvidence(liveRecords)
  const attributionCurrent = guard?.isCurrent() !== false
  const evidence = attributionCurrent
    ? resolvedEvidence
    : liveRecords.map(() => staleRecordSourceEvidence())
  const evidenceById = new Map<number, RecordSourceEvidence>()
  liveRecords.forEach((record, index) => {
    evidenceById.set(record.id, evidence[index] ?? unknownRecordSourceEvidence())
  })

  const classified = [...matching].reverse().map((event) => {
    const classification = evidenceById.get(event.componentId) ?? unknownRecordSourceEvidence()
    const liveRecord = records.get(event.componentId)
    const isLatestEvent =
      liveRecord !== undefined &&
      liveRecord.latestRenderEventId === event.renderEventId &&
      liveRecord.instance.mountId === event.instance.mountId
    const eventSource = attributionCurrent && isLatestEvent ? classification.source : null
    const unavailableReason = !attributionCurrent
      ? 'report-state-advanced'
      : liveRecord === undefined
        ? 'component-unmounted'
        : isLatestEvent
          ? undefined
          : 'event-not-latest'
    const reported: RenderCauseEvent = {
      ...event,
      causes: withReportEvidence(
        event.causes,
        eventSource,
        isLatestEvent ? classification.hookSources : undefined,
        isLatestEvent ? classification.externalStoreCount : 0,
        unavailableReason,
      ),
      instance: event.instance,
      source: eventSource,
      sourceAttribution: eventSource
        ? sourceAttributionForSource(eventSource)
        : { role: 'unavailable', evidence: 'unknown' },
      sourceOwnership: eventSource ? (classification.isLibrary ? 'library' : 'app') : 'unknown',
      isLibrary: eventSource ? classification.isLibrary : false,
    }
    return {
      event: reported,
      libraryOnly: isLatestEvent ? classification.libraryOnly : false,
      appOwned: isLatestEvent ? classification.appOwned : false,
    }
  })
  const visible =
    query.appOnly !== true ? classified : classified.filter(({ appOwned }) => appOwned)
  const libraryHidden =
    query.appOnly !== true ? 0 : classified.filter(({ appOwned }) => !appOwned).length
  return {
    events: visible.slice(0, query.limit).map(({ event }) => event),
    libraryHidden,
    omittedByLimit: Math.max(0, visible.length - query.limit),
  }
}

export async function buildRendersLeaderboards(
  records: Map<number, RenderRecord>,
  limit: number,
  guard?: ReportAttributionGuard,
): Promise<{
  slowest: RenderReport[]
  mostRerendered: RenderReport[]
  mostUnnecessary: RenderReport[]
  mostUnstable: RenderReport[]
}> {
  const { kept } = await selectRecords(records, { limit, sort: 'renders' }, guard)
  const top = (sort: RenderQuery['sort']): RenderReport[] =>
    sortReports(kept, sort)
      .slice(0, limit)
      .map((entry) => entry.report)
  return {
    slowest: top('selfTime'),
    mostRerendered: top('renders'),
    mostUnnecessary: top('unnecessary'),
    mostUnstable: top('unstable'),
  }
}

export async function buildRenderSummary(
  records: Map<number, RenderRecord>,
  commits: number,
  appOnly = false,
): Promise<RenderSummary> {
  let list = [...records.values()]
  if (appOnly) {
    const evidence = await recordSourceEvidence(list)
    list = list.filter((_, index) => evidence[index]?.appOwned === true)
  }
  return summarizeRecords(list, commits)
}

function summarizeRecords(list: RenderRecord[], commits: number): RenderSummary {
  let totalRenders = 0
  let totalUpdates = 0
  let unstableComponents = 0
  let referenceOnlyPropComponents = 0
  let unnecessaryComponents = 0
  const unstablePropCounts = new Map<string, number>()
  const referenceOnlyPropCounts = new Map<string, number>()
  for (const record of list) {
    totalRenders += record.renders
    totalUpdates += record.updates
    if (record.referenceOnlyPropRenders > 0) {
      referenceOnlyPropComponents += 1
      unstableComponents += 1
    }
    if (record.unnecessary > 0) unnecessaryComponents += 1
    for (const change of record.changes) {
      if (change.kind === 'props' && change.unstable) {
        unstablePropCounts.set(change.name, (unstablePropCounts.get(change.name) ?? 0) + 1)
      }
      if (change.kind === 'props' && change.referenceOnly) {
        referenceOnlyPropCounts.set(
          change.name,
          (referenceOnlyPropCounts.get(change.name) ?? 0) + 1,
        )
      }
    }
  }
  return {
    commits,
    trackedComponents: list.length,
    totalRenders,
    totalUpdates,
    unstableComponents,
    referenceOnlyPropComponents,
    unnecessaryComponents,
    noObservedInputChangeComponents: unnecessaryComponents,
    topUnstableProps: [...unstablePropCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 10),
    topReferenceOnlyProps: [...referenceOnlyPropCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 10),
  }
}

export async function buildCurrentAggregates(
  records: Map<number, RenderRecord>,
  appOnly = false,
  guard?: ReportAttributionGuard,
): Promise<ComponentAggregate[]> {
  const list = [...records.values()]
  const resolvedEvidence = await recordSourceEvidence(list)
  const evidence =
    guard?.isCurrent() === false ? list.map(() => staleRecordSourceEvidence()) : resolvedEvidence
  const aggregates = new Map<string, ComponentAggregate>()
  list.forEach((record, index) => {
    const { source, appOwned } = evidence[index] ?? unknownRecordSourceEvidence()
    if (appOnly && !appOwned) return
    const displayLabel = sourceLabel(source)
    const canonicalSource = source
      ? `${source.file}:${source.line ?? '?'}:${source.column ?? '?'}`
      : null
    const definitionKey = componentDefinitionKey(record)
    const current = aggregates.get(definitionKey)
    if (current) {
      current.renders += record.renders
      current.mounts += record.mounts
      current.updates += record.updates
      current.selfTime += record.cumulativeSelfTime
      current.totalTime += record.cumulativeTotalTime
      current.unnecessary += record.unnecessary
      current.referenceOnlyPropRenders += record.referenceOnlyPropRenders
      current.unstableRenders += record.unstableRenders
      return
    }
    aggregates.set(definitionKey, {
      definitionKey,
      name: record.name === 'Anonymous' ? (displayLabel ?? record.name) : record.name,
      source: canonicalSource,
      renders: record.renders,
      mounts: record.mounts,
      updates: record.updates,
      selfTime: record.cumulativeSelfTime,
      totalTime: record.cumulativeTotalTime,
      unnecessary: record.unnecessary,
      referenceOnlyPropRenders: record.referenceOnlyPropRenders,
      unstableRenders: record.unstableRenders,
    })
  })
  return [...aggregates.values()]
}

const componentDefinitionIds = new WeakMap<object, number>()
let nextComponentDefinitionId = 1

function componentDefinitionKey(record: RenderRecord): string {
  const definition = record.fiber.elementType ?? record.fiber.type
  if ((typeof definition === 'object' && definition !== null) || typeof definition === 'function') {
    let id = componentDefinitionIds.get(definition)
    if (id === undefined) {
      id = nextComponentDefinitionId
      nextComponentDefinitionId += 1
      componentDefinitionIds.set(definition, id)
    }
    return `definition:${id}`
  }
  return `fiber:${record.id}`
}
