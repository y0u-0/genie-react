import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginObservation,
  getActiveObservation,
  getAnalysisGeneration,
  getDocumentCommitId,
  nextCausalEventId,
  noteAnalysisInvalidation,
  noteDocumentCommit,
  resetObservationStateForTests,
} from './observation'

beforeEach(() => resetObservationStateForTests())

describe('React observation identity', () => {
  it('keeps document commit and event identities monotonic across clears', () => {
    const first = beginObservation()
    expect(noteDocumentCommit()).toBe(1)
    const firstEvent = nextCausalEventId('render')

    const second = beginObservation()
    expect(noteDocumentCommit()).toBe(2)
    const secondEvent = nextCausalEventId('render')

    expect(first).toEqual({
      id: 'observation:1',
      epoch: 1,
      startedAfterDocumentCommitId: 0,
    })
    expect(second).toEqual({
      id: 'observation:2',
      epoch: 2,
      startedAfterDocumentCommitId: 1,
    })
    expect(secondEvent).not.toBe(firstEvent)
    expect(getDocumentCommitId()).toBe(2)
    expect(getAnalysisGeneration()).toBe(4)
  })

  it('does not fabricate an observation before an explicit clear or profile start', () => {
    noteDocumentCommit()
    expect(getActiveObservation()).toBeNull()
  })

  it('invalidates async analysis without fabricating a document commit', () => {
    expect(noteAnalysisInvalidation()).toBe(1)
    expect(getDocumentCommitId()).toBe(0)
  })
})
