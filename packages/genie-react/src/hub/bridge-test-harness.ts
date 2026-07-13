import { WebSocket } from 'ws'
import { decodeFrame, encodeMessage } from '../protocol'

// biome-ignore lint/suspicious/noExplicitAny: test harness deals in decoded wire frames
export type Frame = any

export function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/** Attaches the inbox before `open`, so the bridge's immediate status push cannot be missed. */
export async function open(url: string): Promise<{ ws: WebSocket; inbox: Inbox }> {
  const ws = new WebSocket(url)
  const inbox = new Inbox(ws)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return { ws, inbox }
}

export class Inbox {
  private readonly received: Frame[] = []
  private readonly waiters: Array<{
    match: (message: Frame) => boolean
    resolve: (message: Frame) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  constructor(socket: WebSocket) {
    socket.on('message', (data) => {
      const message = decodeFrame(data.toString()) as Frame
      this.received.push(message)
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(message)) continue
        clearTimeout(waiter.timer)
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      }
    })
  }

  wait(match: (message: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const existing = this.received.find(match)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs)
      this.waiters.push({ match, resolve, timer })
    })
  }
}

export const send = (socket: WebSocket, message: unknown): void =>
  socket.send(encodeMessage(message))
export const isResult =
  (id: string) =>
  (message: Frame): boolean =>
    message.kind === 'bridge/result' && message.id === id
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))
