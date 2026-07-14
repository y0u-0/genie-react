import { createStandaloneBridge } from 'genie-react/hub'
import { decodeFrame, encodeMessage } from 'genie-react/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { runBatch, runCall, runTools } from './agent'

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

  it('applies nested projection to tool discovery and every successful batch item', async () => {
    const bridge = createStandaloneBridge()
    cleanups.push(() => bridge.close())
    const { url } = await bridge.listen()
    const app = new WebSocket(`${url}?role=app`)
    cleanups.push(() => app.close())
    await new Promise<void>((resolve, reject) => {
      app.once('open', () => resolve())
      app.once('error', reject)
    })
    app.on('message', (data) => {
      const message = decodeFrame(data.toString()) as {
        kind?: string
        id?: string
        tool?: string
      }
      if (message.kind !== 'bridge/request' || message.tool !== 'query_nested') return
      app.send(
        encodeMessage({
          kind: 'app/response',
          id: message.id,
          ok: true,
          result: { nested: { value: 42 }, discarded: { large: 'x'.repeat(1_000) } },
        }),
      )
    })
    app.send(
      encodeMessage({
        kind: 'app/hello',
        protocol: 1,
        sessionId: 'projection-session',
        app: { name: 'projection demo' },
        capabilities: ['query'],
        tools: [
          {
            name: 'query_nested',
            title: 'Nested query result',
            description: 'Returns nested output.',
            group: 'query',
          },
        ],
      }),
    )
    app.send(encodeMessage({ kind: 'app/ready', sessionId: 'projection-session' }))
    await waitUntil(() => bridge.bridge.getStatus().ready)

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(
      await runTools('query', {
        url,
        select: '[*].name',
        waitMs: 1_000,
      }),
    ).toBe(0)
    const toolProjection = JSON.parse(stdout.mock.calls.flat().join(''))
    expect(toolProjection).toMatchObject({
      status: 'ok',
      selection: { matchedPathCount: 1 },
      result: 'query_nested',
    })

    stdout.mockClear()
    expect(
      await runBatch('[{"tool":"query_nested","args":{}}]', {
        url,
        json: true,
        select: '/nested/value',
        maxBytes: 2_000,
        waitMs: 1_000,
      }),
    ).toBe(0)
    const batch = JSON.parse(stdout.mock.calls.flat().join(''))
    expect(batch[0]).toMatchObject({
      tool: 'query_nested',
      ok: true,
      result: {
        status: 'ok',
        selection: { matchedPathCount: 1, omittedPathCount: 1 },
        result: 42,
      },
    })

    stdout.mockClear()
    expect(
      await runBatch('[{"tool":"query_nested"},{"tool":"query_nested"},{"tool":"query_nested"}]', {
        url,
        ndjson: true,
        maxBytes: 512,
        waitMs: 1_000,
      }),
    ).toBe(0)
    const boundedBatch = stdout.mock.calls.flat().join('')
    expect(Buffer.byteLength(boundedBatch, 'utf8')).toBeLessThanOrEqual(512)
    expect(JSON.parse(boundedBatch)).toMatchObject({
      status: 'truncated',
      reason: 'max-bytes',
      maxBytes: 512,
    })
    expect(stderr.mock.calls.flat().join('')).toBe('')
  })

  it('can make an unmet wait result fail the process contract', async () => {
    const bridge = createStandaloneBridge()
    cleanups.push(() => bridge.close())
    const { url } = await bridge.listen()
    const app = new WebSocket(`${url}?role=app`)
    cleanups.push(() => app.close())
    await new Promise<void>((resolve, reject) => {
      app.once('open', () => resolve())
      app.once('error', reject)
    })
    app.on('message', (data) => {
      const message = decodeFrame(data.toString()) as {
        kind?: string
        id?: string
        tool?: string
      }
      if (message.kind !== 'bridge/request' || message.tool !== 'react_find_components') return
      app.send(
        encodeMessage({
          kind: 'app/response',
          id: message.id,
          ok: true,
          result: { matches: [] },
        }),
      )
    })
    app.send(
      encodeMessage({
        kind: 'app/hello',
        protocol: 1,
        sessionId: 'wait-session',
        app: { name: 'wait demo' },
        capabilities: ['react'],
        tools: [
          {
            name: 'react_find_components',
            title: 'Find components',
            description: 'Find components.',
            group: 'react.tree',
          },
        ],
      }),
    )
    app.send(encodeMessage({ kind: 'app/ready', sessionId: 'wait-session' }))
    await waitUntil(() => bridge.bridge.getStatus().ready)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const exitCode = await runCall(
      'devtools_wait',
      JSON.stringify({ condition: 'component', name: 'Missing', timeoutMs: 100 }),
      { url, json: true, failOnResultError: true },
    )

    expect(exitCode).toBe(1)
    expect(JSON.parse(stdout.mock.calls.flat().join(''))).toMatchObject({
      ok: false,
      condition: 'component',
      reason: 'timeout',
      validConditions: expect.arrayContaining(['react-quiet', 'settled']),
      lastObserved: { matches: 0 },
    })
  })
})
