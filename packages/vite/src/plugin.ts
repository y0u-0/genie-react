import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GenieBridge } from '@genie-react/bridge'
import { GENIE_DISCOVERY_FILE, GENIE_GLOBAL_KEY, GENIE_WS_PATH } from '@genie-react/core'
import { type Plugin, type Rollup, searchForWorkspaceRoot, type ViteDevServer } from 'vite'

export interface GenieViteOptions {
  /** Overrides the app name reported to the agent (defaults to the document title). */
  appName?: string
  /** Set to `false` to disable Genie even in dev (e.g. via an env flag). Defaults to `true`. */
  enabled?: boolean
  /** Auto-register the React collector and its pre-React commit hook (default `true`); `false` gives session info only. */
  react?: boolean
  /** Override the bridge's per-request timeout in ms (default 20000). */
  requestTimeoutMs?: number
}

const HOOK_MODULE = '@genie-react/react-collector/hook'
const MISSING_HOOK_WARNING =
  '[genie] @genie-react/react-collector not found — render tracking/profiling are disabled. Install it (recommended), or pass react:false to silence this.'

// Bare specifiers the injected client imports; aliased from this plugin's own location so they resolve regardless of the host's hoisting layout.
const RUNTIME_MODULES = [
  HOOK_MODULE,
  '@genie-react/react-collector',
  '@genie-react/client',
] as const

function runtimeAliases(): { find: RegExp; replacement: string }[] {
  const aliases: { find: RegExp; replacement: string }[] = []
  for (const specifier of RUNTIME_MODULES) {
    try {
      const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const file = fileURLToPath(import.meta.resolve(specifier))
      aliases.push({ find: new RegExp(`^${escaped}$`), replacement: file })
    } catch {
      // collector not installed — leave it unaliased so the missing-hook path degrades gracefully
    }
  }
  return aliases
}

/** Matches the TanStack Start client entry, where the hook import must be hoisted above React. */
function isClientEntry(id: string): boolean {
  const path = id.split('?')[0] ?? id
  return path.includes('tanstack-start') && path.includes('client-entry')
}

