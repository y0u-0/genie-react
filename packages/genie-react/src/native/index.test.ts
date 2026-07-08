// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenieProps } from './index'

type TaggedCollector = { __collector: string }
type ClientConfig = { url: string; appName?: string; collectors: TaggedCollector[] }

async function loadNative() {
  vi.resetModules()
  const startSpy = vi.fn()
  const registerSpy = vi.fn()
  const createGenieClient = vi.fn((_config: ClientConfig) => ({
    start: startSpy,
    registerCollector: registerSpy,
  }))
  const tag = (name: string) => () => ({ __collector: name })

  vi.doMock('../client', () => ({
    createGenieClient,
    sessionCollector: tag('session'),
  }))
  vi.doMock('../collectors/react', () => ({ reactCollector: tag('react') }))
  vi.doMock('../collectors/react/hook', () => ({}))
  vi.doMock('../collectors/memory', () => ({ memoryCollector: tag('memory') }))
  vi.doMock('../collectors/perf', () => ({ perfCollector: tag('perf') }))
  vi.doMock('../collectors/devtools-passthrough', () => ({
    pluginPassthroughCollector: () => ({ __collector: 'plugin' }),
  }))
  vi.doMock('../collectors/tanstack', () => ({
    routerCollector: (r: unknown) => ({ __collector: 'router', router: r }),
    queryCollector: (q: unknown) => ({ __collector: 'query', query: q }),
  }))

  const native = await import('./index')
  return { ...native, createGenieClient, startSpy, registerSpy }
}

const names = (collectors: TaggedCollector[]) => collectors.map((c) => c.__collector)
const registered = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.map((call) => (call[0] as TaggedCollector).__collector)

const URL = 'ws://localhost:4390/__genie/ws'
const queryClientDuck = () => ({ getQueryCache: () => ({}) })
const routerDuck = () => ({ subscribe: () => () => {}, navigate: async () => {} })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('startGenie', () => {
  it('starts one client with the base collectors and stays a singleton', async () => {
    const { startGenie, createGenieClient, startSpy } = await loadNative()

    const first = startGenie({ url: URL })
    const second = startGenie({ url: URL })

    expect(second).toBe(first)
    expect(createGenieClient).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledTimes(1)
    const config = createGenieClient.mock.calls[0]?.[0]
    expect(config?.url).toBe(URL)
    expect(names(config?.collectors ?? [])).toEqual([
      'session',
      'react',
      'memory',
      'perf',
      'plugin',
    ])
  })

  it('wires router and query collectors when valid instances arrive at start', async () => {
    const { startGenie, createGenieClient } = await loadNative()

    startGenie({ url: URL, queryClient: queryClientDuck(), router: routerDuck() })

    expect(names(createGenieClient.mock.calls[0]?.[0]?.collectors ?? [])).toEqual([
      'session',
      'react',
      'memory',
      'perf',
      'plugin',
      'router',
      'query',
    ])
  })

  it('registers a late queryClient onto the running client, exactly once', async () => {
    const { startGenie, registerSpy } = await loadNative()
    const queryClient = queryClientDuck()

    startGenie({ url: URL })
    startGenie({ url: URL, queryClient })
    startGenie({ url: URL, queryClient })

    expect(registered(registerSpy)).toEqual(['query'])
  })

  it('warns and skips an object that is not a QueryClient, without burning the slot', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startGenie, registerSpy } = await loadNative()

    startGenie({ url: URL, queryClient: { bogus: true } })
    startGenie({ url: URL, queryClient: queryClientDuck() })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(registered(registerSpy)).toEqual(['query'])
  })

  it('warns when a later call passes a different url and keeps the first connection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { startGenie, createGenieClient } = await loadNative()

    startGenie({ url: URL })
    startGenie({ url: 'ws://10.0.2.2:4390/__genie/ws' })

    expect(createGenieClient).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

describe('<Genie />', () => {
  it('starts exactly once under StrictMode double-invocation', async () => {
    const { Genie, createGenieClient } = await loadNative()

    render(createElement(StrictMode, null, createElement<GenieProps>(Genie, { url: URL })))

    expect(createGenieClient).toHaveBeenCalledTimes(1)
  })

  it('does not rerun the effect when a rerender passes the same values', async () => {
    const { Genie, createGenieClient, registerSpy } = await loadNative()

    const view = render(createElement<GenieProps>(Genie, { url: URL }))
    view.rerender(createElement<GenieProps>(Genie, { url: URL }))

    expect(createGenieClient).toHaveBeenCalledTimes(1)
    expect(registerSpy).not.toHaveBeenCalled()
  })

  it('registers a queryClient that appears on a later render', async () => {
    const { Genie, createGenieClient, registerSpy } = await loadNative()
    const queryClient = queryClientDuck()

    const view = render(createElement<GenieProps>(Genie, { url: URL }))
    view.rerender(createElement<GenieProps>(Genie, { url: URL, queryClient }))

    expect(createGenieClient).toHaveBeenCalledTimes(1)
    expect(registered(registerSpy)).toEqual(['query'])
    const query = registerSpy.mock.calls[0]?.[0] as { query?: unknown }
    expect(query.query).toBe(queryClient)
  })
})
