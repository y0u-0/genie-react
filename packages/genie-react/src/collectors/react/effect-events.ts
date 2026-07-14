import type { Fiber, RenderPhase } from 'bippy'
import {
  type EffectConsequenceSignal,
  runInEffectContext,
  setEffectConsequenceListener,
} from '../causal/effect-consequence'
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
  execution:
    | {
        status: 'observed'
        evidence: 'exact'
        startedAt: number
        completedAt: number
        durationMs: number
        outcome: 'completed' | 'threw'
        error?: string
      }
    | {
        status: 'unobserved'
        reason: 'not-yet-observed' | 'unsupported-effect-kind' | 'instrumentation-unavailable'
      }
  cleanupExecution:
    | {
        status: 'observed'
        evidence: 'exact'
        startedAt: number
        completedAt: number
        durationMs: number
        outcome: 'completed' | 'threw'
        error?: string
      }
    | {
        status: 'unobserved'
        reason: 'not-yet-observed' | 'no-cleanup-returned' | 'instrumentation-unavailable'
      }
  consequences: {
    status: 'instrumented'
    observedDomains: ['query-notification', 'router-notification', 'react-commit']
    unobservedDomains: [
      'state-update',
      'external-store-write',
      'network',
      'event-listener',
      'navigation',
    ]
    events: Array<
      | {
          kind: 'notification'
          domain: 'query-notification' | 'router-notification'
          notificationId: string
          timestamp: number
          evidence: 'exact'
        }
      | {
          kind: 'resulting-commit'
          documentCommitId: number
          timestamp: number
          evidence: 'inferred'
          reason: 'next-commit-after-effect-execution'
        }
    >
  }
  timeline: Array<{
    stage: 'schedule' | 'execution' | 'cleanup' | 'consequence' | 'resulting-commit'
    timestamp: number
    evidence: 'exact' | 'inferred'
    referenceId?: string
    outcome?: 'completed' | 'threw'
  }>
}

const EFFECT_EVENT_LIMIT = 1_000
const DEPENDENCY_SCAN_LIMIT = 200
const CHANGED_DEPENDENCY_LIMIT = 50
const events: EffectScheduleEvent[] = []
let droppedEvents = 0
const pendingResultingCommit = new Set<string>()

export function clearEffectEvents(): void {
  events.length = 0
  droppedEvents = 0
  pendingResultingCommit.clear()
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
    execution: {
      status: 'unobserved',
      reason: prepared.kind === 'effect' ? 'not-yet-observed' : 'unsupported-effect-kind',
    },
    cleanupExecution: { status: 'unobserved', reason: 'not-yet-observed' },
    consequences: {
      status: 'instrumented',
      observedDomains: ['query-notification', 'router-notification', 'react-commit'],
      unobservedDomains: [
        'state-update',
        'external-store-write',
        'network',
        'event-listener',
        'navigation',
      ],
      events: [],
    },
    timeline: [
      {
        stage: 'schedule',
        timestamp: Date.now(),
        evidence: 'exact',
        referenceId: prepared.effectEventId,
      },
    ],
  }
  events.push(event)
  if (events.length > EFFECT_EVENT_LIMIT) {
    events.shift()
    droppedEvents += 1
  }
}

export function runObservedEffectCreate<T>(effectEventId: string, create: () => T): T {
  const event = eventFor(effectEventId)
  if (!event) return create()
  const startedAt = now()
  const timelineEntry = beginTimelineStage(event, 'execution')
  try {
    const result = runInEffectContext(effectEventId, create)
    completeExecution(event, timelineEntry, startedAt, 'completed')
    pendingResultingCommit.add(effectEventId)
    return result
  } catch (error) {
    completeExecution(event, timelineEntry, startedAt, 'threw', error)
    pendingResultingCommit.add(effectEventId)
    throw error
  }
}

