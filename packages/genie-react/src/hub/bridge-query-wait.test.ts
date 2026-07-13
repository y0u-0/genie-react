import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeFrame, newId } from '../protocol'
import { type Frame, isResult, open, send } from './bridge-test-harness'
import { createStandaloneBridge, type StandaloneBridgeHandle } from './standalone'

describe('GenieBridge exact query waits', () => {
  let handle: StandaloneBridgeHandle
  let url: string

  beforeEach(async () => {
    handle = createStandaloneBridge()
    url = (await handle.listen()).url
  })

  afterEach(async () => {
    await handle.close()
  })

  it('waits for exact structured queries and rejects ambiguous legacy selectors', async () => {
    const { ws: app } = await open(`${url}?role=app`)
    let queries = [
      { queryHash: '["greeting"]', queryKey: ['greeting'], fetchStatus: 'idle' },
      { queryHash: '["greet","details"]', queryKey: ['greet', 'details'], fetchStatus: 'idle' },
    ]
    app.on('message', (data) => {
      const message = decodeFrame(data.toString()) as Frame
      if (message.kind !== 'bridge/request') return
      if (message.tool === 'query_list') {
        send(app, {
          kind: 'app/response',
          id: message.id,
          ok: true,
          result: { queries, total: queries.length },
        })
        return
      }
      if (message.tool === 'query_get') {
        const args = message.args as { queryHash?: string; queryKey?: unknown[] }
        const query = queries.find(
          (candidate) =>
            candidate.queryHash === args.queryHash ||
            JSON.stringify(candidate.queryKey) === JSON.stringify(args.queryKey),
        )
        send(app, {
          kind: 'app/response',
          id: message.id,
          ok: query !== undefined,
          result: query,
          ...(query ? {} : { error: 'query not found', errorCode: 'tool-error' }),
        })
      }
    })
    send(app, {
      kind: 'app/hello',
      protocol: 1,
      sessionId: 'query-wait',
      app: { name: 'query wait' },
      capabilities: ['query'],
      tools: ['query_list', 'query_get', 'query_is_fetching'].map((name) => ({
        name,
        title: name,
        description: name,
        group: 'query',
      })),
    })
    const { ws: agent, inbox } = await open(`${url}?role=agent`)

    const substringId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: substringId,
      tool: 'devtools_wait',
      args: { condition: 'query-settled', name: 'greet', timeoutMs: 50 },
    })
    const substring = await inbox.wait(isResult(substringId))
    expect(substring.result).toMatchObject({ ok: false, reason: 'timeout' })

    const exactId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: exactId,
      tool: 'devtools_wait',
      args: { condition: 'query-settled', queryKey: ['greeting'], timeoutMs: 500 },
    })
    const exact = await inbox.wait(isResult(exactId))
    expect(exact.result).toMatchObject({
      ok: true,
      query: { queryHash: '["greeting"]', queryKey: ['greeting'] },
    })

    queries = [
      ...queries,
      { queryHash: 'custom-greeting', queryKey: ['greeting'], fetchStatus: 'idle' },
    ]
    const ambiguousId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: ambiguousId,
      tool: 'devtools_wait',
      args: { condition: 'query-settled', name: 'greeting', timeoutMs: 500 },
    })
    const ambiguous = await inbox.wait(isResult(ambiguousId))
    expect(ambiguous.result.ok).toBe(false)
    expect(ambiguous.result.reason).toContain('ambiguous (2 exact matches)')
  })
})
