import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GENIE_DISCOVERY_FILE, GENIE_WS_PATH } from 'genie-react/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isPidAlive, resolveBridge, resolveBridgeUrl } from './discovery'

const ENV_KEYS = ['GENIE_BRIDGE_URL', 'GENIE_BRIDGE_PORT'] as const

describe('resolveBridgeUrl', () => {
  let cwd: string
  const saved = new Map<string, string | undefined>()

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key])
      delete process.env[key]
    }
    cwd = await mkdtemp(join(tmpdir(), 'genie-discovery-'))
  })

  afterEach(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    saved.clear()
    await rm(cwd, { recursive: true, force: true })
  })

  const writeDiscovery = async (contents: string) => {
    const file = join(cwd, GENIE_DISCOVERY_FILE)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, contents, 'utf8')
  }

  it('lets the env override win over a discovery file and the default', async () => {
    process.env.GENIE_BRIDGE_URL = 'ws://override.example/socket'
    await writeDiscovery(JSON.stringify({ url: 'ws://from-file/__genie/ws' }))
    expect(await resolveBridgeUrl(cwd)).toBe('ws://override.example/socket')
  })

  it('reads the bridge url from a discovery file in the given cwd', async () => {
    await writeDiscovery(JSON.stringify({ url: 'ws://127.0.0.1:4321/__genie/ws', port: 4321 }))
    expect(await resolveBridgeUrl(cwd)).toBe('ws://127.0.0.1:4321/__genie/ws')
  })

  it('walks up to find a discovery file in a parent directory (nested cwd / monorepo root)', async () => {
    await writeDiscovery(JSON.stringify({ url: 'ws://127.0.0.1:4321/__genie/ws', port: 4321 }))
    const nested = join(cwd, 'packages', 'app', 'src')
    await mkdir(nested, { recursive: true })
    expect(await resolveBridgeUrl(nested)).toBe('ws://127.0.0.1:4321/__genie/ws')
  })

  it('falls through to the localhost default when the discovery file is malformed', async () => {
    await writeDiscovery('{ not json')
    expect(await resolveBridgeUrl(cwd)).toBe(`ws://localhost:5173${GENIE_WS_PATH}`)
  })

  it('falls through to the default when no discovery file exists', async () => {
    expect(await resolveBridgeUrl(cwd)).toBe(`ws://localhost:5173${GENIE_WS_PATH}`)
  })

  it('honors GENIE_BRIDGE_PORT and GENIE_WS_PATH in the default', async () => {
    process.env.GENIE_BRIDGE_PORT = '6100'
    expect(await resolveBridgeUrl(cwd)).toBe(`ws://localhost:6100${GENIE_WS_PATH}`)
  })

  it('falls through to the default when the discovery file lacks a url', async () => {
    await writeDiscovery(JSON.stringify({ port: 4321 }))
    expect(await resolveBridgeUrl(cwd)).toBe(`ws://localhost:5173${GENIE_WS_PATH}`)
  })

  it('removes a stale discovery file (dead pid) and falls through to the default', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    await writeDiscovery(
      JSON.stringify({ url: 'ws://127.0.0.1:4321/__genie/ws', port: 4321, pid: 999_999 }),
    )
    expect(await resolveBridgeUrl(cwd)).toBe(`ws://localhost:5173${GENIE_WS_PATH}`)
    expect(existsSync(join(cwd, GENIE_DISCOVERY_FILE))).toBe(false)
    expect(stderrSpy.mock.calls.flat().join('')).toContain('pid 999999 is gone')
    stderrSpy.mockRestore()
  })

  it('keeps a discovery file whose pid is alive', async () => {
    await writeDiscovery(
      JSON.stringify({ url: 'ws://127.0.0.1:4321/__genie/ws', port: 4321, pid: process.pid }),
    )
    expect(await resolveBridgeUrl(cwd)).toBe('ws://127.0.0.1:4321/__genie/ws')
    expect(existsSync(join(cwd, GENIE_DISCOVERY_FILE))).toBe(true)
  })

  it('trusts a discovery file that carries no pid at all', async () => {
    await writeDiscovery(JSON.stringify({ url: 'ws://127.0.0.1:4321/__genie/ws', port: 4321 }))
    expect(await resolveBridgeUrl(cwd)).toBe('ws://127.0.0.1:4321/__genie/ws')
  })

  it('labels the env override, the discovery file, and the default guess by source', async () => {
    process.env.GENIE_BRIDGE_URL = 'ws://override.example/socket'
    expect((await resolveBridge(cwd)).source).toBe('env')
    delete process.env.GENIE_BRIDGE_URL

    await writeDiscovery(JSON.stringify({ url: 'ws://127.0.0.1:4321/__genie/ws', port: 4321 }))
    expect(await resolveBridge(cwd)).toEqual({
      url: 'ws://127.0.0.1:4321/__genie/ws',
      source: 'file',
    })

    await rm(join(cwd, GENIE_DISCOVERY_FILE), { force: true })
    expect((await resolveBridge(cwd)).source).toBe('fallback')
  })
})

describe('isPidAlive', () => {
  it('reports the current process as alive and a bogus pid as gone', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(999_999)).toBe(false)
  })
})