export function runObservedEffectCleanup<T>(effectEventId: string, cleanup: () => T): T {
  const event = eventFor(effectEventId)
  if (!event) return cleanup()
  const startedAt = now()
  const timelineEntry = beginTimelineStage(event, 'cleanup')
  try {
    const result = runInEffectContext(effectEventId, cleanup)
    completeCleanup(event, timelineEntry, startedAt, 'completed')
    pendingResultingCommit.add(effectEventId)
    return result
  } catch (error) {
    completeCleanup(event, timelineEntry, startedAt, 'threw', error)
    pendingResultingCommit.add(effectEventId)
    throw error
  }
}

export function markEffectWithoutCleanup(effectEventId: string): void {
  const event = eventFor(effectEventId)
  if (event && event.cleanupExecution.status === 'unobserved') {
    event.cleanupExecution = {
      status: 'unobserved',
      reason: 'no-cleanup-returned',
    }
  }
}

export function markEffectInstrumentationUnavailable(effectEventId: string): void {
  const event = eventFor(effectEventId)
  if (!event || event.execution.status === 'observed') return
  event.execution = {
    status: 'unobserved',
    reason: 'instrumentation-unavailable',
  }
  event.cleanupExecution = {
    status: 'unobserved',
    reason: 'instrumentation-unavailable',
  }
}

export function recordResultingEffectCommit(documentCommitId: number): void {
  if (pendingResultingCommit.size === 0) return
  const timestamp = Date.now()
  for (const effectEventId of pendingResultingCommit) {
    const event = eventFor(effectEventId)
    if (!event) continue
    event.consequences.events.push({
      kind: 'resulting-commit',
      documentCommitId,
      timestamp,
      evidence: 'inferred',
      reason: 'next-commit-after-effect-execution',
    })
    event.timeline.push({
      stage: 'resulting-commit',
      timestamp,
      evidence: 'inferred',
    })
  }
  pendingResultingCommit.clear()
}

function completeExecution(
  event: EffectScheduleEvent,
  timelineEntry: EffectScheduleEvent['timeline'][number],
  startedAt: number,
  outcome: 'completed' | 'threw',
  error?: unknown,
): void {
  const completedAt = now()
  event.execution = {
    status: 'observed',
    evidence: 'exact',
    startedAt,
    completedAt,
    durationMs: round3(completedAt - startedAt),
    outcome,
    ...(error === undefined ? {} : { error: errorMessage(error) }),
  }
  timelineEntry.outcome = outcome
}

function completeCleanup(
  event: EffectScheduleEvent,
  timelineEntry: EffectScheduleEvent['timeline'][number],
  startedAt: number,
  outcome: 'completed' | 'threw',
  error?: unknown,
): void {
  const completedAt = now()
  event.cleanupExecution = {
    status: 'observed',
    evidence: 'exact',
    startedAt,
    completedAt,
    durationMs: round3(completedAt - startedAt),
    outcome,
    ...(error === undefined ? {} : { error: errorMessage(error) }),
  }
  timelineEntry.outcome = outcome
}

function beginTimelineStage(
  event: EffectScheduleEvent,
  stage: 'execution' | 'cleanup',
): EffectScheduleEvent['timeline'][number] {
  const entry: EffectScheduleEvent['timeline'][number] = {
    stage,
    timestamp: Date.now(),
    evidence: 'exact',
  }
  event.timeline.push(entry)
  return entry
}

function recordConsequence(signal: EffectConsequenceSignal): void {
  const event = eventFor(signal.effectEventId)
  if (!event) return
  event.consequences.events.push({
    kind: 'notification',
    domain: signal.domain,
    notificationId: signal.notificationId,
    timestamp: signal.timestamp,
    evidence: 'exact',
  })
  event.timeline.push({
    stage: 'consequence',
    timestamp: signal.timestamp,
    evidence: 'exact',
    referenceId: signal.notificationId,
  })
}

setEffectConsequenceListener(recordConsequence)

function eventFor(effectEventId: string): EffectScheduleEvent | undefined {
  return events.find((event) => event.effectEventId === effectEventId)
}

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now()
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 500)
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
