// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { createContext, createElement, StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GENIE_GLOBAL_KEY } from '../protocol'
import type { GenieProps } from './genie'

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
  const pluginPassthroughCollector = vi.fn(() => ({ __collector: 'plugin' }))
  vi.doMock('../collectors/devtools-passthrough', () => ({ pluginPassthroughCollector }))
  vi.doMock('../collectors/tanstack', () => ({
    routerCollector: (r: unknown) => ({ __collector: 'router', router: r }),
    queryCollector: (q: unknown) => ({ __collector: 'query', query: q }),
  }))
  vi.doMock('@tanstack/react-router', () => ({ useRouter: () => router }))
  const QueryClientContext = createContext<unknown>(undefined)
  vi.doMock('@tanstack/react-query', () => ({ QueryClientContext }))

  const { Genie } = await import('./genie')
  return { Genie, createGenieClient, startSpy, pluginPassthroughCollector, QueryClientContext }
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

  it('prefers the router-context QueryClient over a provider one', async () => {
    const routerClient = { getQueryCache: () => ({}) }
    const router = { options: { context: { queryClient: routerClient } } }
    const { Genie, createGenieClient, QueryClientContext } = await loadGenie(router)

    render(
      createElement(
        QueryClientContext.Provider,
        { value: { getQueryCache: () => ({}) } },
        createElement(Genie),
      ),
    )

    const collectors = createGenieClient.mock.calls[0]?.[0]?.collectors ?? []
    const query = collectors.find((collector) => collector.__collector === 'query')
    expect((query as { query?: unknown } | undefined)?.query).toBe(routerClient)
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

describe('<Genie /> under a bare QueryClientProvider (no router)', () => {
  it('picks the QueryClient up from the provider context', async () => {
    const queryClient = { getQueryCache: () => ({}) }
    const { Genie, createGenieClient, QueryClientContext } = await loadGenie(undefined)

    render(createElement(QueryClientContext.Provider, { value: queryClient }, createElement(Genie)))

    expect(names(createGenieClient.mock.calls[0]?.[0]?.collectors ?? [])).toEqual([
      'session',
      'react',
      'memory',
      'plugin',
      'query',
    ])
  })

  it('prefers an explicit queryClient prop over every discovered source', async () => {
    const propClient = { getQueryCache: () => ({}) }
    const router = { options: { context: { queryClient: { getQueryCache: () => ({}) } } } }
    const { Genie, createGenieClient, QueryClientContext } = await loadGenie(router)

    render(
      createElement(
        QueryClientContext.Provider,
        { value: { getQueryCache: () => ({}) } },
        createElement<GenieProps>(Genie, { queryClient: propClient as never }),
      ),
    )

    const collectors = createGenieClient.mock.calls[0]?.[0]?.collectors ?? []
    const query = collectors.find((collector) => collector.__collector === 'query')
    expect((query as { query?: unknown } | undefined)?.query).toBe(propClient)
  })

  it('ignores a provider value that is not a QueryClient', async () => {
    const { Genie, createGenieClient, QueryClientContext } = await loadGenie(undefined)

    render(
      createElement(QueryClientContext.Provider, { value: { bogus: true } }, createElement(Genie)),
    )

    expect(names(createGenieClient.mock.calls[0]?.[0]?.collectors ?? [])).toEqual([
      'session',
      'react',
      'memory',
      'plugin',
    ])
  })
})

describe('<Genie /> declared plugins', () => {
  it('forwards the plugins prop to the passthrough collector', async () => {
    const { Genie, pluginPassthroughCollector } = await loadGenie(undefined)

    render(createElement<GenieProps>(Genie, { plugins: ['cart-devtools', 'metrics-devtools'] }))

    expect(pluginPassthroughCollector).toHaveBeenCalledWith({
      plugins: ['cart-devtools', 'metrics-devtools'],
    })
  })
})

describe('<Genie /> idempotency', () => {
  it('starts the client exactly once under StrictMode double-invocation', async () => {
    const { Genie, createGenieClient } = await loadGenie(undefined)

    render(createElement(StrictMode, null, createElement(Genie)))

    expect(createGenieClient).toHaveBeenCalledTimes(1)
  })
})
