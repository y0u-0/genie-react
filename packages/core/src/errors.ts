/** Canonical message for an unknown thrown value — the one place deciding how non-`Error` throws render. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
