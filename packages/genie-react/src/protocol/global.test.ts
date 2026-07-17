import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerGenieCollector } from './global'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('registerGenieCollector', () => {
  it('registers immediately when the browser client is ready', () => {
    const register = vi.fn()
    const collector = { meta: { id: 'query' } }
    vi.stubGlobal('__GENIE_REACT_AGENT__', { register })

    const stop = registerGenieCollector(collector)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(collector)
    stop()
  })

  it('registers once when the browser client becomes ready later', async () => {
    vi.useFakeTimers()
    const register = vi.fn()
    const collector = { meta: { id: 'query' } }
    vi.stubGlobal('__GENIE_REACT_AGENT__', undefined)

    const stop = registerGenieCollector(collector, { retryMs: 50, timeoutMs: 500 })
    globalThis.__GENIE_REACT_AGENT__ = { register }
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(500)

    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(collector)
    stop()
  })
})
