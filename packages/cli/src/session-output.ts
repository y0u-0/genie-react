import { isRecord } from './guards'

export function summarizeStatus(result: unknown): string | null {
  if (!isRecord(result) || typeof result.connected !== 'boolean') return null
  if (!result.connected) {
    return 'not connected — open the app in a browser (devtools_wait blocks until it connects)'
  }
  const app = isRecord(result.app) ? result.app : {}
  const head = [
    result.ready === false ? 'connected · initializing' : 'connected · ready',
    typeof app.name === 'string' ? app.name : null,
    typeof app.reactVersion === 'string' ? `react ${app.reactVersion}` : null,
    `${num(result.toolCount)} tools`,
  ]
    .filter(Boolean)
    .join(' · ')
  const sessions = Array.isArray(result.sessions) ? result.sessions.filter(isRecord) : []
  if (sessions.length <= 1) return head
  const lines = [`${head} · ${sessions.length} sessions`]
  for (const session of sessions) {
    const sessionApp = isRecord(session.app) ? session.app : {}
    const parts = [`  ${String(session.sessionId)}`]
    if (typeof sessionApp.name === 'string') parts.push(sessionApp.name)
    if (typeof sessionApp.url === 'string') parts.push(sessionApp.url)
    if (session.current === true) parts.push('(current)')
    if (session.ready === false) parts.push('(initializing)')
    if (typeof session.sessionName === 'string') parts.push(`name=${session.sessionName}`)
    if (typeof session.documentGeneration === 'number')
      parts.push(`generation=${session.documentGeneration}`)
    if (typeof session.staleMs === 'number')
      parts.push(
        `(stale — no heartbeat for ${Math.round(session.staleMs / 1000)}s, likely a dead tab)`,
      )
    lines.push(parts.join(' · '))
  }
  lines.push('target one: --session <target> (or set GENIE_SESSION once per shell)')
  return lines.join('\n')
}

export function summarizeSessionsOnly(result: {
  connected: boolean
  ready: boolean
  sessionId: string | null
  sessions: unknown[]
}): string {
  if (!result.connected) return 'not connected'
  const sessions = result.sessions.filter(isRecord)
  const lines = [`${sessions.length} session${sessions.length === 1 ? '' : 's'}`]
  for (const session of sessions) {
    const parts = [String(session.sessionId)]
    if (typeof session.sessionName === 'string') parts.push(`name=${session.sessionName}`)
    if (typeof session.logicalSessionId === 'string')
      parts.push(`logical=${session.logicalSessionId}`)
    if (typeof session.documentGeneration === 'number')
      parts.push(`generation=${session.documentGeneration}`)
    parts.push(session.ready === false ? 'initializing' : 'ready')
    if (session.current === true) parts.push('current')
    lines.push(`  ${parts.join(' · ')}`)
  }
  return lines.join('\n')
}

const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
