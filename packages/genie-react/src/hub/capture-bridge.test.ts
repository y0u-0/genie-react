import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '../protocol'
import { isResult, open, send } from './bridge-test-harness'
import { createStandaloneBridge, type StandaloneBridgeHandle } from './standalone'

describe('capture bridge validation', () => {
  let handle: StandaloneBridgeHandle
  let url: string

  beforeEach(async () => {
    handle = createStandaloneBridge()
    url = (await handle.listen()).url
  })

  afterEach(async () => {
    await handle.close()
  })

  it('returns actionable, terminal-safe argument errors', async () => {
    const { ws: agent, inbox } = await open(`${url}?role=agent`)
    const id = newId()
    send(agent, {
      kind: 'agent/invoke',
      id,
      tool: 'devtools_capture_create',
      args: { name: '', 'unknown\nkey': true },
    })

    const result = await inbox.wait(isResult(id))
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('invalid-args')
    expect(result.error).toContain('name: capture name is required')
    expect(result.error).not.toContain('\n')
  })
})
