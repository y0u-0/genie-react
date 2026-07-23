// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createGenieClient } from '../client/client'
import { GENIE_GLOBAL_KEY } from '../protocol'
import { FakeSocket, type Frame, flush, lastHello, lastResponse } from '../test-support/fake-socket'
import { defineGenieTool, GenieToolError } from './define'
import { registerGenieTools, resetGenieAppToolsForTests } from './registry'

function startClient() {
  const socket = new FakeSocket()
  const client = createGenieClient({
    appName: 'test-app',
    collectors: [],
    socketFactory: () => socket,
  })
  client.start()
  socket.open()
  return { socket, client }
}

function seedCartTool(
  handler: (args: { count: number }) => unknown = ({ count }) => ({ added: count }),
) {
  return defineGenieTool({
    name: 'seed_cart',
    description: 'Fills the cart with sample items so checkout flows can be tested end to end.',
    kind: 'action',
    input: z.object({ count: z.number().int().min(1).max(50).default(3) }),
    handler,
  })
}

function advertisedTool(socket: FakeSocket, name: string): Frame {
  return lastHello(socket)?.tools.find((entry: Frame) => entry.name === name)
}

afterEach(() => {
  resetGenieAppToolsForTests()
  globalThis[GENIE_GLOBAL_KEY] = undefined
  vi.restoreAllMocks()
})

