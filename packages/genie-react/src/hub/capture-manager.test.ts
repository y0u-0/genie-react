import { describe, expect, it } from 'vitest'
import { type CaptureArtifact, captureArtifactSchema, type ToolDescriptor } from '../protocol'
import { CaptureManager, type CaptureSession, verifyCaptureIntegrity } from './capture-manager'

const tools: ToolDescriptor[] = [
  'react_get_renders',
  'react_render_causes',
  'react_profile_report',
  'query_list',
  'query_is_fetching',
].map((name) => ({ name, title: name, description: name, group: 'react' }))

const session: CaptureSession = {
  sessionId: 'session-1',
  app: { name: 'fixture', reactVersion: '19.2.7' },
  tools,
}

function manager(): CaptureManager<CaptureSession> {
  return new CaptureManager({
    resolveSession: () => session,
    unknownSessionError: (target) => `unknown ${target}`,
    isCurrentSession: () => true,
    request: async (_session, tool, args) => ({
      ok: true,
      result:
        tool === 'react_get_renders'
          ? {
              commits: 4,
              summary: { totalRenders: 3, semantics: 'exact' },
              comparable: true,
              argsEcho: args,
            }
          : tool === 'query_is_fetching'
            ? { fetching: 2, mutating: 1 }
            : { commits: 4 },
    }),
  })
}

async function createCapture(captures: CaptureManager<CaptureSession>, name: string) {
  const result = await captures.invoke('devtools_capture_create', {
    name,
    include: ['react'],
    maxAttempts: 1,
  })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  return result.result as CaptureArtifact
}

describe('capture manager artifacts', () => {
  it('retains invocation args, content integrity, and a bounded summary-first read', async () => {
    const captures = manager()
    const created = await createCapture(captures, 'baseline')

    expect(created.sections.react?.tools.react_get_renders?.args).toEqual({
      sort: 'renders',
      limit: 50,
      appOnly: true,
    })
    expect(created.summary).toMatchObject({
      sectionStatus: { react: 'ok' },
      metrics: { 'react.commits': 4, 'react.renders': 3 },
    })
    expect(verifyCaptureIntegrity(created)).toBe(true)
    expect(verifyCaptureIntegrity(captureArtifactSchema.parse(created))).toBe(true)

    const summary = await captures.invoke('devtools_capture_read', {
      captureId: created.captureId,
    })
    expect(summary.ok).toBe(true)
    if (!summary.ok) throw new Error(summary.error)
    expect(summary.result).toMatchObject({
      captureId: created.captureId,
      availableSections: ['react'],
    })
    expect(summary.result).not.toHaveProperty('sections')

    const selected = await captures.invoke('devtools_capture_read', {
      captureId: created.captureId,
      view: 'full',
      sections: ['react'],
    })
    expect(selected.ok).toBe(true)
    if (!selected.ok) throw new Error(selected.error)
    expect(verifyCaptureIntegrity(selected.result as CaptureArtifact)).toBe(true)
  })

  it('keeps integrity valid after pinning and protocol parsing for export', async () => {
    const captures = manager()
    const created = await createCapture(captures, 'pin-then-export')

    const pinned = await captures.invoke('devtools_capture_pin', {
      captureId: created.captureId,
      pinned: true,
    })
    expect(pinned.ok).toBe(true)

    const full = await captures.invoke('devtools_capture_read', {
      captureId: created.captureId,
      view: 'full',
    })
    expect(full.ok).toBe(true)
    if (!full.ok) throw new Error(full.error)

    const exportShape = captureArtifactSchema.parse(full.result)
    expect(exportShape.pinned).toBe(true)
    expect(verifyCaptureIntegrity(exportShape)).toBe(true)

    exportShape.name = 'tampered'
    expect(verifyCaptureIntegrity(exportShape)).toBe(false)
  })

  it('summarizes pending query work as fetching plus mutations', async () => {
    const captures = manager()
    const result = await captures.invoke('devtools_capture_create', {
      name: 'query-summary',
      include: ['query'],
      maxAttempts: 1,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.result).toMatchObject({
      summary: { metrics: { 'query.pending': 3 } },
    })
  })

  it('uses document commit IDs for consistency even when the profile count is frozen', async () => {
    let renderProbe = 0
    const captures = new CaptureManager({
      resolveSession: () => session,
      unknownSessionError: (target) => `unknown ${target}`,
      isCurrentSession: () => true,
      request: async (_session, tool) => {
        if (tool === 'react_get_renders') {
          renderProbe += 1
          return {
            ok: true,
            result: {
              commits: 4,
              documentCommitId: renderProbe === 1 ? 10 : 11,
              summary: { totalRenders: 0, semantics: 'exact' },
              comparable: true,
            },
          }
        }
        return { ok: true, result: { commits: 4 } }
      },
    })

    const result = await captures.invoke('devtools_capture_create', {
      name: 'commit-changed-while-profile-frozen',
      include: ['react'],
      maxAttempts: 1,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.result).toMatchObject({
      consistency: {
        kind: 'best-effort',
        reactCommit: null,
        reason: 'React continued committing across every capture attempt.',
      },
      complete: false,
    })
  })

  it('warns near capacity and evicts the oldest unpinned capture before a pinned one', async () => {
    const captures = manager()
    const created: CaptureArtifact[] = []
    for (let index = 0; index < 20; index += 1) {
      created.push(await createCapture(captures, `capture-${index}`))
    }
    const first = created[0]
    const second = created[1]
    if (!first || !second) throw new Error('capture setup failed')
    expect(created.at(-1)?.warnings.some((warning) => warning.includes('Retention is 20/20'))).toBe(
      true,
    )

    const pinned = await captures.invoke('devtools_capture_pin', {
      captureId: first.captureId,
      pinned: true,
    })
    expect(pinned.ok).toBe(true)
    await createCapture(captures, 'overflow')

    const list = await captures.invoke('devtools_capture_list', {})
    expect(list.ok).toBe(true)
    if (!list.ok) throw new Error(list.error)
    const ids = (list.result as { captures: Array<{ captureId: string }> }).captures.map(
      ({ captureId }) => captureId,
    )
    expect(ids).toContain(first.captureId)
    expect(ids).not.toContain(second.captureId)
  })

  it('refuses creation instead of evicting when every retention slot is pinned', async () => {
    const captures = manager()
    for (let index = 0; index < 20; index += 1) {
      const capture = await createCapture(captures, `pinned-${index}`)
      const result = await captures.invoke('devtools_capture_pin', {
        captureId: capture.captureId,
        pinned: true,
      })
      expect(result.ok).toBe(true)
    }

    const overflow = await captures.invoke('devtools_capture_create', {
      name: 'refused',
      include: ['react'],
      maxAttempts: 1,
    })
    expect(overflow).toMatchObject({ ok: false, errorCode: 'tool-error' })
    if (overflow.ok) throw new Error('expected refusal')
    expect(overflow.error).toContain('All 20 retained captures are pinned')
  })
})