const VIRTUAL_ID = 'virtual:genie-client'
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`

// Optional peer of <Genie />: resolved to a no-op stub when absent so neither dev nor `vite build` fails on the import.
const OPTIONAL_ROUTER_SPECIFIER = '@tanstack/react-router'
const ROUTER_STUB_ID = '\0virtual:genie-optional-router'
const ROUTER_STUB_CODE = 'export const useRouter = () => undefined\n'
// Vite resolves an absent *optional* peer to this synthetic throwing placeholder (not null), so it must count as "not installed".
const VITE_OPTIONAL_PEER_PREFIX = '__vite-optional-peer-dep:'

/** Dev-only plugin: mounts the hub on Vite's own HTTP server (no extra port), injects the client first in `<head>`, and writes a discovery file for the genie CLI. */
export function genie(options: GenieViteOptions = {}): Plugin[] {
  const enabled = options.enabled ?? true
  const react = options.react ?? true
  let bridge: GenieBridge | null = null
  let warnedMissingHook = false

  async function resolveHook(ctx: Rollup.PluginContext): Promise<boolean> {
    if ((await ctx.resolve(HOOK_MODULE)) != null) return true
    if (!warnedMissingHook) {
      warnedMissingHook = true
      ctx.warn(MISSING_HOOK_WARNING)
    }
    return false
  }

  const plugin: Plugin = {
    name: 'genie',
    apply: 'serve',
    enforce: 'pre',

    config(userConfig) {
      if (!enabled) return undefined
      // fs.allow serves a linked checkout (`genie link`); setting it drops Vite's workspace-root default, so re-include that.
      const genieRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
      const root = userConfig.root ? resolve(userConfig.root) : process.cwd()
      return {
        // Dedupe to one React copy: a `genie link` checkout otherwise gets two Reacts and an "invalid hook call".
        resolve: {
          alias: runtimeAliases(),
          dedupe: ['react', 'react-dom', '@tanstack/react-router', '@tanstack/react-query'],
        },
        server: { fs: { allow: [searchForWorkspaceRoot(root), genieRoot] } },
      }
    },

    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : null
    },

    async load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return null
      const reactAvailable = react && (await resolveHook(this))
      return generateClientModule(options, reactAvailable)
    },

    async transform(code, id) {
      if (!enabled || !react || !isClientEntry(id)) return undefined
      // Skip gracefully when the hook module isn't installed, so a minimal setup doesn't break the build.
      if (!(await resolveHook(this))) return undefined
      // Hoisted above the entry's React import, so the DevTools hook installs before React loads.
      return { code: `import ${JSON.stringify(HOOK_MODULE)};\n${code}`, map: null }
    },

    configureServer(server) {
      if (!enabled) return
      bridge = new GenieBridge({
        requestTimeoutMs: options.requestTimeoutMs,
        logger: (level, message) => server.config.logger.info(`[genie:${level}] ${message}`),
      })
      const httpServer = server.httpServer
      if (!httpServer) return

      httpServer.on('upgrade', (request, socket, head) => {
        bridge?.handleUpgrade(request, socket, head)
      })
      httpServer.once('listening', () => {
        void writeDiscovery(server, httpServer.address())
      })
      httpServer.once('close', () => {
        bridge?.close()
        void removeDiscovery(server)
      })
    },

    transformIndexHtml() {
      if (!enabled) return undefined
      // Vite doesn't rewrite bare specifiers in injected inline scripts; use the /@id/ URL it already serves the virtual module from.
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: `/@id/__x00__${VIRTUAL_ID}` },
          injectTo: 'head-prepend',
        },
      ]
    },
  }

  return [plugin, optionalRouterPlugin()]
}

// No `apply` on purpose: unlike the serve-only genie plugin, the router stub must also run during `vite build`.
function optionalRouterPlugin(): Plugin {
  return {
    name: 'genie:optional-router',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source !== OPTIONAL_ROUTER_SPECIFIER) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      const installed = resolved != null && !resolved.id.startsWith(VITE_OPTIONAL_PEER_PREFIX)
      return installed ? null : ROUTER_STUB_ID
    },
    load(id) {
      return id === ROUTER_STUB_ID ? ROUTER_STUB_CODE : null
    },
  }
}

function generateClientModule(options: GenieViteOptions, reactAvailable: boolean): string {
  const appName = options.appName ? JSON.stringify(options.appName) : 'undefined'
  const lines: string[] = []
  // Hook import first so the DevTools commit hook installs before React registers its renderer.
  if (reactAvailable) lines.push(`import ${JSON.stringify(HOOK_MODULE)}`)
  lines.push("import { createGenieClient, sessionCollector } from '@genie-react/client'")
  if (reactAvailable) lines.push("import { reactCollector } from '@genie-react/react-collector'")
  const collectors = reactAvailable
    ? '[sessionCollector(), reactCollector()]'
    : '[sessionCollector()]'
  lines.push(
    `if (typeof window !== 'undefined' && !window[${JSON.stringify(GENIE_GLOBAL_KEY)}]) {`,
    `  createGenieClient({ appName: ${appName}, collectors: ${collectors} }).start()`,
    '}',
    '',
  )
  return lines.join('\n')
}

async function writeDiscovery(
  server: ViteDevServer,
  address: string | AddressInfo | null,
): Promise<void> {
  if (!address || typeof address === 'string') return
  // `localhost` (not a fixed IP) so the CLI connects whether Vite bound IPv4 or IPv6 loopback.
  const url = `ws://localhost:${address.port}${GENIE_WS_PATH}`
  const file = join(server.config.root, GENIE_DISCOVERY_FILE)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    `${JSON.stringify({ url, port: address.port, pid: process.pid }, null, 2)}\n`,
  )
  server.config.logger.info(`[genie] bridge ready at ${url}`)
}

async function removeDiscovery(server: ViteDevServer): Promise<void> {
  try {
    await rm(join(server.config.root, GENIE_DISCOVERY_FILE))
  } catch {
    // discovery file may not exist; ignore
  }
}
