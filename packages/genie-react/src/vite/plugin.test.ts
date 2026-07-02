import type { Plugin } from 'vite'
import { describe, expect, it } from 'vitest'
import { genie } from './plugin'

function getHook<T>(plugin: Plugin, name: keyof Plugin): T {
  const hook = plugin[name] as unknown
  const fn = typeof hook === 'function' ? hook : (hook as { handler: unknown }).handler
  return fn as T
}

type ResolveCtx = {
  resolve: (source: string, importer?: string, options?: object) => Promise<unknown>
  warn?: (message: string) => void
}
type ResolveIdFn = (
  this: ResolveCtx,
  source: string,
  importer: string | undefined,
  options: object,
) => Promise<string | null>
type LoadFn = (this: unknown, id: string) => string | null
type TransformFn = (
  this: ResolveCtx,
  code: string,
  id: string,
) => Promise<{ code: string; map: null } | undefined>
type IndexHtmlFn = (
  this: unknown,
) => { tag: string; attrs: Record<string, string>; injectTo: string }[] | undefined
type ConfigFn = (
  this: unknown,
  userConfig: Record<string, unknown>,
) => { resolve?: { dedupe?: string[] } } | undefined

const present: ResolveCtx = {
  resolve: async () => ({ id: '/node_modules/@tanstack/react-router' }),
}
const absent: ResolveCtx = { resolve: async () => null }
// Vite resolves an unresolved optional peer to this synthetic placeholder, not null.
const optionalPeerPlaceholder: ResolveCtx = {
  resolve: async () => ({
    id: '__vite-optional-peer-dep:@tanstack/react-router:genie-react',
  }),
}

describe('genie() plugin array', () => {
  it('returns the serve plugin plus the optional-peers plugin', () => {
    const plugins = genie()
    expect(plugins).toHaveLength(2)
    expect(plugins[0]?.name).toBe('genie')
    expect(plugins[0]?.apply).toBe('serve')
    expect(plugins[1]?.name).toBe('genie:optional-peers')
    // No `apply`: the stub must run in build too, not only serve.
    expect(plugins[1]?.apply).toBeUndefined()
  })
})

describe('optional-peer stubs', () => {
  const optional = genie()[1] as Plugin
  const resolveId = getHook<ResolveIdFn>(optional, 'resolveId')
  const load = getHook<LoadFn>(optional, 'load')

  it('stubs @tanstack/react-router when Vite cannot resolve it', async () => {
    const id = await resolveId.call(absent, '@tanstack/react-router', undefined, {})
    expect(id).toBe('\0virtual:genie-optional-router')
  })

  it('stubs when Vite returns its optional-peer-dep placeholder for the absent peer', async () => {
    const id = await resolveId.call(
      optionalPeerPlaceholder,
      '@tanstack/react-router',
      undefined,
      {},
    )
    expect(id).toBe('\0virtual:genie-optional-router')
  })

  it('defers to the real module when it resolves', async () => {
    const id = await resolveId.call(present, '@tanstack/react-router', undefined, {})
    expect(id).toBeNull()
  })

  it('stubs @tanstack/react-query with a bare QueryClientContext when absent', async () => {
    const id = await resolveId.call(absent, '@tanstack/react-query', undefined, {})
    expect(id).toBe('\0virtual:genie-optional-query')
    const code = load.call(null, '\0virtual:genie-optional-query')
    expect(code).toContain('export const QueryClientContext')
    expect(code).toContain('createContext(undefined)')
  })

  it('ignores any other specifier', async () => {
    const id = await resolveId.call(absent, '@tanstack/query-core', undefined, {})
    expect(id).toBeNull()
  })

  it('serves a no-op useRouter for the stub id and nothing else', async () => {
    const code = load.call(null, '\0virtual:genie-optional-router')
    expect(code).toContain('export const useRouter')
    expect(code).toContain('undefined')
    expect(load.call(null, '/some/other/module.ts')).toBeNull()
  })
})

describe('client-entry hook hoisting', () => {
  const main = genie()[0] as Plugin
  const transform = getHook<TransformFn>(main, 'transform')
  const ctx: ResolveCtx = { resolve: async () => ({ id: 'hook' }), warn: () => {} }

  it('hoists the collector hook above a TanStack Start client entry even with a Vite query suffix', async () => {
    const out = await transform.call(
      ctx,
      'import "react"\n',
      '/app/.tanstack-start/client-entry.tsx?v=abc123',
    )
    expect(out?.code.startsWith('import "genie-react/hook";')).toBe(true)
    expect(out?.code).toContain('import "react"')
  })

  it('leaves non-client-entry modules untouched', async () => {
    const out = await transform.call(ctx, 'code', '/app/src/main.tsx')
    expect(out).toBeUndefined()
  })

  it('does nothing when react instrumentation is disabled', async () => {
    const noReact = genie({ react: false })[0] as Plugin
    const t = getHook<TransformFn>(noReact, 'transform')
    const out = await t.call(ctx, 'code', '/app/.tanstack-start/client-entry.tsx')
    expect(out).toBeUndefined()
  })
})

describe('client injection for index.html shapes', () => {
  const main = genie()[0] as Plugin
  const indexHtml = getHook<IndexHtmlFn>(main, 'transformIndexHtml')

  it('head-prepends the genie client module script', () => {
    const tags = indexHtml.call(null)
    expect(tags?.[0]?.attrs.src).toContain('virtual:genie-client')
    expect(tags?.[0]?.injectTo).toBe('head-prepend')
  })

  it('injects nothing when disabled', () => {
    const disabled = genie({ enabled: false })[0] as Plugin
    const fn = getHook<IndexHtmlFn>(disabled, 'transformIndexHtml')
    expect(fn.call(null)).toBeUndefined()
  })
})

describe('config dedupe (avoids dual-React under genie link)', () => {
  const main = genie()[0] as Plugin
  const config = getHook<ConfigFn>(main, 'config')

  it('dedupes react + react-dom to a single copy', () => {
    const cfg = config.call(null, {})
    expect(cfg?.resolve?.dedupe).toContain('react')
    expect(cfg?.resolve?.dedupe).toContain('react-dom')
  })

  it('returns no config when disabled', () => {
    const disabled = genie({ enabled: false })[0] as Plugin
    expect(getHook<ConfigFn>(disabled, 'config').call(null, {})).toBeUndefined()
  })
})
