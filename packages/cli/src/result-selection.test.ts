import { describe, expect, it } from 'vitest'
import { ResultSelectionError, renderBoundedJson, selectResult } from './result-selection'

describe('nested result selection', () => {
  const result = {
    sections: {
      react: {
        components: [
          { name: 'A', renders: 2 },
          { name: 'B', renders: 3 },
        ],
      },
    },
    complete: true,
  }

  it('supports JSON Pointer and dotted wildcard paths with omission accounting', () => {
    expect(selectResult(result, '/sections/react/components/0/name')).toMatchObject({
      selection: {
        matchedPaths: ['/sections/react/components/0/name'],
        matchedPathCount: 1,
        omittedPathCount: 4,
      },
      result: 'A',
    })
    expect(selectResult(result, 'sections.react.components[*].name')).toMatchObject({
      selection: { matchedPathCount: 2, omittedPathCount: 3 },
      result: [
        { path: '/sections/react/components/0/name', value: 'A' },
        { path: '/sections/react/components/1/name', value: 'B' },
      ],
    })
  })

  it('rejects no-match paths with bounded recovery guidance', () => {
    expect(() => selectResult(result, '/missing')).toThrow(ResultSelectionError)
    expect(() => selectResult(result, '/missing')).toThrow('/sections')
  })

  it('replaces oversized output with a bounded machine envelope', () => {
    const output = renderBoundedJson(
      { rows: Array.from({ length: 100 }, () => 'x'.repeat(50)) },
      512,
    )
    expect(Buffer.byteLength(`${output}\n`, 'utf8')).toBeLessThanOrEqual(512)
    expect(JSON.parse(output)).toMatchObject({
      schemaVersion: '1.0',
      status: 'truncated',
      reason: 'max-bytes',
      maxBytes: 512,
    })
  })
})
