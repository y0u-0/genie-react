import type { Fiber } from 'bippy'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  recordQueryNotification,
  resetExternalStoreRegistryForTests,
} from '../causal/external-store-registry'
import {
  changedDependencySlots,
  clearEffectEvents,
  getEffectScheduleEvents,
  recordEffectSchedule,
  recordResultingEffectCommit,
  runObservedEffectCleanup,
  runObservedEffectCreate,
} from './effect-events'
import { clearInstanceIdentityForTests } from './instance-identity'
import { beginObservation, resetObservationStateForTests } from './observation'

const fiber = (): Fiber => {
  const type = (): null => null
  Object.assign(type, { displayName: 'SearchEffect' })
  return {
    tag: 0,
    type,
    key: null,
    child: null,
    sibling: null,
    return: null,
    alternate: null,
  } as Fiber
}

beforeEach(() => {
  clearEffectEvents()
  resetExternalStoreRegistryForTests()
  clearInstanceIdentityForTests()
  resetObservationStateForTests()
})

describe('effect schedule events', () => {
  it('shares the observation/commit/mount identity without claiming stages before observation', () => {
    beginObservation()
    const component = fiber()
    recordEffectSchedule({
      fiber: component,
      profileCommitId: 3,
      phase: 'update',
      effectIndex: 1,
      kind: 'effect',
      dependencies: ['app', 2],
      previousDependencies: ['a', 2],
    })
    const [event] = getEffectScheduleEvents({ limit: 10 }).events
    expect(event).toMatchObject({
      observationId: 'observation:1',
      commitId: 3,
      componentName: 'SearchEffect',
      effectIndex: 1,
      phase: 'update',
      event: 'scheduled',
      changedDependencySlots: [0],
      execution: { status: 'unobserved' },
      cleanupExecution: { status: 'unobserved' },
      consequences: { status: 'instrumented', events: [] },
    })
    expect(event?.effectId).toMatch(/^effect:mount:/)
  })

  it('joins passive execution, cleanup, notifications, and the next commit by causal ID', () => {
    const observer = {}
    recordEffectSchedule({
      fiber: fiber(),
      profileCommitId: 3,
      phase: 'update',
      effectIndex: 0,
      kind: 'effect',
      dependencies: [1],
      previousDependencies: [0],
    })
    const effectEventId = getEffectScheduleEvents({ limit: 10 }).events[0]?.effectEventId
    if (!effectEventId) throw new Error('expected a retained effect event')

    runObservedEffectCreate(effectEventId, () => {
      recordQueryNotification(
        observer,
        { data: null },
        { data: 'ready' },
        {
          trackedFields: ['data'],
          trackedFieldsCoverage: 'exact',
          fanout: 1,
        },
      )
    })
    runObservedEffectCleanup(effectEventId, () => undefined)
    recordResultingEffectCommit(4)

    const event = getEffectScheduleEvents({ limit: 10 }).events[0]
    expect(event).toMatchObject({
      execution: {
        status: 'observed',
        evidence: 'exact',
        outcome: 'completed',
      },
      cleanupExecution: {
        status: 'observed',
        evidence: 'exact',
        outcome: 'completed',
      },
      consequences: {
        status: 'instrumented',
        events: [
          {
            kind: 'notification',
            domain: 'query-notification',
            notificationId: 'query-notification:1',
            evidence: 'exact',
          },
          {
            kind: 'resulting-commit',
            documentCommitId: 4,
            evidence: 'inferred',
          },
        ],
      },
    })
    expect(event?.timeline.map(({ stage }) => stage)).toEqual([
      'schedule',
      'execution',
      'consequence',
      'cleanup',
      'resulting-commit',
    ])
  })

  it('does not invent changed slots for mount or non-list dependencies', () => {
    expect(changedDependencySlots(null, null)).toEqual({
      slots: [],
      omitted: 0,
      unscanned: 0,
    })
    expect(changedDependencySlots([1, 3], [1, 2])).toEqual({
      slots: [1],
      omitted: 0,
      unscanned: 0,
    })
    recordEffectSchedule({
      fiber: fiber(),
      profileCommitId: 1,
      phase: 'mount',
      effectIndex: 0,
      kind: 'layout',
      dependencies: [1],
      previousDependencies: null,
    })
    expect(getEffectScheduleEvents({ limit: 10 }).events[0]?.changedDependencySlots).toEqual([])
  })

  it('separates returned, omitted, and unscanned dependency slots', () => {
    const previous = Array.from({ length: 300 }, () => 0)
    const current = Array.from({ length: 300 }, () => 1)

    expect(changedDependencySlots(current, previous)).toEqual({
      slots: Array.from({ length: 50 }, (_, index) => index),
      omitted: 150,
      unscanned: 100,
    })
  })
})
