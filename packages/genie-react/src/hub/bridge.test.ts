import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { decodeFrame, newId } from '../protocol'
import { connect, delay, type Frame, isResult, open, send } from './bridge-test-harness'
import { createStandaloneBridge, type StandaloneBridgeHandle } from './standalone'

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
    expect(statusAfter.result.toolCount).toBe(7) // 1 app tool + 6 bridge meta tools
    const names = statusAfter.result.tools.map((tool: { name: string }) => tool.name)
    expect(names).toEqual([
      'echo',
      'devtools_status',
      'devtools_wait',
      'devtools_capture_create',
      'devtools_capture_list',
      'devtools_capture_read',
      'devtools_capture_compare',
    ]) // catalog carries bridge meta tools too
  })

  it('creates, lists, and reads a bounded React-commit-stable capture', async () => {
    const { ws: app } = await open(`${url}?role=app`)
    const toolResults: Record<string, unknown> = {
      react_get_renders: {
        commits: 7,
        summary: { totalRenders: 10, totalUpdates: 8 },
        components: [],
      },
      react_render_causes: { commits: 7, events: [] },
      react_profile_report: { commits: 7, components: [] },
      react_effect_audit: { commits: 7, effects: [] },
      query_list: { queries: [], total: 0 },
      query_is_fetching: { fetching: 0, mutating: 0 },
      router_get_state: { pathname: '/review', isLoading: false },
      router_list_matches: { matches: [] },
      browser_get_memory: { supported: true, usedJSHeapSize: 1_024 },
    }
    app.on('message', (data) => {
      const message = decodeFrame(data.toString()) as Frame
      if (message.kind !== 'bridge/request') return
      send(app, {
        kind: 'app/response',
        id: message.id,
        ok: true,
        result: toolResults[message.tool],
      })
    })
    send(app, {
      kind: 'app/hello',
      protocol: 1,
      sessionId: 'capture-session',
      logicalSessionId: 'capture-tab',
      documentGeneration: 3,
      sessionName: 'review',
      app: { name: 'capture demo', url: 'http://localhost/review' },
      capabilities: ['react', 'query', 'router', 'browser'],
      tools: Object.keys(toolResults).map((name) => ({
        name,
        title: name,
        description: `${name} test fixture`,
        group: 'meta',
      })),
    })

    const { ws: agent, inbox } = await open(`${url}?role=agent`)
    const createId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: createId,
      tool: 'devtools_capture_create',
      args: { name: 'before optimization' },
      sessionId: 'review',
    })
    const created = await inbox.wait(isResult(createId))

    expect(created.ok).toBe(true)
    expect(created.result).toMatchObject({
      schemaVersion: '1.0',
      name: 'before optimization',
      include: ['react', 'effects', 'query', 'router', 'memory'],
      consistency: {
        kind: 'react-commit-stable',
        attempts: 1,
        reactCommit: 7,
      },
      session: {
        sessionId: 'capture-session',
        logicalSessionId: 'capture-tab',
        documentGeneration: 3,
        sessionName: 'review',
      },
      complete: true,
      warnings: [],
    })
    expect(created.result.captureId).toMatch(/^cap_/)
    expect(created.result.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(created.result), 'utf8'))
    expect(created.result.sections.react.tools.react_get_renders.result.commits).toBe(7)

    const listId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: listId,
      tool: 'devtools_capture_list',
      args: {},
    })
    const listed = await inbox.wait(isResult(listId))
    expect(listed.result).toMatchObject({ total: 1, maxRetained: 20 })
    expect(listed.result.captures[0]).toMatchObject({
      captureId: created.result.captureId,
      name: 'before optimization',
      complete: true,
    })
    expect(listed.result.captures[0].sections).toBeUndefined()

    created.result.name = 'mutated response'
    const readId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: readId,
      tool: 'devtools_capture_read',
      args: { captureId: created.result.captureId },
    })
    const read = await inbox.wait(isResult(readId))
    expect(read.result.name).toBe('before optimization')
    expect(read.result).toEqual(expect.objectContaining({ captureId: created.result.captureId }))

    const createAfterId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: createAfterId,
      tool: 'devtools_capture_create',
      args: { name: 'after optimization' },
      sessionId: 'review',
    })
    const createdAfter = await inbox.wait(isResult(createAfterId))
    expect(createdAfter.ok).toBe(true)

    const compareId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: compareId,
      tool: 'devtools_capture_compare',
      args: {
        baselineCaptureIds: [created.result.captureId],
        candidateCaptureIds: [createdAfter.result.captureId],
        metrics: ['react.renders'],
        minimumRuns: 1,
        budgets: [{ metric: 'react.renders', maxRegressionPct: 0 }],
      },
    })
    const compared = await inbox.wait(isResult(compareId))
    expect(compared.ok).toBe(true)
    expect(compared.result).toMatchObject({
      schemaVersion: '1.0',
      kind: 'capture-comparison',
      overall: 'pass',
      baselineCaptureIds: [created.result.captureId],
      candidateCaptureIds: [createdAfter.result.captureId],
      metrics: [
        {
          metric: 'react.renders',
          baseline: { samples: 1, median: 10 },
          candidate: { samples: 1, median: 10 },
          verdict: 'pass',
        },
      ],
      violations: [],
    })
  })

  it('retries a named capture when React commits during the first attempt', async () => {
    const { ws: app } = await open(`${url}?role=app`)
    const probeCommits = [1, 2, 3, 3]
    app.on('message', (data) => {
      const message = decodeFrame(data.toString()) as Frame
      if (message.kind !== 'bridge/request') return
      const commits = message.tool === 'react_get_renders' ? (probeCommits.shift() ?? 3) : undefined
      send(app, {
        kind: 'app/response',
        id: message.id,
        ok: true,
        result: commits === undefined ? { components: [] } : { commits, components: [] },
      })
    })
    send(app, {
      kind: 'app/hello',
      protocol: 1,
      sessionId: 'moving-session',
      app: { name: 'moving demo' },
      capabilities: ['react'],
      tools: [
        {
          name: 'react_get_renders',
          title: 'Renders',
          description: 'render totals',
          group: 'react',
        },
        {
          name: 'react_profile_report',
          title: 'Profile',
          description: 'profile report',
          group: 'react',
        },
      ],
    })

    const { ws: agent, inbox } = await open(`${url}?role=agent`)
    const id = newId()
    send(agent, {
      kind: 'agent/invoke',
      id,
      tool: 'devtools_capture_create',
      args: { name: 'settled attempt', include: ['react'], maxAttempts: 3 },
    })
    const result = await inbox.wait(isResult(id))

    expect(result.ok).toBe(true)
    expect(result.result.consistency).toMatchObject({
      kind: 'react-commit-stable',
      attempts: 2,
      reactCommit: 3,
    })
    expect(probeCommits).toEqual([])
  })

  it('errors when forwarding a tool with no app connected', async () => {
    const { ws: agent, inbox } = await open(`${url}?role=agent`)
    await inbox.wait((m) => m.kind === 'bridge/status')

    const id = newId()
    send(agent, { kind: 'agent/invoke', id, tool: 'react_get_tree', args: {} })
    const result = await inbox.wait(isResult(id))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No app connected')
    expect(result.errorCode).toBe('not-connected')
  })

  it('preserves machine-readable validation errors from the app collector', async () => {
    const { ws: app } = await open(`${url}?role=app`)
    app.on('message', (data) => {
      const message = decodeFrame(data.toString()) as Frame
      if (message.kind !== 'bridge/request') return
      send(app, {
        kind: 'app/response',
        id: message.id,
        ok: false,
        error: 'Invalid arguments for "typed_tool": value is required',
        errorCode: 'invalid-args',
      })
    })
    send(app, {
      kind: 'app/hello',
      protocol: 1,
      sessionId: 'validation-session',
      app: { name: 'validation demo' },
      capabilities: [],
      tools: [
        {
          name: 'typed_tool',
          title: 'Typed tool',
          description: 'requires input',
          group: 'meta',
        },
      ],
    })

    const { ws: agent, inbox } = await open(`${url}?role=agent`)
    const id = newId()
    send(agent, { kind: 'agent/invoke', id, tool: 'typed_tool', args: {} })
    const result = await inbox.wait(isResult(id))
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('invalid-args')
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
    expect(unknown.errorCode).toBe('unknown-session')

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

  it('distinguishes readiness, records reload lineage, and follows stale session pins', async () => {
    const { ws: agent, inbox } = await open(`${url}?role=agent`)
    const firstDocument = await connect(`${url}?role=app`)
    send(firstDocument, {
      kind: 'app/hello',
      protocol: 1,
      sessionId: 'physical-1',
      logicalSessionId: 'logical-review',
      documentGeneration: 1,
      sessionName: 'review',
      app: { name: 'first document' },
      capabilities: ['react'],
      tools: [{ name: 'whoami', title: 'Who', description: 'identity', group: 'meta' }],
    })

    const compactStatusId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: compactStatusId,
      tool: 'devtools_status',
      args: { includeTools: false },
    })
    const initializing = await inbox.wait(isResult(compactStatusId))
    expect(initializing.result).toMatchObject({ connected: true, ready: false })
    expect(initializing.result.tools).toBeUndefined()
    expect(initializing.result.sessions[0]).toMatchObject({
      logicalSessionId: 'logical-review',
      documentGeneration: 1,
      sessionName: 'review',
      ready: false,
    })

    const readyWaitId = newId()
    send(agent, {
      kind: 'agent/invoke',
      id: readyWaitId,
      tool: 'devtools_wait',
      args: { condition: 'ready', timeoutMs: 2_000 },
      sessionId: 'logical-review',
    })
    const readyWait = inbox.wait(isResult(readyWaitId))
    send(firstDocument, { kind: 'app/ready', sessionId: 'physical-1' })
    expect((await readyWait).result.ok).toBe(true)

    // Real reload ordering commonly closes the old socket before the new document can hello.
    firstDocument.close()
    await expect.poll(() => handle.bridge.getStatus().sessions.length).toBe(0)

    const { ws: secondDocument, inbox: secondInbox } = await open(`${url}?role=app`)
    send(secondDocument, {
      kind: 'app/hello',
      protocol: 1,
      sessionId: 'physical-2',
      logicalSessionId: 'logical-review',
      documentGeneration: 2,
      sessionName: 'review',
      app: { name: 'second document' },
      capabilities: ['react'],
      tools: [{ name: 'whoami', title: 'Who', description: 'identity', group: 'meta' }],
    })
    send(secondDocument, { kind: 'app/ready', sessionId: 'physical-2' })
    await expect.poll(() => handle.bridge.getStatus().sessions.length).toBe(1)

    for (const target of ['physical-1', 'logical-review', 'review']) {
      const callId = newId()
      send(agent, {
        kind: 'agent/invoke',
        id: callId,
        tool: 'whoami',
        args: {},
        sessionId: target,
      })
      const request = await secondInbox.wait(
        (frame) => frame.kind === 'bridge/request' && frame.id === callId,
      )
      send(secondDocument, {
        kind: 'app/response',
        id: request.id,
        ok: true,
        result: { from: 'physical-2' },
      })
      expect((await inbox.wait(isResult(callId))).result.from).toBe('physical-2')
    }

    const finalStatus = handle.bridge.getStatus()
    expect(finalStatus.ready).toBe(true)
    expect(finalStatus.sessions[0]).toMatchObject({
      sessionId: 'physical-2',
      predecessorSessionId: 'physical-1',
      documentGeneration: 2,
      ready: true,
    })
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
    expect(failed.errorCode).toBe('not-connected')

    const statusId = newId()
    send(agent, { kind: 'agent/invoke', id: statusId, tool: 'devtools_status', args: {} })
    const status = await inbox.wait(isResult(statusId))
    expect(status.result.sessions).toHaveLength(1)
    expect(status.result.app.name).toBe('second')
    expect(status.result.sessions[0].current).toBe(true)
  })

  it('resets stale heartbeat state when a heartbeat-capable session re-hellos', async () => {
    const fastHandle = createStandaloneBridge({ sessionStaleMs: 100 })
    const fastUrl = (await fastHandle.listen()).url
    try {
      const app = await connect(`${fastUrl}?role=app`)
      const hello = {
        kind: 'app/hello' as const,
        protocol: 1,
        sessionId: 's-reload',
        app: { name: 'reloadable' },
        capabilities: [],
        tools: [],
      }
      send(app, hello)
      send(app, { kind: 'app/heartbeat', sessionId: 's-reload' })
      await expect.poll(() => fastHandle.bridge.getStatus().connected).toBe(true)

      await delay(150)
      expect(fastHandle.bridge.getStatus().sessions[0]?.staleMs).toBeGreaterThan(100)

      send(app, hello)
      await expect.poll(() => fastHandle.bridge.getStatus().sessions[0]?.staleMs).toBeUndefined()
      const status = fastHandle.bridge.getStatus()
      expect(status.sessions[0]?.staleMs).toBeUndefined()
      expect(status.sessionId).toBe('s-reload')
    } finally {
      await fastHandle.close()
    }
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
      expect(result.errorCode).toBe('timeout')
    } finally {
      await fastHandle.close()
    }
  })

  it('fast-fails a busy (heartbeat-then-silent) session with errorCode busy well before the full timeout', async () => {
    const fastHandle = createStandaloneBridge({
      requestTimeoutMs: 20_000,
      busyProbeMs: 200,
      busyHeartbeatGapMs: 100,
    })
    const fastUrl = (await fastHandle.listen()).url
    try {
      const app = await connect(`${fastUrl}?role=app`)
      send(app, {
        kind: 'app/hello',
        protocol: 1,
        sessionId: 's-busy',
        app: { name: 'busy' },
        capabilities: [],
        tools: [],
      })
      send(app, { kind: 'app/heartbeat', sessionId: 's-busy' })
      await expect.poll(() => fastHandle.bridge.getStatus().connected).toBe(true)

      const { ws: agent, inbox } = await open(`${fastUrl}?role=agent`)
      const id = newId()
      const started = Date.now()
      // The app never answers this request and never beats again; the busy probe must settle it.
      send(agent, { kind: 'agent/invoke', id, tool: 'never_responds', args: {} })
      const result = await inbox.wait(isResult(id), 5000)
      expect(result.ok).toBe(false)
      expect(result.errorCode).toBe('busy')
      expect(result.retryInMs).toBe(500)
      expect(result.error).toContain('main thread busy')
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      await fastHandle.close()
    }
  })

  it('busy-fails via a re-armed probe when the heartbeat gap crosses the threshold only after the first probe', async () => {
    const fastHandle = createStandaloneBridge({
      requestTimeoutMs: 20_000,
      busyProbeMs: 100,
      busyHeartbeatGapMs: 400,
    })
    const fastUrl = (await fastHandle.listen()).url
    try {
      const app = await connect(`${fastUrl}?role=app`)
      send(app, {
        kind: 'app/hello',
        protocol: 1,
        sessionId: 's-lateBusy',
        app: { name: 'lateBusy' },
        capabilities: [],
        tools: [],
      })
      send(app, { kind: 'app/heartbeat', sessionId: 's-lateBusy' })
      await expect.poll(() => fastHandle.bridge.getStatus().connected).toBe(true)

      const { ws: agent, inbox } = await open(`${fastUrl}?role=agent`)
      const id = newId()
      const started = Date.now()
      // At the first probe (100ms) the gap (~100ms) is under 400ms, so a single-shot probe would fall through to the 20s timeout; the re-arm must catch the crossing.
      send(agent, { kind: 'agent/invoke', id, tool: 'never_responds', args: {} })
      const result = await inbox.wait(isResult(id), 5000)
      expect(result.ok).toBe(false)
      expect(result.errorCode).toBe('busy')
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      await fastHandle.close()
    }
  })

  it('lets a caller-supplied timeoutMs override the busy fast-fail', async () => {
    const fastHandle = createStandaloneBridge({
      requestTimeoutMs: 20_000,
      busyProbeMs: 100,
      busyHeartbeatGapMs: 50,
    })
    const fastUrl = (await fastHandle.listen()).url
    try {
      const app = await connect(`${fastUrl}?role=app`)
      send(app, {
        kind: 'app/hello',
        protocol: 1,
        sessionId: 's-timeoutOverride',
        app: { name: 'timeoutOverride' },
        capabilities: [],
        tools: [],
      })
      send(app, { kind: 'app/heartbeat', sessionId: 's-timeoutOverride' })
      await expect.poll(() => fastHandle.bridge.getStatus().connected).toBe(true)

      const { ws: agent, inbox } = await open(`${fastUrl}?role=agent`)
      const id = newId()
      const started = Date.now()
      send(agent, {
        kind: 'agent/invoke',
        id,
        tool: 'never_responds',
        args: {},
        timeoutMs: 1_000,
      })
      const result = await inbox.wait(isResult(id), 3_000)
      expect(result.ok).toBe(false)
      expect(result.errorCode).toBe('timeout')
      expect(result.error).toContain('1000ms')
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    } finally {
      await fastHandle.close()
    }
  })

  it('does not busy-gate advertised mutation tools', async () => {
    const fastHandle = createStandaloneBridge({
      requestTimeoutMs: 1_000,
      busyProbeMs: 100,
      busyHeartbeatGapMs: 50,
    })
    const fastUrl = (await fastHandle.listen()).url
    try {
      const { ws: app, inbox: appInbox } = await open(`${fastUrl}?role=app`)
      send(app, {
        kind: 'app/hello',
        protocol: 1,
        sessionId: 's-mutation',
        app: { name: 'mutation' },
        capabilities: ['react'],
        tools: [
          {
            name: 'react_override_hook_state',
            title: 'Override hook state',
            description: 'mutates state',
            group: 'action',
            annotations: { destructiveHint: true, idempotentHint: false },
          },
        ],
      })
      send(app, { kind: 'app/heartbeat', sessionId: 's-mutation' })
      await expect.poll(() => fastHandle.bridge.getStatus().connected).toBe(true)

      const { ws: agent, inbox } = await open(`${fastUrl}?role=agent`)
      const id = newId()
      const started = Date.now()
      send(agent, {
        kind: 'agent/invoke',
        id,
        tool: 'react_override_hook_state',
        args: { id: 1, stateIndex: 0, value: true },
      })
      await appInbox.wait((frame) => frame.kind === 'bridge/request' && frame.id === id, 500)
      const result = await inbox.wait(isResult(id), 3_000)
      expect(result.ok).toBe(false)
      expect(result.errorCode).toBe('timeout')
      expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    } finally {
      await fastHandle.close()
    }
  })

  it('escalates the busy message to "unresponsive" (no retry hint) once the gap crosses the stale threshold', async () => {
    const fastHandle = createStandaloneBridge({
      requestTimeoutMs: 20_000,
      busyProbeMs: 200,
      busyHeartbeatGapMs: 50,
      sessionStaleMs: 120,
    })
    const fastUrl = (await fastHandle.listen()).url
    try {
      const app = await connect(`${fastUrl}?role=app`)
      send(app, {
        kind: 'app/hello',
        protocol: 1,
        sessionId: 's-dead',
        app: { name: 'dead' },
        capabilities: [],
        tools: [],
      })
      send(app, { kind: 'app/heartbeat', sessionId: 's-dead' })
      await expect.poll(() => fastHandle.bridge.getStatus().connected).toBe(true)

      const { ws: agent, inbox } = await open(`${fastUrl}?role=agent`)
      const id = newId()
      // First probe at 200ms sees a ~200ms gap: past both the busy (50ms) and stale (120ms) thresholds → the escalated message.
      send(agent, { kind: 'agent/invoke', id, tool: 'never_responds', args: {} })
      const result = await inbox.wait(isResult(id), 5000)
      expect(result.errorCode).toBe('busy')
      expect(result.error).toContain('unresponsive')
      expect(result.retryInMs).toBeUndefined()
    } finally {
      await fastHandle.close()
    }
  })

  it('routes default calls away from a heartbeat-stale session to a fresh one, and flags it in status', async () => {
    const fastHandle = createStandaloneBridge({ requestTimeoutMs: 4_000, sessionStaleMs: 150 })
    const fastUrl = (await fastHandle.listen()).url
    try {
      const hello = (sessionId: string) => ({
        kind: 'app/hello' as const,
        protocol: 1,
        sessionId,
        app: { name: sessionId },
        capabilities: [],
        tools: [],
      })
      const { ws: fresh, inbox: freshInbox } = await open(`${fastUrl}?role=app`)
      send(fresh, hello('s-fresh'))
      send(fresh, { kind: 'app/heartbeat', sessionId: 's-fresh' })
      // Connects later, so it wins `current`; one beat marks it heartbeat-capable, then it dies silently (phantom tab).
      const phantom = await connect(`${fastUrl}?role=app`)
      send(phantom, hello('s-phantom'))
      send(phantom, { kind: 'app/heartbeat', sessionId: 's-phantom' })
      await expect.poll(() => fastHandle.bridge.getStatus().sessions.length).toBe(2)

      await delay(200)
      send(fresh, { kind: 'app/heartbeat', sessionId: 's-fresh' })
      await expect.poll(() => fastHandle.bridge.getStatus().sessionId).toBe('s-fresh')
      const summary = fastHandle.bridge
        .getStatus()
        .sessions.find((s) => s.sessionId === 's-phantom')
      expect(summary?.staleMs).toBeGreaterThan(150)

      const { ws: agent, inbox } = await open(`${fastUrl}?role=agent`)
      const id = newId()
      send(agent, { kind: 'agent/invoke', id, tool: 'who_got_this', args: {} })
      const request = await freshInbox.wait(
        (frame) => frame.kind === 'bridge/request' && frame.id === id,
        2000,
      )
      expect(request.tool).toBe('who_got_this')
      send(fresh, { kind: 'app/response', id, ok: true, result: { from: 's-fresh' } })
      const result = await inbox.wait(isResult(id), 2000)
      expect(result.ok).toBe(true)
    } finally {
      await fastHandle.close()
    }
  })

  it('honors a per-call timeoutMs (clamped) instead of the bridge default', async () => {
    const fastHandle = createStandaloneBridge({ requestTimeoutMs: 30_000 })
    const fastUrl = (await fastHandle.listen()).url
    try {
      const app = await connect(`${fastUrl}?role=app`)
      send(app, {
        kind: 'app/hello',
        protocol: 1,
        sessionId: 's-perCall',
        app: { name: 'silent' },
        capabilities: [],
        tools: [],
      })
      const { ws: agent, inbox } = await open(`${fastUrl}?role=agent`)
      const id = newId()
      const started = Date.now()
      // Below the 1000ms floor: the bridge clamps up to 1000ms, still far under its 30s default.
      send(agent, { kind: 'agent/invoke', id, tool: 'never_responds', args: {}, timeoutMs: 1 })
      const result = await inbox.wait(isResult(id), 4000)
      expect(result.ok).toBe(false)
      expect(result.errorCode).toBe('timeout')
      expect(result.error).toContain('1000ms')
      expect(Date.now() - started).toBeLessThan(3000)
    } finally {
      await fastHandle.close()
    }
  })

  it('never busy-fails a legacy session that never sent a heartbeat — it gets the plain timeout', async () => {
    const fastHandle = createStandaloneBridge({
      requestTimeoutMs: 150,
      busyProbeMs: 50,
      busyHeartbeatGapMs: 10,
    })
    const fastUrl = (await fastHandle.listen()).url
    try {
      const app = await connect(`${fastUrl}?role=app`)
      send(app, {
        kind: 'app/hello',
        protocol: 1,
        sessionId: 's-legacy',
        app: { name: 'legacy' },
        capabilities: [],
        tools: [],
      })
      const { ws: agent, inbox } = await open(`${fastUrl}?role=agent`)
      const id = newId()
      send(agent, { kind: 'agent/invoke', id, tool: 'never_responds', args: {} })
      const result = await inbox.wait(isResult(id))
      expect(result.ok).toBe(false)
      expect(result.errorCode).toBe('timeout')
      expect(result.error).toContain('timed out')
    } finally {
      await fastHandle.close()
    }
  })

  it('reaps sessions whose sockets stop answering heartbeat pings', async () => {
    const fastHandle = createStandaloneBridge({ heartbeatIntervalMs: 40 })
    const fastUrl = (await fastHandle.listen()).url
    try {
      const zombie = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`${fastUrl}?role=app`, { autoPong: false })
        ws.once('open', () => resolve(ws))
        ws.once('error', reject)
      })
      send(zombie, {
        kind: 'app/hello',
        protocol: 1,
        sessionId: 's-zombie',
        app: { name: 'zombie' },
        capabilities: [],
        tools: [],
      })
      await expect.poll(() => fastHandle.bridge.getStatus().connected).toBe(true)
      await expect
        .poll(() => fastHandle.bridge.getStatus().connected, { timeout: 3000 })
        .toBe(false)
    } finally {
      await fastHandle.close()
    }
  })

  it('keeps the current session when a background tab re-hellos (tool refresh)', async () => {
    const hello = (socket: WebSocket, sessionId: string, toolName: string) =>
      send(socket, {
        kind: 'app/hello',
        protocol: 1,
        sessionId,
        app: { name: sessionId },
        capabilities: ['react'],
        tools: [{ name: toolName, title: toolName, description: 'x', group: 'meta' }],
      })

    const tabA = await connect(`${url}?role=app`)
    hello(tabA, 'tab-a', 'a-tool')
    await expect.poll(() => handle.bridge.getStatus().sessionId).toBe('tab-a')

    const tabB = await connect(`${url}?role=app`)
    hello(tabB, 'tab-b', 'b-tool')
    await expect.poll(() => handle.bridge.getStatus().sessionId).toBe('tab-b')

    // Background tab A refreshes its tools (e.g. React detected after load) — must not steal routing.
    hello(tabA, 'tab-a', 'a-tool-2')
    await expect
      .poll(() =>
        handle.bridge.getStatus().tools.some((t: { name: string }) => t.name === 'b-tool'),
      )
      .toBe(true)
    expect(handle.bridge.getStatus().sessionId).toBe('tab-b')

    tabA.close()
    tabB.close()
  })
})
