import { createStandaloneBridge, type StandaloneBridgeHandle } from 'genie-react/hub'
import { decodeFrame, encodeMessage } from 'genie-react/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { GenieAgentLink, type GenieAgentLinkOptions } from './agent-link'

// biome-ignore lint/suspicious/noExplicitAny: test harness deals in decoded wire frames
type Frame = any

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 4000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(intervalMs)
  }
  throw new Error('waitUntil timed out')
}

describe('GenieAgentLink', () => {
  const cleanups: Array<() => void | Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    cleanups.length = 0
  })

  async function makeBridge(
    options?: Parameters<typeof createStandaloneBridge>[0],
  ): Promise<{ handle: StandaloneBridgeHandle; url: string }> {
    const handle = createStandaloneBridge(options)
    const { url } = await handle.listen()
    cleanups.push(() => handle.close())
    return { handle, url }
  }

  function makeLink(options: GenieAgentLinkOptions): GenieAgentLink {
    const link = new GenieAgentLink(options)
    cleanups.push(() => link.close())
    return link
  }

  function connectApp(
    url: string,
    respond?: (socket: WebSocket, request: Frame) => void,
  ): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${url}?role=app`)
      cleanups.push(() => socket.close())
      socket.on('message', (data) => {
        const message = decodeFrame(data.toString()) as Frame
        if (message.kind === 'bridge/request') respond?.(socket, message)
      })
      socket.once('error', reject)
      socket.once('open', () => {
        socket.send(
          encodeMessage({
            kind: 'app/hello',
            protocol: 1,
            sessionId: 's-1',
            app: { name: 'demo' },
            capabilities: ['react'],
            tools: [],
          }),
        )
        resolve(socket)
      })
    })
  }

  const echo = (socket: WebSocket, request: Frame) =>
    socket.send(
      encodeMessage({
        kind: 'app/response',
        id: request.id,
        ok: true,
        result: { echoed: request.args },
      }),
    )

  it('resolves invoke() with a forwarded tool result', async () => {
    const { handle, url } = await makeBridge()
    await connectApp(url, echo)
    await waitUntil(() => handle.bridge.getStatus().connected)

    const link = makeLink({ url })
    link.start()

    const result = (await link.invoke('echo', { hello: 'world' })) as { echoed: unknown }
    expect(result.echoed).toEqual({ hello: 'world' })
  })

  it('rejects invoke() when the bridge reports ok:false', async () => {
    const { url } = await makeBridge()
    const link = makeLink({ url })
    link.start()

    await expect(link.invoke('react_get_tree', {})).rejects.toThrow(/No app connected/)
  })

  it('rejects invoke() after invokeTimeoutMs when the app never responds', async () => {
    const { handle, url } = await makeBridge({ requestTimeoutMs: 10_000 })
    await connectApp(url) // no responder: requests hang
    await waitUntil(() => handle.bridge.getStatus().connected)

    const link = makeLink({ url, invokeTimeoutMs: 200 })
    link.start()

    await expect(link.invoke('slow_tool', {})).rejects.toThrow(/did not respond.*200ms/)
  })

  it('reconnects after the socket closes and heals onto a new bridge', async () => {
    const first = await makeBridge()
    let currentUrl = first.url
    const link = makeLink({ url: () => currentUrl, reconnectDelayMs: 25, connectTimeoutMs: 2000 })
    link.start()

    await connectApp(first.url, echo)
    await waitUntil(() => first.handle.bridge.getStatus().connected)
    const initial = (await link.invoke('echo', { first: true })) as { echoed: unknown }
    expect(initial.echoed).toEqual({ first: true })

    await first.handle.close()

    const second = await makeBridge()
    currentUrl = second.url
    await connectApp(second.url, echo)
    await waitUntil(() => second.handle.bridge.getStatus().connected)

    const result = (await link.invoke('echo', { healed: true })) as { echoed: unknown }
    expect(result.echoed).toEqual({ healed: true })
  })

  it('close() rejects pending invocations', async () => {
    const { handle, url } = await makeBridge({ requestTimeoutMs: 10_000 })
    await connectApp(url) // no responder
    await waitUntil(() => handle.bridge.getStatus().connected)

    const link = makeLink({ url })
    link.start()

    const pending = link.invoke('slow_tool', {})
    await delay(50)
    const assertion = expect(pending).rejects.toThrow(/agent link closed/)
    link.close()
    await assertion
  })
})
