import { describe, expect, it } from 'vitest'
import { commitWorkExhaustions, consumeCommitWork, createCommitWorkBudget } from './commit-budget'

describe('commit work budget', () => {
  it('shares one operation limit across subsystems and names the exhausted work', () => {
    const budget = createCommitWorkBudget({
      operationLimit: 2,
      timeLimitMs: 100,
      now: () => 0,
    })

    expect(consumeCommitWork(budget, 'props')).toBe(true)
    expect(consumeCommitWork(budget, 'effects')).toBe(true)
    expect(consumeCommitWork(budget, 'context')).toBe(false)
    expect(commitWorkExhaustions(budget)).toEqual(['context'])
  })

  it('stops new work after the shared deadline', () => {
    let now = 0
    const budget = createCommitWorkBudget({
      operationLimit: 100,
      timeLimitMs: 5,
      now: () => now,
    })
    now = 5

    expect(consumeCommitWork(budget, 'identity')).toBe(false)
    expect(commitWorkExhaustions(budget)).toEqual(['identity'])
  })
})
