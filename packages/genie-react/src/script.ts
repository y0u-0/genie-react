import { createElement, type ReactElement } from 'react'
import { GENIE_CLIENT_PATH, GENIE_DEFAULT_HUB_PORT, GENIE_HUB_PORT_GLOBAL } from './protocol'

export interface GenieScriptProps {
  /** Port the genie hub listens on; defaults to the in-process hub's bound port, then GENIE_HUB_PORT, then 4390. */
  port?: number
}

/** Dev-only `<script>` tag for any SSR React root layout (Next.js, Remix, RR7 …): loads the hub-served client before React runs; renders nothing in production; RSC-safe (no hooks, no browser APIs). */
export function GenieScript({ port }: GenieScriptProps = {}): ReactElement | null {
  if (isProductionBuild()) return null
  const resolved = port ?? globalPort() ?? envPort() ?? GENIE_DEFAULT_HUB_PORT
  return createElement('script', { src: `http://localhost:${resolved}${GENIE_CLIENT_PATH}` })
}

// The hub publishes its bound port on a global symbol because Next.js resets `process.env` between recompiles — without it a walked port silently degrades to the default.
function globalPort(): number | undefined {
  const value = (globalThis as Record<symbol, unknown>)[Symbol.for(GENIE_HUB_PORT_GLOBAL)]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

// Written as a literal `process.env.NODE_ENV` so client bundlers statically replace it; the catch covers runtimes with no `process` global (unbundled dev pages).
function isProductionBuild(): boolean {
  try {
    return process.env.NODE_ENV === 'production'
  } catch {
    return false
  }
}

function envPort(): number | undefined {
  const raw = readEnv('GENIE_HUB_PORT')
  if (!raw) return undefined
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 ? port : undefined
}

/** `process` is an ambient optional global here: this module renders on the server and in browser bundles alike. */
function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  return env?.[name]
}
