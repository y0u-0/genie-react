import type { AnyRouter } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import type { CollectorContext, GenieCollector } from '../../client'
import { routerCollector } from './router'

const ctx: CollectorContext = {
  pushSnapshot() {},
  pushEvent() {},
  refreshTools() {},
  markActivity() {},
}

function call<T = unknown>(collector: GenieCollector, name: string, args: unknown): Promise<T> | T {
  const tool = collector.tools?.find((t) => t.contract.name === name)
  if (!tool) throw new Error(`tool not found: ${name}`)
  return tool.handler(args as never, ctx) as Promise<T> | T
}

interface StubRouter {
  router: AnyRouter
  navigated: Array<{ to: string }>
  invalidated: number
}

function makeRouter(): StubRouter {
  const navigated: Array<{ to: string }> = []
  let invalidated = 0
  const state = {
    location: { pathname: '/', href: '/', searchStr: '', hash: '' },
    status: 'idle',
    isLoading: false,
    isTransitioning: false,
    matches: [
      {
        routeId: '__root__',
        pathname: '/',
        params: {},
        search: {},
        status: 'success',
        isFetching: false,
        loaderData: { ok: true },
      },
      {
        routeId: '/dashboard',
        pathname: '/dashboard',
        params: { id: '7' },
        search: { tab: 'overview' },
        status: 'success',
        isFetching: false,
        loaderData: { widgets: 3 },
      },
    ],
  }
  const router = {
    state,
    subscribe: () => () => {},
    navigate: async ({ to }: { to: string }) => {
      navigated.push({ to })
      state.location.pathname = to
      state.location.href = to
    },
    invalidate: async () => {
      invalidated += 1
    },
  }
  return {
    router: router as unknown as AnyRouter,
    navigated,
    get invalidated() {
      return invalidated
    },
  }
}

describe('routerCollector', () => {
  it('router_get_state surfaces location, status, and match count', async () => {
    const collector = routerCollector(makeRouter().router)
    const state = (await call(collector, 'router_get_state', {})) as {
      pathname: string
      href: string
      status: string
      isLoading: boolean
      matchCount: number
    }
    expect(state.pathname).toBe('/')
    expect(state.status).toBe('idle')
    expect(state.isLoading).toBe(false)
    expect(state.matchCount).toBe(2)
  })

  it('router_list_matches returns each active match with dehydrated loader data', async () => {
    const collector = routerCollector(makeRouter().router)
    const result = (await call(collector, 'router_list_matches', { depth: 2 })) as {
      matches: Array<{ routeId: string; pathname: string; params: unknown; loaderData: unknown }>
    }
    expect(result.matches).toHaveLength(2)
    expect(result.matches[1]?.routeId).toBe('/dashboard')
    expect(result.matches[1]?.params).toEqual({ id: '7' })
    expect(result.matches[1]?.loaderData).toEqual({ widgets: 3 })
  })

  it('router_navigate drives navigation and echoes the new pathname', async () => {
    const stub = makeRouter()
    const collector = routerCollector(stub.router)
    const result = (await call(collector, 'router_navigate', {
      to: '/about',
      replace: false,
    })) as { ok: boolean; pathname: string }
    expect(result).toEqual({ ok: true, pathname: '/about' })
    expect(stub.navigated).toEqual([{ to: '/about' }])
  })

  it('router_invalidate forces loaders to re-run', async () => {
    const stub = makeRouter()
    const collector = routerCollector(stub.router)
    const result = (await call(collector, 'router_invalidate', {})) as { ok: boolean }
    expect(result).toEqual({ ok: true })
    expect(stub.invalidated).toBe(1)
  })
})
