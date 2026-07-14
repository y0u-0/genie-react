import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeFrame, newId } from '../protocol'
import { type Frame, isResult, open, send } from './bridge-test-harness'
import { createStandaloneBridge, type StandaloneBridgeHandle } from './standalone'

describe('GenieBridge waits', () => {
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

  it('settles an empty query cache only after both fetches and mutations are idle', async () => {
    const { ws: app } = await open(`${url}?role=app`)
    let pendingChecks = 0
    let listChecks = 0
    app.on('message', (data) => {
      const message = decodeFrame(data.toString()) as Frame
      if (message.kind !== 'bridge/request') return
      if (message.tool === 'query_list') listChecks += 1
      if (message.tool === 'query_is_fetching') pendingChecks += 1
      send(app, {
        kind: 'app/response',
        id: message.id,
        ok: true,
        result:
          message.tool === 'query_list'
            ? { queries: [], total: 0 }
            : { fetching: 0, mutating: pendingChecks === 1 ? 1 : 0 },
      })
    })
    send(app, {
      kind: 'app/hello',
      protocol: 1,
      sessionId: 'empty-query-wait',
      app: { name: 'empty query wait' },
      capabilities: ['query'],
      tools: ['query_list', 'query_is_fetching'].map((name) => ({
        name,
        title: name,
        description: name,
        group: 'query',
      })),
    })
    const { ws: agent, inbox } = await open(`${url}?role=agent`)

    const id = newId()
    send(agent, {
      kind: 'agent/invoke',
      id,
      tool: 'devtools_wait',
      args: { condition: 'query-settled', timeoutMs: 1_000 },
    })
    const response = await inbox.wait(isResult(id), 2_000)

    expect(response.result).toMatchObject({
      ok: true,
      lastObserved: { fetching: 0, mutating: 0 },
    })
    expect(pendingChecks).toBeGreaterThanOrEqual(2)
    expect(listChecks).toBe(0)
  })

  it('waits for every requested settle domain and reports each domain independently', async () => {
    const { ws: app } = await open(`${url}?role=app`)
    let reactChecks = 0
    let queryChecks = 0
    let routerChecks = 0
    app.on('message', (data) => {
      const message = decodeFrame(data.toString()) as Frame
      if (message.kind !== 'bridge/request') return
      let result: unknown
      if (message.tool === 'react_get_renders') {
        reactChecks += 1
        result = { documentCommitId: reactChecks === 1 ? 4 : 5 }
      } else if (message.tool === 'query_is_fetching') {
        queryChecks += 1
        result = { fetching: queryChecks === 1 ? 1 : 0, mutating: 0 }
      } else if (message.tool === 'router_get_state') {
        routerChecks += 1
        result = { pathname: '/map', isLoading: routerChecks === 1 }
      } else if (message.tool === 'browser_fps') {
        result = { comparable: true, avgFps: 60, notComparableReasons: [] }
      }
      send(app, { kind: 'app/response', id: message.id, ok: true, result })
    })
    const tools = [
      ['react_get_renders', 'react'],
      ['query_is_fetching', 'query'],
      ['router_get_state', 'router'],
      ['browser_fps', 'perf'],
    ].map(([name, group]) => ({ name, title: name, description: name, group }))
    send(app, {
      kind: 'app/hello',
      protocol: 1,
      sessionId: 'multi-domain-settle',
      app: { name: 'settle fixture' },
      capabilities: ['react', 'query', 'router', 'perf'],
      tools,
    })
    const { ws: agent, inbox } = await open(`${url}?role=agent`)

    const id = newId()
    send(agent, {
      kind: 'agent/invoke',
      id,
      tool: 'devtools_wait',
      args: {
        condition: 'settled',
        domains: ['react', 'query', 'router', 'frames'],
        quietMs: 100,
        timeoutMs: 2_000,
      },
    })
    const response = await inbox.wait(isResult(id), 3_000)

    expect(response.result).toMatchObject({
      ok: true,
      condition: 'settled',
      domains: {
        react: {
          status: 'met',
          lastObserved: { documentCommitId: 5, requiredQuietMs: 100 },
        },
        query: { status: 'met', lastObserved: { fetching: 0, mutating: 0 } },
        router: { status: 'met', lastObserved: { pathname: '/map', isLoading: false } },
        frames: { status: 'met', lastObserved: { comparable: true, avgFps: 60 } },
      },
    })
  })

  it('keeps unsupported and timed-out settle evidence explicit', async () => {
    const { ws: app } = await open(`${url}?role=app`)
    let commit = 0
    app.on('message', (data) => {
      const message = decodeFrame(data.toString()) as Frame
      if (message.kind !== 'bridge/request') return
      commit += 1
      send(app, {
        kind: 'app/response',
        id: message.id,
        ok: true,
        result: { documentCommitId: commit },
      })
    })
    send(app, {
      kind: 'app/hello',
      protocol: 1,
      sessionId: 'partial-settle',
      app: { name: 'partial settle fixture' },
      capabilities: ['react'],
      tools: [
        {
          name: 'react_get_renders',
          title: 'renders',
          description: 'renders',
          group: 'react',
        },
      ],
    })
    const { ws: agent, inbox } = await open(`${url}?role=agent`)

    const unsupportedId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: unsupportedId,
      tool: 'devtools_wait',
      args: { condition: 'settled', domains: ['react', 'network'], quietMs: 100, timeoutMs: 500 },
    })
    const unsupported = await inbox.wait(isResult(unsupportedId))
    expect(unsupported.ok).toBe(true)
    expect(unsupported.result).toMatchObject({
      ok: false,
      domains: {
        react: { status: 'pending' },
        network: { status: 'unsupported' },
      },
    })
    expect(unsupported.result.reason).toContain('not instrumented')

    const timeoutId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: timeoutId,
      tool: 'devtools_wait',
      args: { condition: 'react-quiet', quietMs: 100, timeoutMs: 350 },
    })
    const timedOut = await inbox.wait(isResult(timeoutId))
    expect(timedOut.result).toMatchObject({
      ok: false,
      condition: 'react-quiet',
      reason: 'timeout',
      domains: { react: { status: 'pending' } },
    })
    expect(timedOut.result.validConditions).toContain('react-quiet')
    expect(timedOut.result.lastObserved.react.documentCommitId).toBeGreaterThan(0)
  })
})
