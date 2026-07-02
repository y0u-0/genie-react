import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { decodeFrame, encodeMessage, newId } from '../protocol'
import { createStandaloneBridge, type StandaloneBridgeHandle } from './standalone'

// biome-ignore lint/suspicious/noExplicitAny: test harness deals in decoded wire frames
type Frame = any

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

// Attaches the inbox listener before `open` so the bridge's immediate status push is never missed.
async function open(url: string): Promise<{ ws: WebSocket; inbox: Inbox }> {
  const ws = new WebSocket(url)
  const inbox = new Inbox(ws)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return { ws, inbox }
}

class Inbox {
  private readonly received: Frame[] = []
  private readonly waiters: Array<{
    match: (m: Frame) => boolean
    resolve: (m: Frame) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  constructor(socket: WebSocket) {
    socket.on('message', (data) => {
      const message = decodeFrame(data.toString()) as Frame
      this.received.push(message)
      for (const waiter of [...this.waiters]) {
        if (waiter.match(message)) {
          clearTimeout(waiter.timer)
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          waiter.resolve(message)
        }
      }
    })
  }

  wait(match: (m: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const existing = this.received.find(match)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs)
      this.waiters.push({ match, resolve, timer })
    })
  }
}

const send = (socket: WebSocket, message: unknown) => socket.send(encodeMessage(message))
const isResult = (id: string) => (m: Frame) => m.kind === 'bridge/result' && m.id === id

