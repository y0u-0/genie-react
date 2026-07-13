/** Canonical message for an unknown thrown value — the one place deciding how non-`Error` throws render. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ValidationIssue {
  path: readonly PropertyKey[]
  message: string
}

/** Stable, bounded validation text shared by browser tools and bridge-local tools. */
export function formatToolValidationError(
  tool: string,
  issues: readonly ValidationIssue[],
): string {
  const details = issues
    .slice(0, 3)
    .map((issue) => `${jsonPointer(issue.path)}: ${safeDiagnostic(issue.message)}`)
    .join('; ')
  return `Invalid arguments for "${safeDiagnostic(tool)}": ${details || '/: invalid arguments'}`
}

/** RFC 6901 JSON Pointer keeps nested object/array failures unambiguous and shell-copyable. */
export function jsonPointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '/'
  return `/${path
    .map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`
}

function safeDiagnostic(value: string): string {
  const printable = [...value]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0
      return point <= 31 || point === 127 ? '?' : character
    })
    .join('')
  return printable.length > 200 ? `${printable.slice(0, 200)}…` : printable
}
