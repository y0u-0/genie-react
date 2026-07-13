import { describe, expect, it } from 'vitest'
import { summarizeRenderCauses } from './react-output'

describe('react output', () => {
  it('summarizes commit-scoped Query and parent causes', () => {
    const output = summarizeRenderCauses({
      commits: 12,
      events: [
        {
          commitId: 12,
          componentId: 7,
          componentName: 'ReviewCard',
          necessity: 'necessary',
          causes: [
            {
              kind: 'query',
              queryHash: '["row",7]',
              changedFields: ['data', 'isFetching'],
            },
          ],
          source: { file: 'src/ReviewCard.tsx', line: 42 },
        },
        {
          commitId: 12,
          componentId: 8,
          componentName: 'Child',
          necessity: 'unknown',
          causes: [{ kind: 'parent', parentName: 'Shell', parentId: 2 }],
          source: null,
        },
      ],
    })

    expect(output).toContain('2 causal render events · 12 commits')
    expect(output).toContain(
      'commit 12 · ReviewCard #7 · necessary · ↻ query ["row",7] changed data,isFetching (ReviewCard.tsx:42)',
    )
    expect(output).toContain('Child #8 · unknown · ↻ parent Shell #2')
    expect(summarizeRenderCauses({ nope: true })).toBeNull()
  })
})
