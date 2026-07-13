import { describe, expect, it } from 'vitest'
import {
  reactEffectAuditContract,
  reactGetRendersContract,
  reactRenderCausesContract,
} from './contracts'

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
          latestCommitId: 1,
          causes: [
            {
              kind: 'state',
              evidence: 'exact',
              name: 'state[0]',
              hook: { index: 0, stateIndex: 0, kind: 'state' },
              before: 1,
              after: 2,
            },
          ],
          causeCounts: {
            mount: 0,
            props: 0,
            state: 1,
            children: 0,
            context: 0,
            'external-store': 0,
            query: 0,
            router: 0,
            parent: 0,
            unknown: 0,
          },
          necessity: 'necessary',
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

describe('react_effect_audit contract', () => {
  it('applies conservative hotness defaults and validates overrides', () => {
    expect(reactEffectAuditContract.input.parse({})).toMatchObject({
      onlyHot: false,
      appOnly: true,
      minUpdates: 3,
      minFireRate: 1,
      limit: 40,
    })
    expect(() => reactEffectAuditContract.input.parse({ minUpdates: 0 })).toThrow()
    expect(() => reactEffectAuditContract.input.parse({ minFireRate: 1.1 })).toThrow()
    expect(() =>
      reactEffectAuditContract.input.parse({ packageName: '@tanstack/react-query' }),
    ).toThrow('appOnly:false')
    expect(
      reactEffectAuditContract.input.parse({
        packageName: '@tanstack/react-query',
        appOnly: false,
      }),
    ).toMatchObject({ packageName: '@tanstack/react-query', appOnly: false })
  })
})

describe('react_render_causes contract', () => {
  it('applies bounded defaults and makes commit selectors mutually exclusive', () => {
    expect(reactRenderCausesContract.input.parse({})).toEqual({ limit: 100, appOnly: true })
    expect(() => reactRenderCausesContract.input.parse({ commit: 2, afterCommit: 1 })).toThrow(
      'mutually exclusive',
    )
    expect(() => reactRenderCausesContract.input.parse({ limit: 501 })).toThrow()
  })
})
