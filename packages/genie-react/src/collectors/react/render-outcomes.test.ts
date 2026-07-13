import type { Fiber } from 'bippy'
import { describe, expect, it } from 'vitest'
import { assessRender, inputComparisonComplete, scanSubtreeHostMutations } from './render-outcomes'

const asFiber = (value: Record<string, unknown>): Fiber =>
  ({
    tag: 0,
    flags: 0,
    subtreeFlags: 0,
    memoizedState: null,
    dependencies: null,
    alternate: null,
    child: null,
    sibling: null,
    return: null,
    ...value,
  }) as unknown as Fiber

const commitEvidence = (hostMutationFibers: Fiber[] = []) => ({
  renderedFibers: new Set<Fiber>(),
  hostMutationFibers: new Set(hostMutationFibers),
  hostMutationCaptureComplete: true,
})

describe('render outcome evidence', () => {
  it('scans only descendants and never attributes the component sibling', () => {
    const siblingHost = asFiber({ tag: 5, flags: 0b100 })
    const descendantHost = asFiber({ tag: 5, flags: 0b100, sibling: null })
    const child = asFiber({ child: descendantHost, sibling: siblingHost })
    const component = asFiber({ child })

    // A sibling of a descendant is still inside the component. A sibling of the component is not.
    component.sibling = asFiber({ tag: 5, flags: 0b100 })
    expect(
      scanSubtreeHostMutations(
        component,
        500,
        undefined,
        commitEvidence([siblingHost, descendantHost]),
      ),
    ).toMatchObject({ count: 2, complete: true })
  })

  it('marks a bounded host scan incomplete instead of claiming no behavior', () => {
    const second = asFiber({ tag: 5, flags: 0b100 })
    const first = asFiber({ tag: 5, flags: 0, sibling: second })
    const result = scanSubtreeHostMutations(
      asFiber({ child: first }),
      1,
      undefined,
      commitEvidence([second]),
    )
    expect(result).toEqual({ count: 0, pendingSubtrees: 1, complete: false })
  })

  it('does not reuse a host mutation observed in an earlier commit', () => {
    const host = asFiber({ tag: 5, flags: 0b100 })
    const component = asFiber({ child: host })

    expect(scanSubtreeHostMutations(component, 500, undefined, commitEvidence([host])).count).toBe(
      1,
    )
    expect(scanSubtreeHostMutations(component, 500, undefined, commitEvidence())).toEqual({
      count: 0,
      pendingSubtrees: 0,
      complete: true,
    })
  })

  it('never reports none-observed for a direct HostText mutation', () => {
    const text = asFiber({ tag: 6, flags: 0b100 })
    const component = asFiber({ child: text, alternate: asFiber({}) })

    expect(
      assessRender(component, 'update', [], 0, true, undefined, true, commitEvidence()),
    ).toMatchObject({
      behaviorEvidence: {
        subtreeHostMutations: { status: 'observed', count: 1 },
      },
    })
  })

  it('treats mismatched context identity as incomplete input evidence', () => {
    const currentContext = { displayName: 'Current' }
    const previousContext = { displayName: 'Previous' }
    const fiber = asFiber({
      dependencies: { firstContext: { context: currentContext, next: null } },
      alternate: asFiber({
        dependencies: { firstContext: { context: previousContext, next: null } },
      }),
    })
    expect(inputComparisonComplete(fiber)).toBe(false)
    expect(assessRender(fiber, 'update', [], 0).inputEvidence).toBe('incomplete')
  })

  it('never says an update is safe to remove when no input or host mutation was observed', () => {
    const fiber = asFiber({ alternate: asFiber({}) })
    const assessment = assessRender(fiber, 'update', [], 0)
    expect(assessment.inputEvidence).toBe('none-observed')
    expect(assessment.optimizationSafety).toBe('not-proven-safe')
    expect(assessment.requiredValidation).toContain('focus')
    expect(assessment.behaviorEvidence.unobservedDomains).toContain('transition')
  })

  it('retains exact scheduled-effect evidence without claiming execution', () => {
    const fiber = asFiber({ alternate: asFiber({}) })
    const assessment = assessRender(fiber, 'update', [], 2)
    expect(assessment.behaviorEvidence.scheduledEffects).toEqual({
      status: 'observed',
      count: 2,
    })
    expect(assessment.behaviorEvidence.unobservedDomains).toContain('effect-execution')
  })
})
