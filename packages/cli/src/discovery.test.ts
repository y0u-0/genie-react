import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GENIE_DISCOVERY_FILE, GENIE_WS_PATH } from 'genie-react/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBridgeUrl } from './discovery'

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
})
