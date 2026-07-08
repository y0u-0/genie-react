import { type Fiber, SuspenseComponentTag } from 'bippy'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearErrorState,
  getErrorState,
  installErrorCapture,
  parseBoundaryError,
  recordErrorState,
} from './error-tracker'

vi.mock('bippy/source', () => ({
  getSource: async () => null,
  isSourceFile: () => true,
  normalizeFileName: (file: string) => file,
}))

// The forced-boundary source lives in ./overrides; stub it so getErrorState's merge is unit-testable without the DevTools renderer.
const forced = vi.hoisted(() => ({ errors: [] as unknown[], suspense: [] as unknown[] }))
vi.mock('./overrides', () => ({
  forcedErrorBoundaries: () => forced.errors,
  forcedSuspenseBoundaries: () => forced.suspense,
}))

const asFiber = (shape: unknown): Fiber => shape as Fiber
const DID_CAPTURE = 0b1000_0000

const boundaryFiber = (name: string, flags = DID_CAPTURE): Fiber => {
  const type = (): null => null
  Object.assign(type, { displayName: name })
  return asFiber({ flags, type })
}

// React 19.2 dev logs a boundary error as these args.
const reactBoundaryArgs = [
  '%o\n\n%s\n\n%s\n',
  new Error('Boomer exploded on purpose'),
  'The above error occurred in the <Boomer> component.',
  'React will try to recreate this component tree from scratch using the error boundary you provided, ErrorBoundary.',
]

let originalError: typeof console.error
beforeAll(() => {
  originalError = console.error
  console.error = () => {}
  installErrorCapture()
})
afterAll(() => {
  console.error = originalError
})
beforeEach(() => {
  clearErrorState()
  forced.errors = []
  forced.suspense = []
})

describe('parseBoundaryError', () => {
  it('extracts the message, throwing component, and boundary from React 19.2 console.error args', () => {
    const parsed = parseBoundaryError(reactBoundaryArgs)
    expect(parsed?.message).toBe('Boomer exploded on purpose')
    expect(parsed?.throwingComponent).toBe('Boomer')
    expect(parsed?.boundaryName).toBe('ErrorBoundary')
  })

  it('ignores unrelated console.error calls', () => {
    expect(parseBoundaryError(['just a normal log', 42])).toBeNull()
  })

  it('recovers the message from the logged text when React passes no Error instance (React 19.2)', () => {
    const parsed = parseBoundaryError([
      'Error: lab-bomb\n\nThe above error occurred in the <Bomb> component.\nIt was handled by the <LabErrorBoundary> error boundary.',
    ])
    expect(parsed?.message).toBe('lab-bomb')
    expect(parsed?.throwingComponent).toBe('Bomb')
    expect(parsed?.boundaryName).toBe('LabErrorBoundary')
    expect(parsed?.stack).toBeNull()
  })

  it('extracts the boundary from the React 19 "handled by" phrasing', () => {
    const parsed = parseBoundaryError([
      '%o\n\n%s\n\n%s\n',
      new Error('boom from Bomb'),
      'The above error occurred in the <Bomb> component.',
      'It was handled by the <DemoErrorBoundary> error boundary.',
    ])
    expect(parsed?.message).toBe('boom from Bomb')
    expect(parsed?.throwingComponent).toBe('Bomb')
    expect(parsed?.boundaryName).toBe('DemoErrorBoundary')
  })
})

