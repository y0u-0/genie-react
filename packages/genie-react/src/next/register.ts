import { GENIE_DEFAULT_HUB_PORT, GENIE_HUB_PORT_GLOBAL } from '../protocol'

export interface RegisterGenieOptions {
  /** Preferred port for the hub; defaults to GENIE_HUB_PORT, then 4390. Busy ports walk upward. */
  port?: number
  /** Directory the discovery file is written to (defaults to the project cwd). */
  rootDir?: string
}

const HUB_FLAG = Symbol.for('genie-react.hub')

/** Starts the standalone hub from Next.js `instrumentation.ts`; no-ops in production, on the edge runtime, and on repeat calls (register() re-runs on Fast Refresh) — the hub loads lazily so this module stays Node-import-free for client/edge bundles. */
export async function registerGenie(options: RegisterGenieOptions = {}): Promise<void> {
  if (readEnv('NODE_ENV') === 'production') return
  if (readEnv('NEXT_RUNTIME') === 'edge') return
  const holder = globalThis as Record<symbol, unknown>
  if (holder[HUB_FLAG]) return
  holder[HUB_FLAG] = true

  const { startGenieHub } = await import('genie-react/hub')
  try {
    const result = await startGenieHub({
      rootDir: options.rootDir,
      port: options.port ?? envPort() ?? GENIE_DEFAULT_HUB_PORT,
    })
    if (result.status === 'started') holder[HUB_FLAG] = result.handle
    // Hand the bound port to <GenieScript /> on a global symbol: Next resets `process.env` on recompiles while the singleton guard skips this re-run, so the env alone loses a walked port.
    holder[Symbol.for(GENIE_HUB_PORT_GLOBAL)] = result.port
    setEnv('GENIE_HUB_PORT', String(result.port))
    log(
      result.status === 'reused'
        ? `hub for this app already running at ${result.url}`
        : `hub ready at ${result.url}`,
    )
    log(`<GenieScript /> loads ${result.clientUrl}`)
  } catch (error) {
    holder[HUB_FLAG] = undefined
    throw error
  }
}

/** Stops the hub started by registerGenie (test teardown / graceful shutdown). */
export async function stopGenieHub(): Promise<void> {
  const holder = globalThis as Record<symbol, unknown>
  const handle = holder[HUB_FLAG]
  holder[HUB_FLAG] = undefined
  holder[Symbol.for(GENIE_HUB_PORT_GLOBAL)] = undefined
  if (isCloseable(handle)) await handle.close()
}

function isCloseable(value: unknown): value is { close: () => Promise<void> } {
  return typeof value === 'object' && value !== null && 'close' in value
}

function log(message: string): void {
  console.info(`[genie] ${message}`)
}

function envPort(): number | undefined {
  const raw = readEnv('GENIE_HUB_PORT')
  if (!raw) return undefined
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 ? port : undefined
}

/** `process` is optional here so the module also evaluates cleanly in browser bundles. */
function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  return env?.[name]
}

function setEnv(name: string, value: string): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  if (env) env[name] = value
}
