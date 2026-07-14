import { describe, expect, it } from 'vitest'
import type { ToolDescriptor } from '../protocol'
import { InteractionManager, type InteractionSession } from './interaction-manager'

const toolNames = [
  'react_clear_renders',
  'react_profile_stop',
  'react_get_renders',
  'react_render_causes',
  'react_effect_timeline',
]
const tools: ToolDescriptor[] = toolNames.map((name) => ({
  name,
  title: name,
  description: name,
  group: 'react.render',
}))

function session(sessionId: string): InteractionSession {
  return { sessionId, app: { name: sessionId }, tools }
}

describe('InteractionManager', () => {
  it('prunes disconnected recordings before enforcing the active interaction cap', async () => {
    const sessions = new Map<string, InteractionSession>()
    const current = new Set<string>()
    for (let index = 0; index < 21; index += 1) {
      const next = session(`session-${index}`)
      sessions.set(next.sessionId, next)
      current.add(next.sessionId)
    }
    const manager = new InteractionManager({
      resolveSession: (target) => (target ? (sessions.get(target) ?? null) : null),
      unknownSessionError: (target) => `unknown ${target}`,
      isCurrentSession: (candidate) => current.has(candidate.sessionId),
      request: async (_candidate, tool) => ({
        ok: true,
        result:
          tool === 'react_clear_renders'
            ? { documentCommitId: 1, observation: { id: 'observation:test' } }
            : {},
      }),
      settle: async () => ({ ok: true, waitedMs: 0, domains: {} }),
    })

    for (let index = 0; index < 20; index += 1) {
      expect(
        await manager.invoke(
          'devtools_interaction_begin',
          { name: `interaction-${index}` },
          `session-${index}`,
        ),
      ).toMatchObject({ ok: true })
    }

    current.clear()
    current.add('session-20')
    expect(
      await manager.invoke(
        'devtools_interaction_begin',
        { name: 'after disconnects' },
        'session-20',
      ),
    ).toMatchObject({ ok: true })
  })

  it('marks an interaction not comparable when effect capture coverage is incomplete', async () => {
    const active = session('active-session')
    let renderReads = 0
    const manager = new InteractionManager({
      resolveSession: () => active,
      unknownSessionError: (target) => `unknown ${target}`,
      isCurrentSession: () => true,
      request: async (_candidate, tool) => {
        if (tool === 'react_clear_renders') {
          return {
            ok: true,
            result: { documentCommitId: 1, observation: { id: 'observation:test' } },
          }
        }
        if (tool === 'react_profile_stop') {
          return { ok: true, result: { tracking: false, commits: 1 } }
        }
        if (tool === 'react_get_renders') {
          renderReads += 1
          return {
            ok: true,
            result: {
              commits: 1,
              documentCommitId: 1 + renderReads,
              observation: { id: 'observation:test' },
              comparable: true,
              coverage: { complete: true },
            },
          }
        }
        if (tool === 'react_render_causes') {
          return { ok: true, result: { coverage: { complete: true } } }
        }
        return { ok: true, result: { coverage: { complete: false } } }
      },
      settle: async () => ({
        ok: true,
        waitedMs: 0,
        domains: { react: { status: 'met' } },
      }),
    })

    const began = await manager.invoke('devtools_interaction_begin', { name: 'effect gap' })
    expect(began.ok).toBe(true)
    if (!began.ok) throw new Error(began.error)
    const interactionId = (began.result as { interactionId: string }).interactionId
    const stopped = await manager.invoke('devtools_interaction_stop', { interactionId })

    expect(stopped.ok).toBe(true)
    if (!stopped.ok) throw new Error(stopped.error)
    expect(stopped.result).toMatchObject({
      coverage: {
        complete: false,
        comparable: false,
        notComparableReasons: ['effect-coverage-incomplete'],
      },
    })
  })
})
