import { describe, expect, it } from 'vitest'
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
        ],
      }),
    ],
    socketFactory: () => socket,
  })
  return { socket, client }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('GenieClient', () => {
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

  it('rejects an unknown tool', async () => {
    const { socket, client } = setup()
    client.start()
    socket.open()
    socket.receive({ kind: 'bridge/request', id: 'r2', tool: 'nope', args: {} })
    await flush()

    const response = socket.decoded().find((m) => m.kind === 'app/response' && m.id === 'r2')
    expect(response.ok).toBe(false)
    expect(response.error).toContain('Unknown tool')
  })

  it('reports validation errors for bad arguments', async () => {
    const { socket, client } = setup()
    client.start()
    socket.open()
    socket.receive({ kind: 'bridge/request', id: 'r3', tool: 'echo', args: { message: 123 } })
    await flush()

    const response = socket.decoded().find((m) => m.kind === 'app/response' && m.id === 'r3')
    expect(response.ok).toBe(false)
  })
})
