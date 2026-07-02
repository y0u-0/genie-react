import { createServer, type Server } from 'node:http'
import { GENIE_WS_PATH } from '@genie-react/core'
import { GenieBridge, type GenieBridgeOptions } from './bridge'

export interface StandaloneBridgeHandle {
  bridge: GenieBridge
  server: Server
  listen: (port?: number, host?: string) => Promise<{ port: number; host: string; url: string }>
  close: () => Promise<void>
}

/** Runs the hub on its own HTTP server (tests, non-Vite deployments); production embeds it via `@genie-react/vite`. */
export function createStandaloneBridge(options?: GenieBridgeOptions): StandaloneBridgeHandle {
  const bridge = new GenieBridge(options)
  const server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('Genie bridge: WebSocket only')
  })
  server.on('upgrade', (request, socket, head) => {
    if (!bridge.handleUpgrade(request, socket, head)) socket.destroy()
  })

  return {
    bridge,
    server,
    listen: (port = 0, host = '127.0.0.1') =>
      new Promise((resolve, reject) => {
        server.listen(port, host, () => {
          const address = server.address()
          if (address === null || typeof address === 'string') {
            reject(new Error('bridge not bound to a TCP port'))
            return
          }
          resolve({ port: address.port, host, url: `ws://${host}:${address.port}${GENIE_WS_PATH}` })
        })
      }),
    close: () =>
      new Promise((resolve) => {
        bridge.close()
        server.close(() => resolve())
      }),
  }
}