describe('registerGenieTools', () => {
  it('advertises a tool registered after the client started', async () => {
    const { socket } = startClient()
    registerGenieTools(seedCartTool())
    await flush()

    const tool = advertisedTool(socket, 'app_seed_cart')
    expect(tool).toBeTruthy()
    expect(tool.group).toBe('app')
    expect(tool.available).toBeUndefined()
    expect(lastHello(socket).capabilities).toContain('app')
  })

  it('registers a tool queued before any client exists once one starts (bounded retry)', async () => {
    registerGenieTools(seedCartTool())
    const { socket } = startClient()

    await vi.waitFor(() => {
      expect(advertisedTool(socket, 'app_seed_cart')).toBeTruthy()
    })
  })

  it('re-registers with a NEW client that replaced the old one', async () => {
    const first = startClient()
    registerGenieTools(seedCartTool())
    await flush()
    expect(advertisedTool(first.socket, 'app_seed_cart')).toBeTruthy()

    const second = startClient()
    registerGenieTools(
      defineGenieTool({
        name: 'second_tool',
        description: 'Registered after a fresh client replaced the original one in this test.',
        kind: 'query',
        handler: () => ({ ok: true }),
      }),
    )
    await flush()

    expect(advertisedTool(second.socket, 'app_seed_cart')).toBeTruthy()
    expect(advertisedTool(second.socket, 'app_second_tool')).toBeTruthy()
  })

  it('runs the handler with parsed args (defaults applied)', async () => {
    const { socket } = startClient()
    registerGenieTools(seedCartTool())
    await flush()
    socket.receive({ kind: 'bridge/request', id: 'r1', tool: 'app_seed_cart', args: {} })
    await flush()

    const response = lastResponse(socket, 'r1')
    expect(response.ok).toBe(true)
    expect(response.result).toEqual({ added: 3 })
  })

  it('rejects invalid args with per-field issues before the handler runs', async () => {
    const { socket } = startClient()
    const handler = vi.fn()
    registerGenieTools(seedCartTool(handler))
    await flush()
    socket.receive({
      kind: 'bridge/request',
      id: 'r2',
      tool: 'app_seed_cart',
      args: { count: 999 },
    })
    await flush()

    const response = lastResponse(socket, 'r2')
    expect(response.ok).toBe(false)
    expect(response.errorCode).toBe('invalid-args')
    expect(response.error).toContain('count')
    expect(handler).not.toHaveBeenCalled()
  })

  it('tombstones an unregistered tool: still listed, unavailable, with a recovery hint', async () => {
    const { socket } = startClient()
    const unregister = registerGenieTools(seedCartTool())
    unregister()
    await flush()

    const tool = advertisedTool(socket, 'app_seed_cart')
    expect(tool.available).toBe(false)
    expect(tool.unavailableReason).toContain('not mounted')

    socket.receive({ kind: 'bridge/request', id: 'r3', tool: 'app_seed_cart', args: {} })
    await flush()
    const response = lastResponse(socket, 'r3')
    expect(response.ok).toBe(false)
    expect(response.errorCode).toBe('tool-unavailable')
    expect(response.error).toContain('currently unavailable')
  })

  it('revives a tombstoned tool on re-registration', async () => {
    const { socket } = startClient()
    registerGenieTools(seedCartTool())()
    registerGenieTools(seedCartTool())
    await flush()

    expect(advertisedTool(socket, 'app_seed_cart').available).toBeUndefined()

    socket.receive({ kind: 'bridge/request', id: 'r4', tool: 'app_seed_cart', args: { count: 2 } })
    await flush()
    expect(lastResponse(socket, 'r4').result).toEqual({ added: 2 })
  })

  it('keeps a tool active through overlapping registrations (refcount)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { socket } = startClient()
    const first = registerGenieTools(seedCartTool())
    const second = registerGenieTools(seedCartTool())
    first()
    await flush()

    expect(advertisedTool(socket, 'app_seed_cart').available).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registered more than once'))

    second()
    await flush()
    expect(advertisedTool(socket, 'app_seed_cart').available).toBe(false)
  })

  it('coalesces several registrations in one tick into one catalog refresh', async () => {
    const { socket } = startClient()
    const before = socket.decoded().filter((frame) => frame.kind === 'app/hello').length

    registerGenieTools(seedCartTool())
    registerGenieTools(
      defineGenieTool({
        name: 'flags',
        description: 'Reads the demo feature flags; exists to test refresh coalescing.',
        kind: 'query',
        handler: () => ({}),
      }),
    )
    await flush()

    const after = socket.decoded().filter((frame) => frame.kind === 'app/hello').length
    // One refresh hello for both registrations; the collector registration itself sends one more.
    expect(after - before).toBeLessThanOrEqual(2)
    expect(advertisedTool(socket, 'app_flags')).toBeTruthy()
    expect(advertisedTool(socket, 'app_seed_cart')).toBeTruthy()
  })

  it('passes GenieToolError messages through and wraps foreign throws with provenance', async () => {
    const { socket } = startClient()
    registerGenieTools(
      defineGenieTool({
        name: 'checkout',
        description: 'Runs the demo checkout flow against the in-memory cart for testing.',
        kind: 'action',
        handler: () => {
          throw new GenieToolError('cart is empty', {
            code: 'CART_EMPTY',
            hint: 'call app_seed_cart first',
          })
        },
      }),
      defineGenieTool({
        name: 'explode',
        description: 'Always throws, exists to exercise the provenance wrapping of app errors.',
        kind: 'query',
        handler: () => {
          throw new Error('boom')
        },
      }),
    )
    await flush()

    socket.receive({ kind: 'bridge/request', id: 'r5', tool: 'app_checkout', args: {} })
    socket.receive({ kind: 'bridge/request', id: 'r6', tool: 'app_explode', args: {} })
    await flush()

    expect(lastResponse(socket, 'r5').error).toBe(
      '[CART_EMPTY] cart is empty — hint: call app_seed_cart first',
    )
    const wrapped = lastResponse(socket, 'r6').error
    expect(wrapped).toContain('app_explode')
    expect(wrapped).toContain('boom')
    expect(wrapped).toContain("app's own tool code")
  })

  it('always invokes the latest handler after re-registration', async () => {
    const { socket } = startClient()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerGenieTools(seedCartTool(() => ({ added: 'old' })))
    registerGenieTools(seedCartTool(() => ({ added: 'new' })))
    warn.mockRestore()
    await flush()

    socket.receive({ kind: 'bridge/request', id: 'r7', tool: 'app_seed_cart', args: {} })
    await flush()
    expect(lastResponse(socket, 'r7').result).toEqual({ added: 'new' })
  })
})

