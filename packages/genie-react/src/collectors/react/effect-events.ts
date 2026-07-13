import type { Fiber, RenderPhase } from 'bippy'
import { type CommitWorkBudget, consumeCommitWork } from './commit-budget'
import { nameOf } from './fiber'
import { type InstanceDescriptor, instanceForMountedFiber } from './instance-identity'
import {
  getActiveObservation,
  getDocumentCommitId,
  nextCausalEventId,
  type ObservationWindow,
} from './observation'

export type ScheduledEffectKind = 'effect' | 'layout' | 'insertion'

export interface EffectScheduleEvent {
  effectEventId: string
  effectId: string
  observationId: string | null
  commitId: number
  documentCommitId: number
  componentId: number
  componentName: string
  mountId: string
  effectIndex: number
  kind: ScheduledEffectKind
  phase: 'mount' | 'update'
  event: 'scheduled'
  evidence: 'exact'
  changedDependencySlots: number[]
  changedDependencySlotsOmitted: number
  dependencySlotsUnscanned: number
  execution: { status: 'unobserved' }
  cleanupExecution: { status: 'unobserved' }
  consequences: { status: 'not-instrumented'; events: [] }
}

const EFFECT_EVENT_LIMIT = 1_000
const DEPENDENCY_SCAN_LIMIT = 200
const CHANGED_DEPENDENCY_LIMIT = 50
const events: EffectScheduleEvent[] = []
let droppedEvents = 0

export function clearEffectEvents(): void {
  events.length = 0
  droppedEvents = 0
}

export function recordEffectSchedule(input: {
  fiber: Fiber
  profileCommitId: number
  phase: RenderPhase
  effectIndex: number
  kind: ScheduledEffectKind
  dependencies: unknown[] | null
  previousDependencies: unknown[] | null
  budget?: CommitWorkBudget
}): void {
  const prepared = prepareEffectSchedule(input)
  if (prepared) publishEffectSchedule(prepared)
}

export interface PreparedEffectSchedule {
  fiber: Fiber
  budget: CommitWorkBudget | undefined
  effectEventId: string
  observationId: string | null
  commitId: number
  documentCommitId: number
  componentName: string
  effectIndex: number
  kind: ScheduledEffectKind
  phase: 'mount' | 'update'
  dependencyChanges: { slots: number[]; omitted: number; unscanned: number }
}

/** Read dependency evidence without exposing a global event until its render publishes. */
export function prepareEffectSchedule(input: {
  fiber: Fiber
  profileCommitId: number
  phase: RenderPhase
  effectIndex: number
  kind: ScheduledEffectKind
  dependencies: unknown[] | null
  previousDependencies: unknown[] | null
  budget?: CommitWorkBudget
}): PreparedEffectSchedule | null {
  if (input.phase === 'unmount') return null
  const dependencyChanges =
    input.phase === 'update'
      ? changedDependencySlots(input.dependencies, input.previousDependencies, input.budget)
      : { slots: [], omitted: 0, unscanned: 0 }
  return {
    fiber: input.fiber,
    budget: input.budget,
    effectEventId: nextCausalEventId('effect'),
    observationId: getActiveObservation()?.id ?? null,
    commitId: input.profileCommitId,
    documentCommitId: getDocumentCommitId(),
    componentName: nameOf(input.fiber),
    effectIndex: input.effectIndex,
    kind: input.kind,
    phase: input.phase,
    dependencyChanges,
  }
}

/** Publish a fully prepared event; this path performs no app-owned reads. */
export function publishEffectSchedule(
  prepared: PreparedEffectSchedule,
  publishedInstance?: InstanceDescriptor,
): void {
  const instance = publishedInstance ?? instanceForMountedFiber(prepared.fiber, prepared.budget)
  const event: EffectScheduleEvent = {
    effectEventId: prepared.effectEventId,
    effectId: `effect:${instance.mountId}:${prepared.effectIndex}`,
    observationId: prepared.observationId,
    commitId: prepared.commitId,
    documentCommitId: prepared.documentCommitId,
    componentId: instance.fiberId,
    componentName: prepared.componentName,
    mountId: instance.mountId,
    effectIndex: prepared.effectIndex,
    kind: prepared.kind,
    phase: prepared.phase,
    event: 'scheduled',
    evidence: 'exact',
    changedDependencySlots: prepared.dependencyChanges.slots,
    changedDependencySlotsOmitted: prepared.dependencyChanges.omitted,
    dependencySlotsUnscanned: prepared.dependencyChanges.unscanned,
    execution: { status: 'unobserved' },
    cleanupExecution: { status: 'unobserved' },
    consequences: { status: 'not-instrumented', events: [] },
  }
  events.push(event)
  if (events.length > EFFECT_EVENT_LIMIT) {
    events.shift()
    droppedEvents += 1
  }
}

export function getEffectScheduleEvents(query: {
  component?: string
  afterDocumentCommitId?: number
  limit: number
}): {
  observation: ObservationWindow | null
  events: EffectScheduleEvent[]
  omittedByLimit: number
  evictedEvents: number
  droppedEvents: number
} {
  const needle = query.component?.toLowerCase()
  const matching = events
    .filter(
      (event) =>
        query.afterDocumentCommitId === undefined ||
        event.documentCommitId > query.afterDocumentCommitId,
    )
    .filter((event) => !needle || event.componentName.toLowerCase().includes(needle))
  const selected = matching.slice(-query.limit).reverse()
  return {
    observation: getActiveObservation(),
    events: selected,
    omittedByLimit: Math.max(0, matching.length - query.limit),
    evictedEvents: droppedEvents,
    droppedEvents,
  }
}

export function changedDependencySlots(
  current: unknown[] | null,
  previous: unknown[] | null,
  budget?: CommitWorkBudget,
): { slots: number[]; omitted: number; unscanned: number } {
  if (!Array.isArray(current) || !Array.isArray(previous)) {
    return { slots: [], omitted: 0, unscanned: 0 }
  }
  const length = Math.max(current.length, previous.length)
  const scanned = Math.min(length, DEPENDENCY_SCAN_LIMIT)
  const slots: number[] = []
  let omitted = 0
  for (let index = 0; index < scanned; index += 1) {
    if (!consumeCommitWork(budget, 'effect-dependencies')) {
      return { slots, omitted, unscanned: length - index }
    }
    let changed = false
    try {
      changed = !Object.is(current[index], previous[index])
    } catch {
      return { slots, omitted, unscanned: length - index }
    }
    if (!changed) continue
    if (slots.length < CHANGED_DEPENDENCY_LIMIT) slots.push(index)
    else omitted += 1
  }
  return { slots, omitted, unscanned: Math.max(0, length - scanned) }
}
