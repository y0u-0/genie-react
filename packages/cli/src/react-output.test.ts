import { describe, expect, it } from 'vitest'
import {
  summarizeComponentCohort,
  summarizeEffectEvents,
  summarizeEffects,
  summarizeRenderCauses,
  summarizeRenders,
} from './react-output'

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
              evidence: 'inferred',
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
          causes: [{ kind: 'parent', evidence: 'inferred', parentName: 'Shell', parentId: 2 }],
          source: null,
        },
      ],
    })

    expect(output).toContain('2 causal render events · 12 commits')
    expect(output).toContain(
      'commit 12 · ReviewCard #7 · necessary · ↻ query ["row",7] changed data,isFetching (inferred) (ReviewCard.tsx:42)',
    )
    expect(output).toContain('Child #8 · unknown · ↻ parent Shell #2 (inferred)')
    expect(summarizeRenderCauses({ nope: true })).toBeNull()
  })

  it('surfaces exact Query identity, deep paths, and the app hook callsite', () => {
    const output = summarizeRenderCauses({
      commits: 1,
      events: [
        {
          commitId: 1,
          componentId: 4,
          componentName: 'App',
          assessment: { inputEvidence: 'changed' },
          causes: [
            {
              kind: 'query',
              evidence: 'exact',
              queryHash: '["greeting"]',
              changedFields: ['data', 'dataUpdatedAt'],
              deepDiff: {
                changes: [
                  { kind: 'value', path: '/data/message' },
                  { kind: 'value', path: '/data/at' },
                  { kind: 'value', path: '/dataUpdatedAt' },
                  { kind: 'value', path: '/isStale' },
                ],
              },
              observerId: 'query-observer:1',
              subscriberId: 'subscriber:mount:2:0',
              hookProvenance: {
                status: 'exact',
                callsite: { file: '/src/App.tsx', line: 137 },
              },
            },
          ],
        },
      ],
    })

    expect(output).toContain(
      'query ["greeting"] changed data,dataUpdatedAt paths /data/message,/data/at,/dataUpdatedAt,+1 · observer query-observer:1 · subscriber subscriber:mount:2:0 · hook App.tsx:137 (exact)',
    )
  })

  it('keeps unavailable hook-source reasons in compact causal output', () => {
    const output = summarizeRenderCauses({
      commits: 1,
      events: [
        {
          commitId: 1,
          componentId: 3,
          componentName: 'Dashboard',
          assessment: { inputEvidence: 'changed', optimizationSafety: 'not-proven-safe' },
          causes: [
            {
              kind: 'query',
              evidence: 'exact',
              queryHash: '["dashboard"]',
              hookProvenance: {
                status: 'unavailable',
                evidence: 'unknown',
                reason: 'shadow-render-disabled',
              },
            },
          ],
        },
      ],
    })

    expect(output).toContain(
      'query ["dashboard"] · hook source unknown (shadow-render-disabled) (exact)',
    )
  })

  it('discloses incomplete deep-path evidence next to the affected paths', () => {
    const output = summarizeRenders({
      summary: { commits: 1, trackedComponents: 1, totalRenders: 1 },
      components: [
        {
          id: 1,
          name: 'Card',
          renders: 1,
          mounts: 0,
          updates: 1,
          selfTime: 0,
          causes: [
            {
              kind: 'props',
              name: 'data',
              referenceChanged: true,
              referenceOnly: false,
              deepDiff: {
                changes: [{ kind: 'reference-only', path: '' }],
                truncated: true,
              },
              evidence: 'exact',
            },
          ],
          changes: [],
        },
      ],
    })

    expect(output).toContain('paths <root> (incomplete) (exact)')
  })

  it('bounds a Query hash so one cause cannot flood agent context', () => {
    const queryHash = `["${'x'.repeat(300)}"]`
    const output = summarizeRenderCauses({
      commits: 1,
      events: [
        {
          commitId: 1,
          componentId: 4,
          componentName: 'App',
          causes: [{ kind: 'query', evidence: 'exact', queryHash }],
        },
      ],
    })

    expect(output).toContain(`query ${queryHash.slice(0, 120)}… (exact)`)
    expect(output).not.toContain(queryHash)
  })

  it('discloses when the render-event limit omits matching events', () => {
    const output = summarizeRenderCauses({
      commits: 3,
      omittedByLimit: 7,
      attribution: {
        status: 'stale',
        startedAtDocumentCommitId: 10,
        completedAtDocumentCommitId: 11,
      },
      renderEventRetention: { evictedEvents: 2 },
      events: [],
      coverage: {
        complete: false,
        skippedCommitFibers: 2,
        droppedUnmountFibers: 1,
        budgetExhaustedCommits: 1,
        budgetExhaustedSubsystems: [{ subsystem: 'deep-diff', commits: 1 }],
      },
    })

    expect(output).toBe(
      '0 causal render events · 3 commits · 7 omitted · attribution stale (10→11; retry when commits settle) · 2 render events evicted (clear, repeat, and read sooner) · coverage incomplete (2 commit fibers skipped; 1 component unmounts dropped; 1 commit budgets exhausted in deep-diff)',
    )
  })

  it('shows analysis-generation staleness when the document commit did not change', () => {
    const output = summarizeRenderCauses({
      commits: 3,
      events: [],
      attribution: {
        status: 'stale',
        startedAtDocumentCommitId: 10,
        completedAtDocumentCommitId: 10,
        startedAtAnalysisGeneration: 4,
        completedAtAnalysisGeneration: 5,
      },
    })

    expect(output).toBe(
      '0 causal render events · 3 commits · attribution stale (analysis generation 4→5; retry when commits settle)',
    )
  })

  it('uses assessment evidence without presenting an optimization verdict', () => {
    const output = summarizeRenderCauses({
      commits: 2,
      events: [
        {
          commitId: 2,
          componentId: 7,
          componentName: 'ReviewCard',
          necessity: 'unnecessary',
          assessment: {
            inputEvidence: 'none-observed',
            optimizationSafety: 'not-proven-safe',
          },
          causes: [{ kind: 'unknown', evidence: 'unknown' }],
        },
        {
          commitId: 2,
          componentId: 8,
          componentName: 'StateCard',
          necessity: 'necessary',
          assessment: {
            inputEvidence: 'changed',
            optimizationSafety: 'not-proven-safe',
          },
          causes: [{ kind: 'state', name: 'state[0]', before: 1, after: 2 }],
        },
      ],
    })

    expect(output).toContain(
      'ReviewCard #7 · input: no observed input change · not proven safe · ↻ unknown cause (unknown)',
    )
    expect(output).toContain('StateCard #8 · input: changed · ↻ state[0] 1→2')
    expect(output).not.toMatch(/\b(?:necessary|unnecessary)\b/)
  })

  it('labels observed render evidence and compiler runtime evidence conservatively', () => {
    const output = summarizeRenders({
      summary: {
        commits: 2,
        trackedComponents: 1,
        totalRenders: 2,
        totalUpdates: 2,
        unstableComponents: 0,
        unnecessaryComponents: 1,
        noObservedInputChangeComponents: 1,
      },
      components: [
        {
          id: 7,
          name: 'ReviewCard',
          renders: 2,
          mounts: 0,
          updates: 2,
          unnecessary: 1,
          noObservedInputChange: 1,
          unstableRenders: 0,
          forget: true,
          compiler: { memoCacheObserved: true },
          selfTime: 0.4,
          causes: [],
          changes: [],
          assessment: {
            inputEvidence: 'none-observed',
            optimizationSafety: 'not-proven-safe',
          },
        },
      ],
    })

    expect(output).toContain('1 no observed input change')
    expect(output).toContain('· memo cache')
    expect(output).toContain('· input: no observed input change · not proven safe')
    expect(output).not.toMatch(/\b(?:unnecessary|unnec|forget)\b/)
  })

  it('discloses when the render component limit omits records', () => {
    const output = summarizeRenders({
      summary: {
        commits: 1,
        trackedComponents: 3,
        totalRenders: 3,
        totalUpdates: 3,
        unstableComponents: 0,
        noObservedInputChangeComponents: 0,
      },
      components: [
        {
          id: 1,
          name: 'OnlyShown',
          renders: 1,
          mounts: 0,
          updates: 1,
          noObservedInputChange: 0,
          unstableRenders: 0,
          selfTime: 0,
          causes: [],
          changes: [],
        },
      ],
      omittedByLimit: 2,
    })

    expect(output?.split('\n')[0]).toContain('3 components · 3 renders')
    expect(output?.split('\n')[0]).toContain('2 omitted')
  })

  it('explains intentional opaque props without suggesting a retry', () => {
    const output = summarizeRenders({
      summary: { commits: 1, trackedComponents: 1, totalRenders: 1, totalUpdates: 1 },
      components: [],
      coverage: {
        complete: false,
        inputAttributionComplete: false,
        propsNotEnumeratedFibers: 1,
      },
    })

    expect(output).toContain(
      '1 prop container not enumerated; inspect an explicit component prop or path',
    )
    expect(output).not.toContain('retry')
  })

  it('summarizes a component lifecycle cohort with stable instance identity', () => {
    const output = summarizeComponentCohort({
      observation: { id: 'observation:1' },
      query: { component: 'Row', exact: true },
      status: 'mixed',
      matched: 3,
      mountedUpdated: 1,
      mountedIdle: 1,
      mountedUnknown: 0,
      unmounted: 1,
      returned: 2,
      omittedByLimit: 1,
      instances: [
        {
          componentName: 'Row',
          status: 'mounted-updated',
          instance: {
            mountId: 'mount:2',
            key: 'active',
            siblingIndex: 1,
            logicalPath: 'List[key=active] > Row[key=active]',
            logicalIdentityEvidence: 'keyed',
            mountGeneration: 1,
          },
        },
        {
          componentName: 'Row',
          status: 'unmounted',
          instance: {
            mountId: 'mount:3',
            key: null,
            siblingIndex: 2,
            logicalPath: 'List[index=0] > Row[index=2]',
            logicalIdentityEvidence: 'positional',
            mountGeneration: 2,
          },
        },
      ],
      coverage: {
        complete: false,
        scanTruncated: false,
        rootAvailable: true,
        skippedCommitFibers: 4,
        droppedUnmountFibers: 1,
        generationHistoryEvictions: 0,
      },
    })

    expect(output?.split('\n')).toEqual([
      '"Row" · mixed · 3 matched · 1 updated · 1 mounted idle · 0 mounted unknown · 1 unmounted · 1 omitted · coverage incomplete (4 commit fibers skipped; 1 component unmounts dropped)',
      '  updated · Row key="active" · mount mount:2 · generation 1 · keyed · List[key=active] > Row[key=active]',
      '  unmounted · Row index=2 · mount mount:3 · generation 2 · positional · List[index=0] > Row[index=2]',
    ])
  })

  it('makes cohort not-started and malformed states explicit', () => {
    expect(
      summarizeComponentCohort({
        observation: null,
        query: { component: 'Row', exact: true },
        status: 'not-started',
        matched: 0,
        mountedUpdated: 0,
        mountedIdle: 0,
        mountedUnknown: 0,
        unmounted: 0,
        returned: 0,
        omittedByLimit: 0,
        instances: [],
        coverage: { complete: true },
      }),
    ).toBe('"Row" · measurement not started · run react_clear_renders')
    expect(summarizeComponentCohort({ status: 'absent' })).toBeNull()
  })

  it('summarizes effect schedules without implying execution or consequences', () => {
    const output = summarizeEffectEvents({
      tracking: true,
      documentCommitId: 14,
      observation: { id: 'observation:2' },
      droppedEvents: 1,
      events: [
        {
          effectEventId: 'effect-event:1',
          effectId: 'effect:mount:7:1',
          commitId: 4,
          documentCommitId: 13,
          componentId: 7,
          componentName: 'Search',
          mountId: 'mount:7',
          effectIndex: 1,
          kind: 'effect',
          phase: 'update',
          event: 'scheduled',
          evidence: 'exact',
          changedDependencySlots: [0, 2],
          execution: { status: 'unobserved' },
          cleanupExecution: { status: 'unobserved' },
          consequences: { status: 'not-instrumented', events: [] },
        },
      ],
    })

    expect(output?.split('\n')).toEqual([
      '1 effect schedule · document commit 14 · window observation:2 · 1 event evicted from retained history (call react_clear_renders, repeat the interaction, then read sooner)',
      '  document commit 13 · commit 4 · Search #7 [1] effect · update scheduled · deps 0,2 changed · execution unobserved · cleanup unobserved · consequences not instrumented',
    ])
    expect(output).not.toContain('fired')
    expect(summarizeEffectEvents({ events: 'nope' })).toBeNull()
  })

  it('prefers schedule fields and makes every incomplete effect coverage counter actionable', () => {
    const output = summarizeEffects({
      commits: 8,
      hotnessCriteria: {
        minUpdates: 3,
        minScheduleRate: 0.75,
        minFireRate: 0.1,
      },
      omittedByLimit: 2,
      effectsOmittedByLimit: 3,
      coverage: {
        complete: false,
        skippedCommitFibers: 1,
        droppedUnmountFibers: 2,
        analysisFailedFibers: 3,
        truncatedInputFibers: 4,
        truncatedEffectLists: 5,
        budgetExhaustedCommits: 6,
        budgetExhaustedSubsystems: [{ subsystem: 'effect-list', commits: 6 }],
      },
      components: [
        {
          id: 7,
          name: 'Search',
          effectsOmitted: 3,
          effects: [
            {
              index: 0,
              kind: 'effect',
              depsMode: 'list',
              depCount: 1,
              scheduled: 3,
              fired: 99,
              updates: 4,
              schedulesEveryUpdate: false,
              firesEveryUpdate: true,
              hasCleanup: false,
            },
          ],
        },
      ],
    })

    expect(output?.split('\n')).toEqual([
      '8 commits · 1 component with effects · hot ≥3 updates @ 75% · 2 omitted by limit (retry with a higher limit, max 200, or narrow component) · 3 effect findings omitted by report cap (narrow component) · coverage incomplete (1 skipped commit fiber; 2 dropped unmount fibers; 3 failed fiber analyses; 4 truncated input scans; 5 truncated effect lists; 6 exhausted commit budgets; budget stopped effect-list) · action: call react_clear_renders, repeat the interaction, then rerun with a narrower component filter',
      '  Search #7 [0] effect deps=list(1) scheduled 3/4 no cleanup function observed',
      '  Search #7 · 3 effect findings omitted by report cap',
    ])
    expect(output).not.toContain('99')
    expect(output).not.toContain('EVERY')
  })

  it('separates query-limit omissions from retained-history eviction and reports dependency scan gaps', () => {
    const output = summarizeEffectEvents({
      tracking: true,
      documentCommitId: 20,
      observation: null,
      omittedByLimit: 4,
      evictedEvents: 2,
      droppedEvents: 99,
      coverage: { complete: true },
      events: [
        {
          documentCommitId: 19,
          commitId: 6,
          componentName: 'Search',
          componentId: 7,
          effectIndex: 0,
          kind: 'effect',
          phase: 'update',
          changedDependencySlots: [0, 2],
          changedDependencySlotsOmitted: 3,
          dependencySlotsUnscanned: 4,
          execution: { status: 'unobserved' },
          cleanupExecution: { status: 'unobserved' },
          consequences: { status: 'not-instrumented' },
        },
      ],
    })

    expect(output?.split('\n')).toEqual([
      '1 effect schedule · document commit 20 · 4 events omitted by limit (retry with a higher limit, max 500, or narrow component) · 2 events evicted from retained history (call react_clear_renders, repeat the interaction, then read sooner)',
      '  document commit 19 · commit 6 · Search #7 [0] effect · update scheduled · deps 0,2 changed · 3 dependency slots with changes omitted · 4 dependency slots unscanned · execution unobserved · cleanup unobserved · consequences not instrumented',
    ])
    expect(output).not.toContain('99')
  })
})