describe('result guards', () => {
  it('fails loudly with the size and shape when a handler over-returns', async () => {
    const { socket } = startClient()
    registerGenieTools(
      defineGenieTool({
        name: 'dump_everything',
        description: 'Returns far too much data on purpose, to exercise the result size cap.',
        kind: 'query',
        handler: () => ({ rows: 'x'.repeat(200 * 1024), note: 'huge' }),
      }),
    )
    await flush()
    socket.receive({ kind: 'bridge/request', id: 'g1', tool: 'app_dump_everything', args: {} })
    await flush()

    const error = lastResponse(socket, 'g1').error
    expect(error).toContain('over its 128KB result cap')
    expect(error).toContain('top-level keys: rows, note')
    expect(error).toContain('raise maxResultBytes')
  })

  it('measures the cap in bytes, not UTF-16 code units', async () => {
    const { socket } = startClient()
    registerGenieTools(
      defineGenieTool({
        name: 'multibyte',
        description: 'Returns multi-byte text under the code-unit count but over the byte cap.',
        kind: 'query',
        // 60k CJK chars ≈ 60k code units but ~180KB in UTF-8.
        handler: () => ({ rows: '汉'.repeat(60 * 1024) }),
      }),
    )
    await flush()
    socket.receive({ kind: 'bridge/request', id: 'g3', tool: 'app_multibyte', args: {} })
    await flush()

    expect(lastResponse(socket, 'g3').error).toContain('result cap')
  })

  it('names the serialization problem instead of letting the bridge time out', async () => {
    const { socket } = startClient()
    registerGenieTools(
      defineGenieTool({
        name: 'leak_node',
        description: 'Returns an unserializable value on purpose, to exercise the wire guard.',
        kind: 'query',
        handler: () => ({
          get boom(): never {
            throw new Error('getter exploded')
          },
        }),
      }),
    )
    await flush()
    socket.receive({ kind: 'bridge/request', id: 'g2', tool: 'app_leak_node', args: {} })
    await flush()

    const response = lastResponse(socket, 'g2')
    expect(response.ok).toBe(false)
    expect(response.error).toContain('cannot be serialized')
  })
})

describe('maxResultBytes override', () => {
  it('lets a tool raise its own result cap deliberately', async () => {
    const { socket } = startClient()
    registerGenieTools(
      defineGenieTool({
        name: 'big_export',
        description: 'Returns a deliberately large payload; the tool raises its own result cap.',
        kind: 'query',
        maxResultBytes: 512 * 1024,
        handler: () => ({ rows: 'x'.repeat(200 * 1024) }),
      }),
    )
    await flush()
    socket.receive({ kind: 'bridge/request', id: 'm1', tool: 'app_big_export', args: {} })
    await flush()

    expect(lastResponse(socket, 'm1').ok).toBe(true)
  })
})

describe('review regressions', () => {
  it('falls back to the surviving registration when a duplicate releases first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { socket } = startClient()
    registerGenieTools(seedCartTool(() => ({ added: 'A' })))
    const unregisterB = registerGenieTools(seedCartTool(() => ({ added: 'B' })))
    unregisterB()
    warn.mockRestore()
    await flush()

    expect(advertisedTool(socket, 'app_seed_cart').available).toBeUndefined()
    socket.receive({ kind: 'bridge/request', id: 'd1', tool: 'app_seed_cart', args: {} })
    await flush()
    expect(lastResponse(socket, 'd1').result).toEqual({ added: 'A' })
  })

  it('rejects results that superjson would silently drop, naming the path', async () => {
    const { socket } = startClient()
    registerGenieTools(
      defineGenieTool({
        name: 'leak_fn',
        description: 'Returns a function on purpose, to exercise the lossy-value guard.',
        kind: 'query',
        handler: () => ({ data: { onClick: () => 'nope' } }),
      }),
    )
    await flush()
    socket.receive({ kind: 'bridge/request', id: 'l1', tool: 'app_leak_fn', args: {} })
    await flush()

    const response = lastResponse(socket, 'l1')
    expect(response.ok).toBe(false)
    expect(response.error).toContain('result.data.onClick is a function')
  })

  it('caps tombstones so dynamic names cannot grow the catalog forever', async () => {
    const { socket } = startClient()
    for (let i = 0; i < 40; i++) {
      registerGenieTools(
        defineGenieTool({
          name: `dynamic_${i}`,
          description: 'Short-lived dynamically named tool used to exercise tombstone pruning.',
          kind: 'query',
          handler: () => ({ i }),
        }),
      )()
    }
    await flush()

    const appTools = lastHello(socket).tools.filter((t: Frame) => t.name.startsWith('app_dynamic_'))
    expect(appTools.length).toBeLessThanOrEqual(32)
  })
})

describe('overlapping registration ownership', () => {
  it('keeps the latest handler when the OLDER registration unmounts first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { socket } = startClient()
    const unregisterA = registerGenieTools(seedCartTool(() => ({ added: 'A' })))
    registerGenieTools(seedCartTool(() => ({ added: 'B' })))
    unregisterA()
    warn.mockRestore()
    await flush()

    expect(advertisedTool(socket, 'app_seed_cart').available).toBeUndefined()
    socket.receive({ kind: 'bridge/request', id: 'o1', tool: 'app_seed_cart', args: {} })
    await flush()
    expect(lastResponse(socket, 'o1').result).toEqual({ added: 'B' })
  })
})
