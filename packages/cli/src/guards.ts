/** The CLI's single unknown→indexable-record narrowing, shared by every untyped boundary so none re-derives it. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
