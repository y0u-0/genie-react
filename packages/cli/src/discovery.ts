import { readFile, unlink } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { GENIE_DISCOVERY_FILE, GENIE_WS_PATH } from 'genie-react/protocol'
import { isRecord } from './guards'

/** ESRCH/ERANGE mean the process is gone; EPERM means alive but owned by another user. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

export interface BridgeDiscovery {
  url: string
  pid?: number
}

/** Validate the WebSocket endpoint before it reaches ws or a paste-ready shell command. */
export function normalizeBridgeUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Bridge URL must be an absolute ws:// or wss:// URL.')
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Bridge URL must use ws:// or wss://.')
  }
  if (url.username || url.password) throw new Error('Bridge URL cannot contain credentials.')
  if (url.search || url.hash) throw new Error('Bridge URL cannot contain a query or fragment.')
  return url.toString()
}

/** The single reader of a `.genie/bridge.json` payload, so the upward walk and `doctor` narrow the JSON identically. */
export function parseBridgeDiscovery(raw: string): BridgeDiscovery | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.url !== 'string') return null
  let url: string
  try {
    url = normalizeBridgeUrl(parsed.url)
  } catch {
    return null
  }
  return {
    url,
    pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
  }
}

export interface ResolvedBridge {
  url: string
  /** `fallback` means the URL is a guess (no env, no discovery file) — callers should say so instead of presenting it as fact. */
  source: 'env' | 'file' | 'fallback'
}

/** Priority: `GENIE_BRIDGE_URL` env → discovery file → localhost default (hostname, so IPv4 or IPv6 loopback both work). */
export async function resolveBridge(cwd: string = process.cwd()): Promise<ResolvedBridge> {
  const fromEnv = process.env.GENIE_BRIDGE_URL
  if (fromEnv) return { url: normalizeBridgeUrl(fromEnv), source: 'env' }

  const fromFile = await readDiscoveryUpward(cwd)
  if (fromFile) return { url: fromFile, source: 'file' }

  const port = process.env.GENIE_BRIDGE_PORT ?? '5173'
  return { url: normalizeBridgeUrl(`ws://localhost:${port}${GENIE_WS_PATH}`), source: 'fallback' }
}

export async function resolveBridgeUrl(cwd: string = process.cwd()): Promise<string> {
  return (await resolveBridge(cwd)).url
}

// Walks up to the filesystem root, so `genie-react call` works from nested dirs and monorepo roots.
async function readDiscoveryUpward(startDir: string): Promise<string | null> {
  const { root } = parse(startDir)
  let dir = startDir
  for (;;) {
    const path = join(dir, GENIE_DISCOVERY_FILE)
    try {
      const raw = await readFile(path, 'utf8')
      const discovery = parseBridgeDiscovery(raw)
      if (discovery?.url) {
        if (discovery.pid === undefined || isPidAlive(discovery.pid)) return discovery.url
        // A SIGKILLed dev server/hub never cleans up; a dead pid means the URL is a lie — heal instead of failing weird.
        await unlink(path).catch(() => {})
        process.stderr.write(
          `genie-react: removed stale ${GENIE_DISCOVERY_FILE} (pid ${discovery.pid} is gone)\n`,
        )
      }
    } catch {
      // not in this dir — keep walking up
    }
    if (dir === root) return null
    dir = dirname(dir)
  }
}
