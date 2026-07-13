import { createStandaloneBridge } from 'genie-react/hub'
import { encodeMessage } from 'genie-react/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { runTools } from './agent'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error('waitUntil timed out')
}

describe('agent CLI integration', () => {
  const cleanups: Array<() => void | Promise<void>> = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const cleanup of cleanups.reverse()) await cleanup()
    cleanups.length = 0
  })

  it('returns a schema-versioned JSON failure for an unknown tool in --json mode', async () => {
    const bridge = createStandaloneBridge()
    cleanups.push(() => bridge.close())
    const { url } = await bridge.listen()

    const app = new WebSocket(`${url}?role=app`)
    cleanups.push(() => app.close())
    await new Promise<void>((resolve, reject) => {
      app.once('open', () => resolve())
      app.once('error', reject)
    })
    app.send(
      encodeMessage({
        kind: 'app/hello',
        protocol: 1,
        sessionId: 'session-1',
        app: { name: 'demo' },
        capabilities: ['query'],
        tools: [
          {
            name: 'query_list',
            title: 'List queries',
            description: 'List Query cache entries.',
            group: 'query',
          },
        ],
      }),
    )
    app.send(encodeMessage({ kind: 'app/ready', sessionId: 'session-1' }))
    await waitUntil(() => bridge.bridge.getStatus().ready)

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitCode = await runTools('missing_tool', { url, json: true, waitMs: 1_000 })

    expect(exitCode).toBe(1)
    expect(stderr.mock.calls.flat().join('')).toBe('')
    expect(JSON.parse(stdout.mock.calls.flat().join(''))).toEqual({
      schemaVersion: '1.0',
      status: 'error',
      reason: 'invalid_input',
      message: 'Unknown tool or group "missing_tool". Groups: meta, query',
      userActionRequired: true,
      next: {
        command: 'genie-react tools',
        argv: ['genie-react', 'tools'],
      },
    })
  })
})