describe('recordErrorState — caught errors', () => {
  it('records a boundary whose fiber committed with the DidCapture flag', async () => {
    recordErrorState(boundaryFiber('ErrorBoundary'))
    const state = await getErrorState({})
    expect(state.caughtErrors).toHaveLength(1)
    expect(state.caughtErrors[0]?.boundaryName).toBe('ErrorBoundary')
    expect(state.blankTreeHint).toMatch(/ErrorBoundary/)
  })

  it('does not record a fiber without the DidCapture flag', async () => {
    recordErrorState(boundaryFiber('Healthy', 0b1))
    expect((await getErrorState({})).caughtErrors).toHaveLength(0)
  })

  it('correlates the captured console.error message with the boundary', async () => {
    console.error(...reactBoundaryArgs)
    recordErrorState(boundaryFiber('ErrorBoundary'))
    const caught = (await getErrorState({})).caughtErrors[0]
    expect(caught?.message).toBe('Boomer exploded on purpose')
    expect(caught?.throwingComponent).toBe('Boomer')
  })

  it('clears a caught boundary once it re-renders without DidCapture (recovery)', async () => {
    const type = (): null => null
    Object.assign(type, { displayName: 'ErrorBoundary' })
    const fiber = { flags: DID_CAPTURE, type } as Record<string, unknown>

    recordErrorState(asFiber(fiber))
    expect((await getErrorState({})).caughtErrors).toHaveLength(1)

    fiber.flags = 0b1 // re-renders without DidCapture → recovered
    recordErrorState(asFiber(fiber))
    expect((await getErrorState({})).caughtErrors).toHaveLength(0)
  })
})

describe('recordErrorState — suspense', () => {
  it('records a Suspense boundary showing a fallback and drops it once resolved', async () => {
    const type = (): null => null
    Object.assign(type, { displayName: 'DataBoundary' })
    const fiber = {
      tag: SuspenseComponentTag,
      type,
      memoizedState: { dehydrated: null },
    } as Record<string, unknown>

    recordErrorState(asFiber(fiber))
    expect((await getErrorState({})).suspended).toHaveLength(1)

    fiber.memoizedState = null
    recordErrorState(asFiber(fiber))
    expect((await getErrorState({})).suspended).toHaveLength(0)
  })
})

describe('getErrorState — DevTools-forced boundaries', () => {
  it('surfaces a forced error boundary flagged forced, without a DidCapture flag or console log', async () => {
    forced.errors = [boundaryFiber('ForcedEB', 0)]
    const state = await getErrorState({})
    expect(state.caughtErrors).toHaveLength(1)
    expect(state.caughtErrors[0]?.boundaryName).toBe('ForcedEB')
    expect(state.caughtErrors[0]?.forced).toBe(true)
    expect(state.caughtErrors[0]?.message).toMatch(/react_force_error_boundary/)
    expect(state.blankTreeHint).toMatch(/react_reset_overrides/)
  })

  it('surfaces a forced suspense fallback flagged forced', async () => {
    forced.suspense = [boundaryFiber('ForcedSusp', 0)]
    const state = await getErrorState({})
    expect(state.suspended).toHaveLength(1)
    expect(state.suspended[0]?.boundaryName).toBe('ForcedSusp')
    expect(state.suspended[0]?.forced).toBe(true)
  })

  it('marks organically caught boundaries forced:false', async () => {
    recordErrorState(boundaryFiber('RealEB'))
    expect((await getErrorState({})).caughtErrors[0]?.forced).toBe(false)
  })

  it('lets a real thrown error win the hint over a forced boundary and lists both', async () => {
    console.error(...reactBoundaryArgs)
    recordErrorState(boundaryFiber('ErrorBoundary'))
    forced.errors = [boundaryFiber('ForcedEB', 0)]
    const state = await getErrorState({})
    expect(state.caughtErrors.map((c) => c.forced)).toEqual([false, true])
    expect(state.blankTreeHint).toMatch(/ErrorBoundary/)
    expect(state.blankTreeHint).not.toMatch(/react_reset_overrides/)
  })

  it('de-dupes a boundary that is both organically caught and forced (organic wins)', async () => {
    const eb = boundaryFiber('DupEB')
    recordErrorState(eb)
    forced.errors = [eb]
    const state = await getErrorState({})
    expect(state.caughtErrors).toHaveLength(1)
    expect(state.caughtErrors[0]?.forced).toBe(false)
  })
})
