import type { Fiber } from 'bippy'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  changedDependencySlots,
  clearEffectEvents,
  getEffectScheduleEvents,
  recordEffectSchedule,
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
  clearInstanceIdentityForTests()
  resetObservationStateForTests()
})

describe('effect schedule events', () => {
  it('shares the observation/commit/mount identity without claiming execution or consequences', () => {
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
      consequences: { status: 'not-instrumented', events: [] },
    })
    expect(event?.effectId).toMatch(/^effect:mount:/)
  })

  it('does not invent changed slots for mount or non-list dependencies', () => {
    expect(changedDependencySlots(null, null)).toEqual({ slots: [], omitted: 0, unscanned: 0 })
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
