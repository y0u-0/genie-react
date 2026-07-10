import { describe, expect, it } from 'vitest'
import { reactGetRendersContract } from './contracts'

describe('react_get_renders output contract', () => {
  it('preserves detailed hook state changes for typed agent clients', () => {
    const result = reactGetRendersContract.output.parse({
      tracking: true,
      commits: 1,
      summary: {
        commits: 1,
        trackedComponents: 1,
        totalRenders: 1,
        totalUpdates: 1,
        unstableComponents: 0,
        unnecessaryComponents: 0,
        topUnstableProps: [],
      },
      components: [
        {
          id: 1,
          name: 'Counter',
          renders: 1,
          mounts: 0,
          updates: 1,
          unnecessary: 0,
          unstableRenders: 0,
          forget: false,
          selfTime: 0.1,
          totalTime: 0.1,
          changes: [
            {
              name: 'state[0]',
              kind: 'state',
              unstable: false,
              hook: { index: 0, stateIndex: 0, kind: 'state' },
              before: 1,
              after: 2,
            },
          ],
          source: null,
          isLibrary: false,
        },
      ],
    })

    expect(result.components[0]?.changes[0]).toEqual({
      name: 'state[0]',
      kind: 'state',
      unstable: false,
      hook: { index: 0, stateIndex: 0, kind: 'state' },
      before: 1,
      after: 2,
    })
  })
})