describe('GenieBridge', () => {
  let handle: StandaloneBridgeHandle
  let url: string

  beforeEach(async () => {
    handle = createStandaloneBridge()
    url = (await handle.listen()).url
  })

  afterEach(async () => {
    await handle.close()
  })

  it('round-trips status, wait-for-connection, and a forwarded tool', async () => {
    const { ws: agent, inbox: agentInbox } = await open(`${url}?role=agent`)

    const initialStatus = await agentInbox.wait((m) => m.kind === 'bridge/status')
    expect(initialStatus.connected).toBe(false)

    const statusId = newId()
    send(agent, { kind: 'agent/invoke', id: statusId, tool: 'devtools_status', args: {} })
    const statusBefore = await agentInbox.wait(isResult(statusId))
    expect(statusBefore.ok).toBe(true)
    expect(statusBefore.result.connected).toBe(false)

    const waitId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: waitId,
      tool: 'devtools_wait',
      args: { condition: 'connected', timeoutMs: 4000 },
    })
    const pendingWait = agentInbox.wait(isResult(waitId), 5000)

    const app = await connect(`${url}?role=app`)
    app.on('message', (data) => {
      const message = decodeFrame(data.toString()) as Frame
      if (message.kind === 'bridge/request' && message.tool === 'echo') {
        send(app, {
          kind: 'app/response',
          id: message.id,
          ok: true,
          result: { echoed: message.args },
        })
      }
    })
    send(app, {
      kind: 'app/hello',
      protocol: 1,
      sessionId: 's-1',
      app: { name: 'demo', reactVersion: '19.0.0', tanstack: { query: '5.101.2' } },
      capabilities: ['react', 'query'],
      tools: [{ name: 'echo', title: 'Echo', description: 'echoes args', group: 'meta' }],
    })

    const waitResult = await pendingWait
    expect(waitResult.ok).toBe(true)
    expect(waitResult.result.ok).toBe(true)

    const echoId = newId()
    send(agent, { kind: 'agent/invoke', id: echoId, tool: 'echo', args: { hello: 'world' } })
    const echoResult = await agentInbox.wait(isResult(echoId))
    expect(echoResult.ok).toBe(true)
    expect(echoResult.result.echoed).toEqual({ hello: 'world' })

    const statusId2 = newId()
    send(agent, { kind: 'agent/invoke', id: statusId2, tool: 'devtools_status', args: {} })
    const statusAfter = await agentInbox.wait(isResult(statusId2))
    expect(statusAfter.result.connected).toBe(true)
    expect(statusAfter.result.app.name).toBe('demo')
    expect(statusAfter.result.toolCount).toBe(3) // 1 app tool + 2 meta tools (devtools_status/wait)
  })

  it('errors when forwarding a tool with no app connected', async () => {
    const { ws: agent, inbox } = await open(`${url}?role=agent`)
    await inbox.wait((m) => m.kind === 'bridge/status')

    const id = newId()
    send(agent, { kind: 'agent/invoke', id, tool: 'react_get_tree', args: {} })
    const result = await inbox.wait(isResult(id))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No app connected')
  })

  it('routes across multiple sessions and falls back when the current one closes', async () => {
    const { ws: agent, inbox } = await open(`${url}?role=agent`)

    const openApp = async (sessionId: string, tag: string) => {
      const app = await connect(`${url}?role=app`)
      app.on('message', (data) => {
        const message = decodeFrame(data.toString()) as Frame
        if (message.kind === 'bridge/request' && message.tool === 'whoami') {
          send(app, { kind: 'app/response', id: message.id, ok: true, result: { from: tag } })
        }
      })
      send(app, {
        kind: 'app/hello',
        protocol: 1,
        sessionId,
        app: { name: tag },
        capabilities: ['react'],
        tools: [{ name: 'whoami', title: 'Who am I', description: 'session tag', group: 'meta' }],
      })
      return app
    }

    await openApp('tab-a', 'A')
    const appB = await openApp('tab-b', 'B')
    await inbox.wait((m) => m.kind === 'bridge/status' && m.sessions?.length === 2)

    const statusId = newId()
    send(agent, { kind: 'agent/invoke', id: statusId, tool: 'devtools_status', args: {} })
    const status = await inbox.wait(isResult(statusId))
    expect(status.result.sessions).toHaveLength(2)
    expect(status.result.sessions.find((s: Frame) => s.sessionId === 'tab-b').current).toBe(true)
    expect(status.result.sessionId).toBe('tab-b')

    const defaultId = newId()
    send(agent, { kind: 'agent/invoke', id: defaultId, tool: 'whoami', args: {} })
    expect((await inbox.wait(isResult(defaultId))).result.from).toBe('B')

    const targetedId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: targetedId,
      tool: 'whoami',
      args: {},
      sessionId: 'tab-a',
    })
    expect((await inbox.wait(isResult(targetedId))).result.from).toBe('A')

    const unknownId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: unknownId,
      tool: 'whoami',
      args: {},
      sessionId: 'tab-zzz',
    })
    const unknown = await inbox.wait(isResult(unknownId))
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toContain('Unknown session "tab-zzz"')
    expect(unknown.error).toContain('tab-a')

    const targetedStatusId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: targetedStatusId,
      tool: 'devtools_status',
      args: {},
      sessionId: 'tab-a',
    })
    const targetedStatus = await inbox.wait(isResult(targetedStatusId))
    expect(targetedStatus.result.sessionId).toBe('tab-a')
    expect(targetedStatus.result.app.name).toBe('A')
    expect(targetedStatus.result.sessions).toHaveLength(2)

    const unknownStatusId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: unknownStatusId,
      tool: 'devtools_status',
      args: {},
      sessionId: 'tab-zzz',
    })
    const unknownStatus = await inbox.wait(isResult(unknownStatusId))
    expect(unknownStatus.ok).toBe(false)
    expect(unknownStatus.error).toContain('Unknown session "tab-zzz"')

    appB.close()
    // Poll via request/response — a broadcast matcher could match the pre-tab-b status from history.
    let statusAfter: Frame
    for (let attempt = 0; attempt < 40; attempt++) {
      const pollId = newId()
      send(agent, { kind: 'agent/invoke', id: pollId, tool: 'devtools_status', args: {} })
      statusAfter = (await inbox.wait(isResult(pollId))).result
      if (statusAfter.sessionId === 'tab-a' && statusAfter.sessions.length === 1) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(statusAfter.sessionId).toBe('tab-a')
    expect(statusAfter.sessions).toHaveLength(1)

    const fallbackId = newId()
    send(agent, { kind: 'agent/invoke', id: fallbackId, tool: 'whoami', args: {} })
    expect((await inbox.wait(isResult(fallbackId))).result.from).toBe('A')
  })

  it('re-hello on a new socket fails in-flight requests and refreshes session recency', async () => {
    const { ws: agent, inbox } = await open(`${url}?role=agent`)

    const appHello = (name: string) => ({
      kind: 'app/hello',
      protocol: 1,
      sessionId: 's-r',
      app: { name },
      capabilities: ['react'],
      tools: [{ name: 'slow', title: 'Slow', description: 'never responds', group: 'meta' }],
    })

    const firstSocket = await connect(`${url}?role=app`)
    send(firstSocket, appHello('first'))
    await inbox.wait((m) => m.kind === 'bridge/status' && m.connected === true)

    const slowId = newId()
    send(agent, { kind: 'agent/invoke', id: slowId, tool: 'slow', args: {} })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const secondSocket = await connect(`${url}?role=app`)
    send(secondSocket, appHello('second'))

    const failed = await inbox.wait(isResult(slowId))
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('reconnected')

    const statusId = newId()
    send(agent, { kind: 'agent/invoke', id: statusId, tool: 'devtools_status', args: {} })
    const status = await inbox.wait(isResult(statusId))
    expect(status.result.sessions).toHaveLength(1)
    expect(status.result.app.name).toBe('second')
    expect(status.result.sessions[0].current).toBe(true)
  })

  it('times out a forwarded tool when the app never responds', async () => {
    const fastHandle = createStandaloneBridge({ requestTimeoutMs: 150 })
    const fastUrl = (await fastHandle.listen()).url
    try {
      const app = await connect(`${fastUrl}?role=app`)
      send(app, {
        kind: 'app/hello',
        protocol: 1,
        sessionId: 's-2',
        app: { name: 'silent' },
        capabilities: [],
        tools: [],
      })
      const { ws: agent, inbox } = await open(`${fastUrl}?role=agent`)
      const id = newId()
      send(agent, { kind: 'agent/invoke', id, tool: 'never_responds', args: {} })
      const result = await inbox.wait(isResult(id))
      expect(result.ok).toBe(false)
      expect(result.error).toContain('timed out')
    } finally {
      await fastHandle.close()
    }
  })
})
