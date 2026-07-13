import { newId } from '../protocol'

const LOGICAL_SESSION_KEY = 'genie-react:logical-session-id'
const DOCUMENT_GENERATION_KEY = 'genie-react:document-generation'
const RUNTIME_IDENTITY_KEY = Symbol.for('genie-react:runtime-session-identity')

interface SessionStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface SessionIdentity {
  /** Stable for the lifetime of a browser tab, including document reloads. */
  logicalSessionId: string
  /** Increases whenever that tab creates a new document. */
  documentGeneration: number
}

type IdentityGlobal = typeof globalThis & {
  [RUNTIME_IDENTITY_KEY]?: SessionIdentity
}

/** Creates one document identity from best-effort per-tab storage; restricted and non-browser runtimes fall back to process-local state. */
export function createSessionIdentity(storage?: SessionStorageLike): SessionIdentity {
  let logicalSessionId: string | null = null
  let previousGeneration = 0

  if (storage) {
    try {
      logicalSessionId = storage.getItem(LOGICAL_SESSION_KEY)
      const storedGeneration = Number(storage.getItem(DOCUMENT_GENERATION_KEY))
      if (Number.isSafeInteger(storedGeneration) && storedGeneration >= 0) {
        previousGeneration = storedGeneration
      }
    } catch {
      // Storage access can throw in sandboxed/privacy-restricted documents.
    }
  }

  logicalSessionId ||= newId()
  const documentGeneration = previousGeneration + 1

  if (storage) {
    try {
      storage.setItem(LOGICAL_SESSION_KEY, logicalSessionId)
      storage.setItem(DOCUMENT_GENERATION_KEY, String(documentGeneration))
    } catch {
      // The in-memory identity remains valid when persistence is unavailable.
    }
  }

  return { logicalSessionId, documentGeneration }
}

/** One identity per JS document; `Symbol.for` keeps it stable across HMR module re-evaluation. */
export function runtimeSessionIdentity(): SessionIdentity {
  const runtime = globalThis as IdentityGlobal
  runtime[RUNTIME_IDENTITY_KEY] ??= createSessionIdentity(readSessionStorage())
  return runtime[RUNTIME_IDENTITY_KEY]
}

function readSessionStorage(): SessionStorageLike | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}
