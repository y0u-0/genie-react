import { describe, expect, it } from 'vitest'
import { createSessionIdentity } from './session-identity'

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
})
