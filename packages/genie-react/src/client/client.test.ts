import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { decodeFrame, defineAgentToolContract, encodeMessage } from '../protocol'
import { createGenieClient, type SocketLike } from './client'
import { defineCollector, defineCollectorTool } from './collector'

// biome-ignore lint/suspicious/noExplicitAny: tests inspect decoded wire frames
type Frame = any

class FakeSocket implements SocketLike {
  readyState = 0
  readonly sent: string[] = []
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
    this.onclose?.(null)
  }
  open(): void {
    this.readyState = 1
    this.onopen?.(null)
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: encodeMessage(message) })
  }
  decoded(): Frame[] {
    return this.sent.map((raw) => decodeFrame(raw))
  }
}

const echoContract = defineAgentToolContract({
  name: 'echo',
  title: 'Echo',
  description: 'Echoes its message back',
  group: 'meta',
  input: z.object({ message: z.string() }),
  output: z.object({ echoed: z.string() }),
  annotations: { readOnlyHint: true },
})

const findContract = defineAgentToolContract({
  name: 'find',
  title: 'Find',
  description: 'Finds by query',
  group: 'meta',
  input: z.object({ query: z.string() }),
  output: z.object({ found: z.string() }),
  annotations: { readOnlyHint: true },
})

function setup() {
  const socket = new FakeSocket()
  const client = createGenieClient({
    appName: 'test-app',
    collectors: [
      defineCollector({
        meta: { id: 'echo', title: 'Echo' },
        capabilities: ['echo'],
        tools: [
          defineCollectorTool({
            contract: echoContract,
            handler: ({ message }) => ({ echoed: message }),
          }),
          defineCollectorTool({
            contract: findContract,
            handler: ({ query }) => ({ found: query }),
          }),
        ],
      }),
    ],
    socketFactory: () => socket,
  })
  return { socket, client }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('GenieClient', () => {
  it('announces document lineage and becomes ready only after collector startup', () => {
    const socket = new FakeSocket()
    const client = createGenieClient({
      appName: 'lineage-app',
      sessionName: 'review-a',
      sessionIdentity: { logicalSessionId: 'logical-a', documentGeneration: 3 },
      collectors: [
        defineCollector({
          meta: { id: 'startup', title: 'Startup' },
          start: (ctx) => ctx.pushSnapshot('startup', { initialized: true }),
        }),
      ],
      socketFactory: () => socket,
    })

    client.start()
    socket.open()

    const frames = socket.decoded()
    expect(frames.map((frame) => frame.kind)).toEqual(['app/hello', 'app/snapshot', 'app/ready'])
    expect(frames[0]).toMatchObject({
      logicalSessionId: 'logical-a',
      documentGeneration: 3,
      sessionName: 'review-a',
    })
    expect(frames[2].sessionId).toBe(frames[0].sessionId)
    client.stop()
  })

  it('accepts a collision fork only for its current identity and re-announces readiness', () => {
    const socket = new FakeSocket()
    const identity = { logicalSessionId: 'cloned-logical', documentGeneration: 4 }
    const client = createGenieClient({
      appName: 'cloned app',
      sessionIdentity: identity,
      collectors: [],
      socketFactory: () => socket,
    })
    client.start()
    socket.open()

    socket.receive({
      kind: 'bridge/session-fork',
      expectedLogicalSessionId: 'stale-logical',
      logicalSessionId: 'ignored-logical',
      documentGeneration: 1,
      reason: 'logical-session-collision',
      collisionWithSessionIds: ['other'],
    })
    socket.receive({
      kind: 'bridge/session-fork',
      expectedLogicalSessionId: 'cloned-logical',
      logicalSessionId: 'forked-logical',
      documentGeneration: 1,
      reason: 'logical-session-collision',
      collisionWithSessionIds: ['other'],
    })

    const frames = socket.decoded()
    const hellos = frames.filter((frame) => frame.kind === 'app/hello')
    expect(hellos).toHaveLength(2)
    expect(hellos[1]).toMatchObject({
      logicalSessionId: 'forked-logical',
      documentGeneration: 1,
    })
    expect(frames.filter((frame) => frame.kind === 'app/ready')).toHaveLength(2)
    expect(identity).toEqual({ logicalSessionId: 'forked-logical', documentGeneration: 1 })
    client.stop()
  })

  it('announces app info and tool descriptors on connect', () => {
    const { socket, client } = setup()
    client.start()
    socket.open()

    const hello = socket.decoded().find((m) => m.kind === 'app/hello')
    expect(hello).toBeTruthy()
    expect(hello.app.name).toBe('test-app')
    expect(hello.capabilities).toContain('echo')
    const echo = hello.tools.find((tool: Frame) => tool.name === 'echo')
    expect(echo.group).toBe('meta')
    expect(echo.inputJsonSchema).toBeTruthy()
    expect(echo.annotations.readOnlyHint).toBe(true)
  })

  it('keeps the initial document title as the app name across later hellos', () => {
    vi.stubGlobal('document', { title: 'Stable app name' })
    try {
      const socket = new FakeSocket()
      const client = createGenieClient({ collectors: [], socketFactory: () => socket })
      client.start()
      socket.open()

      document.title = 'Live counter · 1'
      client.registerCollector(
        defineCollector({ meta: { id: 'late', title: 'Late collector' }, capabilities: ['late'] }),
      )

      const hellos = socket.decoded().filter((message) => message.kind === 'app/hello')
      expect(hellos).toHaveLength(2)
      expect(hellos.map((hello) => hello.app.name)).toEqual(['Stable app name', 'Stable app name'])
      client.stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('replaces a collector with the same id without leaving stale tools or subscriptions', async () => {
    const socket = new FakeSocket()
    const firstCleanup = vi.fn()
    const replacementCleanup = vi.fn()
    const first = defineCollector({
      meta: { id: 'replaceable', title: 'First' },
      capabilities: ['first'],
      start: () => firstCleanup,
      tools: [
        defineCollectorTool({
          contract: echoContract,
          handler: ({ message }) => ({ echoed: `first:${message}` }),
        }),
      ],
    })
    const replacement = defineCollector({
      meta: { id: 'replaceable', title: 'Replacement' },
      capabilities: ['replacement'],
      start: () => replacementCleanup,
      tools: [
        defineCollectorTool({
          contract: echoContract,
          handler: ({ message }) => ({ echoed: `replacement:${message}` }),
        }),
      ],
    })
    const client = createGenieClient({ collectors: [first], socketFactory: () => socket })

    client.start()
    socket.open()
    client.registerCollector(replacement)
    socket.receive({
      kind: 'bridge/request',
      id: 'replacement-call',
      tool: 'echo',
      args: { message: 'ok' },
    })
    await flush()

    expect(firstCleanup).toHaveBeenCalledOnce()
    const hello = socket
      .decoded()
      .filter((message) => message.kind === 'app/hello')
      .at(-1)
    expect(hello.capabilities).not.toContain('first')
    expect(hello.capabilities).toContain('replacement')
    const response = socket
      .decoded()
      .find((message) => message.kind === 'app/response' && message.id === 'replacement-call')
    expect(response.result).toEqual({ echoed: 'replacement:ok' })

    client.stop()
    expect(replacementCleanup).toHaveBeenCalledOnce()
  })

  it('runs a forwarded tool and replies with the result', async () => {
    const { socket, client } = setup()
    client.start()
    socket.open()
    socket.receive({ kind: 'bridge/request', id: 'r1', tool: 'echo', args: { message: 'hi' } })
    await flush()

    const response = socket.decoded().find((m) => m.kind === 'app/response' && m.id === 'r1')
    expect(response.ok).toBe(true)
    expect(response.result).toEqual({ echoed: 'hi' })
  })

  it('rejects an unknown tool and names the advertised domains', async () => {
    const { socket, client } = setup()
    client.start()
    socket.open()
    socket.receive({ kind: 'bridge/request', id: 'r2', tool: 'nope', args: {} })
    await flush()

    const response = socket.decoded().find((m) => m.kind === 'app/response' && m.id === 'r2')
    expect(response.ok).toBe(false)
    expect(response.error).toContain('Unknown tool')
    expect(response.error).toContain('echo')
  })

  it('explains that query tools are gated on a discovered QueryClient', async () => {
    const { socket, client } = setup()
    client.start()
    socket.open()
    socket.receive({ kind: 'bridge/request', id: 'r5', tool: 'query_list', args: {} })
    await flush()

    const response = socket.decoded().find((m) => m.kind === 'app/response' && m.id === 'r5')
    expect(response.ok).toBe(false)
    expect(response.error).toContain('QueryClient')
  })

  it('reports validation errors for bad arguments with the failing key', async () => {
    const { socket, client } = setup()
    client.start()
    socket.open()
    socket.receive({ kind: 'bridge/request', id: 'r3', tool: 'echo', args: { message: 123 } })
    await flush()

    const response = socket.decoded().find((m) => m.kind === 'app/response' && m.id === 'r3')
    expect(response.ok).toBe(false)
    expect(response.error).toContain('Invalid arguments for "echo"')
    expect(response.error).toContain('/message:')
    expect(response.errorCode).toBe('invalid-args')
  })

  it('remaps component/query/name aliases onto the schema key the tool wants', async () => {
    const { socket, client } = setup()
    client.start()
    socket.open()
    socket.receive({ kind: 'bridge/request', id: 'r6', tool: 'find', args: { component: 'Lock' } })
    await flush()

    const response = socket.decoded().find((m) => m.kind === 'app/response' && m.id === 'r6')
    expect(response.ok).toBe(true)
    expect(response.result).toEqual({ found: 'Lock' })
  })

  it('rejects unrecognized argument keys instead of silently stripping them', async () => {
    const { socket, client } = setup()
    client.start()
    socket.open()
    socket.receive({
      kind: 'bridge/request',
      id: 'r4',
      tool: 'echo',
      args: { message: 'hi', maxDepth: 2 },
    })
    await flush()

    const response = socket.decoded().find((m) => m.kind === 'app/response' && m.id === 'r4')
    expect(response.ok).toBe(false)
    expect(response.error).toContain('Unknown argument "maxDepth"')
    expect(response.error).toContain('valid keys: message')
    expect(response.errorCode).toBe('invalid-args')
  })

  describe('heartbeat', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('emits app/heartbeat on a 1s cadence while the socket is open, then stops on close', () => {
      vi.useFakeTimers()
      const { socket, client } = setup()
      client.start()
      socket.open()

      const heartbeats = () => socket.decoded().filter((m) => m.kind === 'app/heartbeat')
      expect(heartbeats()).toHaveLength(0)

      vi.advanceTimersByTime(3_000)
      const afterOpen = heartbeats()
      expect(afterOpen).toHaveLength(3)
      expect(afterOpen[0].sessionId).toBe(afterOpen[1].sessionId)

      socket.close()
      vi.advanceTimersByTime(5_000)
      expect(heartbeats()).toHaveLength(3)
    })

    it('stops the heartbeat when the client is stopped', () => {
      vi.useFakeTimers()
      const { socket, client } = setup()
      client.start()
      socket.open()
      vi.advanceTimersByTime(1_000)
      const before = socket.decoded().filter((m) => m.kind === 'app/heartbeat').length
      expect(before).toBe(1)

      client.stop()
      vi.advanceTimersByTime(5_000)
      expect(socket.decoded().filter((m) => m.kind === 'app/heartbeat')).toHaveLength(before)
    })

    it('pumps a throttled heartbeat on commit activity even while the interval timer is starved', () => {
      vi.useFakeTimers()
      const commits: { pump: () => void } = { pump: () => {} }
      const socket = new FakeSocket()
      const client = createGenieClient({
        appName: 'saturated',
        collectors: [
          defineCollector({
            meta: { id: 'commits', title: 'Commits' },
            start: (ctx) => {
              commits.pump = ctx.markActivity
            },
          }),
        ],
        socketFactory: () => socket,
      })
      client.start()
      socket.open()
      const heartbeats = () => socket.decoded().filter((m) => m.kind === 'app/heartbeat')
      expect(heartbeats()).toHaveLength(0)

      // A commit sends immediately; a burst is throttled to at most one per interval.
      commits.pump()
      commits.pump()
      commits.pump()
      expect(heartbeats()).toHaveLength(1)

      // Wall-clock advances but the macrotask interval never fires (a saturated event loop); a commit still keeps liveness flowing.
      vi.setSystemTime(Date.now() + 5_000)
      commits.pump()
      expect(heartbeats()).toHaveLength(2)
    })
  })
})
