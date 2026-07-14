import { describe, expect, it } from 'vitest'
import type { RenderCause } from './render-causes'
import { hasExactAppExternalStoreCallsite, withReportEvidence } from './render-evidence'
import type { ExternalStoreSourceResolution, ResolvedSource } from './source'

const source = (file: string, line: number): ResolvedSource => ({
  file,
  line,
  column: 0,
  functionName: null,
})

const externalCause = (externalStoreIndex: number): RenderCause => ({
  kind: 'external-store',
  evidence: 'inferred',
  reason: 'external-store-snapshot-changed',
  storeId: `external-store:${externalStoreIndex}`,
  storeLabel: 'test-store',
  selector: null,
  equality: 'object-is',
  fanout: null,
  notificationId: null,
  competingCandidates: ['external-store-snapshot-identity-changed'],
  hookIndex: externalStoreIndex,
  externalStoreIndex,
  subscriberId: `subscriber:${externalStoreIndex}`,
  selectionEqual: false,
  before: false,
  after: true,
  changedFields: ['$value'],
  deepDiff: {
    changes: [{ kind: 'value', path: '', before: false, after: true }],
    visited: 1,
    truncated: false,
  },
})

describe('render report evidence', () => {
  it('maps the nth external-store cause only when hook counts align exactly', () => {
    const resolution: ExternalStoreSourceResolution = {
      status: 'resolved',
      hooks: [
        {
          callsite: source('/src/use-first.ts', 10),
          primitiveSource: source('/node_modules/react/index.js', 100),
          hookAncestry: [{ name: 'FirstStore', source: source('/src/use-first.ts', 10) }],
        },
        {
          callsite: source('/src/use-second.ts', 20),
          primitiveSource: source('/node_modules/react/index.js', 100),
          hookAncestry: [{ name: 'SecondStore', source: source('/src/use-second.ts', 20) }],
        },
      ],
    }

    expect(withReportEvidence([externalCause(1)], null, resolution, 2)[0]).toMatchObject({
      hookProvenance: {
        status: 'exact',
        evidence: 'exact',
        callsite: { file: '/src/use-second.ts', line: 20 },
        hookAncestry: [{ name: 'SecondStore' }],
      },
    })
  })

  it('returns unknown evidence instead of assigning a plausible wrapper on count mismatch', () => {
    const resolution: ExternalStoreSourceResolution = {
      status: 'resolved',
      hooks: [
        {
          callsite: source('/src/use-only.ts', 10),
          primitiveSource: null,
          hookAncestry: [],
        },
      ],
    }
    expect(withReportEvidence([externalCause(0)], null, resolution, 2)[0]).toMatchObject({
      hookProvenance: {
        status: 'unavailable',
        evidence: 'unknown',
        reason: 'hook-count-mismatch',
      },
    })
  })

  it('does not call aligned but source-less hook evidence exact', () => {
    const resolution: ExternalStoreSourceResolution = {
      status: 'resolved',
      hooks: [{ callsite: null, primitiveSource: null, hookAncestry: [] }],
    }

    expect(withReportEvidence([externalCause(0)], null, resolution, 1)[0]).toMatchObject({
      hookProvenance: {
        status: 'unavailable',
        evidence: 'unknown',
        reason: 'hook-source-unresolved',
      },
    })
  })

  it.each([
    'shadow-render-disabled',
    'inspection-truncated',
  ] as const)('preserves the explicit %s reason in agent-facing provenance', (status) => {
    expect(
      withReportEvidence([externalCause(0)], null, { status, hooks: null }, 1)[0],
    ).toMatchObject({
      hookProvenance: {
        status: 'unavailable',
        evidence: 'unknown',
        reason: status,
      },
    })
  })

  it('uses only count-aligned app hook evidence for appOnly ownership', () => {
    const resolution: ExternalStoreSourceResolution = {
      status: 'resolved',
      hooks: [
        {
          callsite: source('/src/use-dashboard.ts', 10),
          primitiveSource: source('/node_modules/react/index.js', 100),
          hookAncestry: [],
        },
      ],
    }

    expect(hasExactAppExternalStoreCallsite(resolution, 1)).toBe(true)
    expect(hasExactAppExternalStoreCallsite(resolution, 2)).toBe(false)
    expect(
      hasExactAppExternalStoreCallsite(
        {
          status: 'resolved',
          hooks: [
            {
              callsite: source('/node_modules/store/index.js', 10),
              primitiveSource: null,
              hookAncestry: [],
            },
          ],
        },
        1,
      ),
    ).toBe(false)
  })

  it('labels the component usage source as a producer candidate, never an allocation site', () => {
    const propCause: RenderCause = {
      kind: 'props',
      evidence: 'exact',
      name: 'style',
      referenceChanged: true,
      referenceOnly: true,
      unstable: true,
      beforePresent: true,
      afterPresent: true,
      before: { padding: 4 },
      after: { padding: 4 },
      deepDiff: {
        changes: [{ kind: 'reference-only', path: '' }],
        visited: 2,
        truncated: false,
      },
    }
    expect(
      withReportEvidence([propCause], source('/src/App.tsx', 42), undefined, 0)[0],
    ).toMatchObject({
      producerCandidate: {
        source: { file: '/src/App.tsx', line: 42 },
        evidence: 'inferred',
        reason: 'component-jsx-usage-or-definition-fallback',
      },
    })
  })

  it('does not suggest a producer for a meaningful object value change', () => {
    const propCause: RenderCause = {
      kind: 'props',
      evidence: 'exact',
      name: 'config',
      referenceChanged: true,
      referenceOnly: false,
      unstable: true,
      beforePresent: true,
      afterPresent: true,
      before: { retries: 1 },
      after: { retries: 2 },
      deepDiff: {
        changes: [{ kind: 'value', path: '/retries', before: 1, after: 2 }],
        visited: 2,
        truncated: false,
      },
    }

    expect(
      withReportEvidence([propCause], source('/src/App.tsx', 42), undefined, 0)[0],
    ).not.toHaveProperty('producerCandidate')
  })
})
