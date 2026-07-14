import { describe, expect, it } from 'vitest'
import { createSessionIdentity, createSessionName, forkSessionIdentity } from './session-identity'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('session identity', () => {
  it('keeps one logical tab id while increasing the document generation after reload', () => {
    const storage = new MemoryStorage()
    const first = createSessionIdentity(storage)
    const reloaded = createSessionIdentity(storage)

    expect(reloaded.logicalSessionId).toBe(first.logicalSessionId)
    expect(first.documentGeneration).toBe(1)
    expect(reloaded.documentGeneration).toBe(2)
  })

  it('persists an auto-fork so cloned browser state stays distinct after reload', () => {
    const storage = new MemoryStorage()
    const identity = createSessionIdentity(storage)

    forkSessionIdentity(identity, 'forked-logical-id', 1, storage)
    const reloaded = createSessionIdentity(storage)

    expect(identity).toEqual({ logicalSessionId: 'forked-logical-id', documentGeneration: 1 })
    expect(reloaded).toEqual({ logicalSessionId: 'forked-logical-id', documentGeneration: 2 })
  })

  it('still creates a usable identity when session storage is blocked', () => {
    const blockedStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }

    expect(createSessionIdentity(blockedStorage)).toMatchObject({ documentGeneration: 1 })
  })

  it('keeps the tab alias after a route removes the URL marker and the document reloads', () => {
    const storage = new MemoryStorage()

    expect(createSessionName('review-router', storage)).toBe('review-router')
    expect(createSessionName(undefined, storage)).toBe('review-router')
  })

  it('does not restore an invalid stored alias', () => {
    const storage = new MemoryStorage()
    storage.setItem('genie-react:session-name', 'line\nbreak')

    expect(createSessionName(undefined, storage)).toBeUndefined()
  })
})
