// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GENIE_GLOBAL_KEY } from '../protocol'

type TaggedCollector = { __collector: string }
type ClientConfig = { appName?: string; collectors: TaggedCollector[] }

async function loadGenie(router: unknown) {
  vi.resetModules()
  const startSpy = vi.fn()
  const createGenieClient = vi.fn((_config: ClientConfig) => ({ start: startSpy }))
  const tag = (name: string) => () => ({ __collector: name })

  vi.doMock('../client', () => ({
    createGenieClient,
    sessionCollector: tag('session'),
  }))
  vi.doMock('../collectors/react', () => ({ reactCollector: tag('react') }))
  vi.doMock('../collectors/memory', () => ({ memoryCollector: tag('memory') }))
  vi.doMock('../collectors/devtools-passthrough', () => ({
    pluginPassthroughCollector: tag('plugin'),
  }))
  vi.doMock('../collectors/tanstack', () => ({
    routerCollector: (r: unknown) => ({ __collector: 'router', router: r }),
    queryCollector: (q: unknown) => ({ __collector: 'query', query: q }),
  }))
  vi.doMock('@tanstack/react-router', () => ({ useRouter: () => router }))

  const { Genie } = await import('./genie')
  return { Genie, createGenieClient, startSpy }
}

const names = (collectors: TaggedCollector[]) => collectors.map((c) => c.__collector)

afterEach(() => {
  cleanup()
  delete (globalThis as Record<string, unknown>)[GENIE_GLOBAL_KEY]
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('<Genie /> in a plain React app (no router)', () => {
  it('starts its own client with the base collectors and never errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { Genie, createGenieClient, startSpy } = await loadGenie(undefined)

    render(createElement(Genie))

    expect(createGenieClient).toHaveBeenCalledTimes(1)
    expect(names(createGenieClient.mock.calls[0]?.[0]?.collectors ?? [])).toEqual([
      'session',
      'react',
      'memory',
      'plugin',
    ])
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('<Genie /> with a plugin-injected client already running', () => {
  it('registers the augmenting collectors onto it instead of starting a second client', async () => {
    const register = vi.fn()
    ;(globalThis as Record<string, unknown>)[GENIE_GLOBAL_KEY] = { register }
    const { Genie, createGenieClient } = await loadGenie(undefined)

    render(createElement(Genie))

    expect(createGenieClient).not.toHaveBeenCalled()
    expect(register).toHaveBeenCalledTimes(2)
    const registered = register.mock.calls.map((c) => (c[0] as TaggedCollector).__collector)
    expect(registered).toEqual(['memory', 'plugin'])
  })
})

describe('<Genie /> under a TanStack Router', () => {
  it('adds the router collector, and the query collector when a QueryClient is in context', async () => {
    const router = { options: { context: { queryClient: { getQueryCache: () => ({}) } } } }
    const { Genie, createGenieClient } = await loadGenie(router)

    render(createElement(Genie))

    expect(names(createGenieClient.mock.calls[0]?.[0]?.collectors ?? [])).toEqual([
      'session',
      'react',
      'memory',
      'plugin',
      'router',
      'query',
    ])
  })

  it('adds only the router collector when there is no QueryClient in context', async () => {
    const router = { options: { context: {} } }
    const { Genie, createGenieClient } = await loadGenie(router)

    render(createElement(Genie))

    expect(names(createGenieClient.mock.calls[0]?.[0]?.collectors ?? [])).toEqual([
      'session',
      'react',
      'memory',
      'plugin',
      'router',
    ])
  })

  it('does not crash for a minimal router whose options.context is undefined', async () => {
    const router = { options: {} }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { Genie, createGenieClient } = await loadGenie(router)

    expect(() => render(createElement(Genie))).not.toThrow()
    expect(names(createGenieClient.mock.calls[0]?.[0]?.collectors ?? [])).toEqual([
      'session',
      'react',
      'memory',
      'plugin',
      'router',
    ])
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('<Genie /> idempotency', () => {
  it('starts the client exactly once under StrictMode double-invocation', async () => {
    const { Genie, createGenieClient } = await loadGenie(undefined)

    render(createElement(StrictMode, null, createElement(Genie)))

    expect(createGenieClient).toHaveBeenCalledTimes(1)
  })
})
