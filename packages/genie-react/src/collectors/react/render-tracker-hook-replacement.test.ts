import type { FiberRoot, InstrumentationOptions } from 'bippy'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  currentHook: { name: 'initial' },
  hookLookupError: false,
  installations: [] as Array<{
    hook: object
    options: InstrumentationOptions
    disposed: boolean
  }>,
}))

vi.mock('bippy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bippy')>()
  return {
    ...actual,
    getRDTHook: () => {
      if (harness.hookLookupError) throw new Error('hook lookup failed')
      return harness.currentHook
    },
    instrument: (_options: InstrumentationOptions) => {
      const installation = {
        hook: harness.currentHook,
        options: _options,
        disposed: false,
      }
      harness.installations.push(installation)
      const dispose = () => {
        installation.disposed = true
      }
      return Object.assign(dispose, { [Symbol.dispose]: dispose })
    },
    traverseRenderedFibers: () => {},
  }
})

vi.mock('./refresh-tracker', () => ({
  isRefreshCommit: () => false,
  noteExcludedRefreshCommit: () => {},
}))

vi.mock('./safe-instrumentation', () => ({
  isSafeRenderer: () => true,
  supportedCommitHandler: <T extends (...args: never[]) => unknown>(handler: T) => handler,
}))

import {
  clearRenders,
  disposeRenderTracking,
  getCommitCount,
  startRenderTracking,
} from './render-tracker'

beforeEach(() => {
  disposeRenderTracking()
  harness.currentHook = { name: 'initial' }
  harness.hookLookupError = false
  harness.installations.length = 0
})

afterEach(() => disposeRenderTracking())

describe('React DevTools hook replacement', () => {
  it('reinstalls commit instrumentation when profiling resumes on a replacement hook', () => {
    startRenderTracking()
    const initialInstallation = harness.installations[0]

    harness.currentHook = { name: 'replacement' }
    startRenderTracking()

    expect(initialInstallation?.disposed).toBe(true)
    expect(harness.installations).toHaveLength(2)
    expect(harness.installations[1]?.hook).toBe(harness.currentHook)

    clearRenders()
    harness.installations[1]?.options.onCommitFiberRoot?.(1, {
      current: { child: null },
    } as FiberRoot)
    expect(getCommitCount()).toBe(1)
  })

  it('disposes stale instrumentation and can recover after hook lookup fails', () => {
    startRenderTracking()
    const initialInstallation = harness.installations[0]

    harness.hookLookupError = true
    expect(startRenderTracking()).toBe(false)
    expect(initialInstallation?.disposed).toBe(true)

    harness.hookLookupError = false
    expect(startRenderTracking()).toBe(true)
    expect(harness.installations).toHaveLength(2)
  })
})
