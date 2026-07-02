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

const asFiber = (shape: unknown): Fiber => shape as Fiber
const DID_CAPTURE = 0b1000_0000

const boundaryFiber = (name: string, flags = DID_CAPTURE): Fiber => {
  const type = (): null => null
  ;(type as { displayName?: string }).displayName = name
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
beforeEach(() => clearErrorState())

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
    ;(type as { displayName?: string }).displayName = 'ErrorBoundary'
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
    ;(type as { displayName?: string }).displayName = 'DataBoundary'
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
