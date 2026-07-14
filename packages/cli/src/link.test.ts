import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLink } from './link'

let target: string | null = null

afterEach(async () => {
  vi.restoreAllMocks()
  if (target) await rm(target, { recursive: true, force: true })
  target = null
})

describe('runLink', () => {
  it('installs and refreshes the versioned agent skill with the linked packages', async () => {
    target = await mkdtemp(join(tmpdir(), 'genie-link-'))
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const bundled = await readFile(join(process.cwd(), 'packages/cli/skill/SKILL.md'), 'utf8')
    const activePath = join(target, '.agents/skills/genie/SKILL.md')

    expect(runLink({ cwd: target, genieRoot: process.cwd() })).toBe(0)
    expect(await readFile(activePath, 'utf8')).toBe(bundled)

    await writeFile(activePath, 'stale guidance\n', 'utf8')
    expect(runLink({ cwd: target, genieRoot: process.cwd() })).toBe(0)
    expect(await readFile(activePath, 'utf8')).toBe(bundled)
  })
})
