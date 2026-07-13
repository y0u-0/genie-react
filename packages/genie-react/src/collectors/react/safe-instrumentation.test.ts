import type { Fiber, FiberRoot, ReactRenderer } from 'bippy'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  renderers: new Map<number, ReactRenderer>(),
  detectReactBuildType: vi.fn<(renderer: ReactRenderer) => 'development' | 'production'>(),
}))

vi.mock('bippy', () => ({
  detectReactBuildType: mocks.detectReactBuildType,
  getRDTHook: () => ({ renderers: mocks.renderers }),
}))

const {
  isSafeRenderer,
  isSupportedRenderer,
  safeCommitHandler,
  safeUnmountHandler,
  supportedCommitHandler,
} = await import('./safe-instrumentation')

const renderer = (version: string): ReactRenderer => ({ version, bundleType: 1 }) as ReactRenderer

beforeEach(() => {
  mocks.renderers.clear()
  mocks.detectReactBuildType.mockReset().mockReturnValue('development')
})

describe('safe instrumentation', () => {
  it('accepts supported development renderers and rejects missing, old, or production ones', () => {
    mocks.renderers.set(1, renderer('19.2.0'))
    mocks.renderers.set(2, renderer('17.0.2'))

    expect(isSafeRenderer(1)).toBe(true)
    expect(isSafeRenderer(2)).toBe(false)
    expect(isSafeRenderer(3)).toBe(false)

    mocks.detectReactBuildType.mockReturnValue('production')
    expect(isSafeRenderer(1)).toBe(false)
    expect(isSupportedRenderer(1)).toBe(true)
  })

  it('observes roots from supported production-classified renderers without enabling safe analysis', () => {
    mocks.renderers.set(1, renderer('19.2.0'))
    mocks.detectReactBuildType.mockReturnValue('production')
    const handler = vi.fn()

    supportedCommitHandler(handler)(1, {} as FiberRoot)
    safeCommitHandler(handler)(1, {} as FiberRoot)

    expect(handler).toHaveBeenCalledOnce()
  })

  it('contains commit and unmount handler failures instead of escaping into React', () => {
    mocks.renderers.set(1, renderer('19.2.0'))
    const commit = safeCommitHandler(() => {
      throw new Error('commit diagnostic failed')
    })
    const unmount = safeUnmountHandler(() => {
      throw new Error('unmount diagnostic failed')
    })

    expect(() => commit(1, {} as FiberRoot)).not.toThrow()
    expect(() => unmount(1, {} as Fiber)).not.toThrow()
  })

  it('does not call handlers for unsafe renderers', () => {
    mocks.renderers.set(1, renderer('17.0.2'))
    const handler = vi.fn()

    safeCommitHandler(handler)(1, {} as FiberRoot)

    expect(handler).not.toHaveBeenCalled()
  })
})
