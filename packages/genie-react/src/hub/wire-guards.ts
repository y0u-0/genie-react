// The single runtime-checked seam for untyped wire JSON: each accessor proves its container, fields stay `unknown` for callers to narrow.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Peeks `kind` before schema selection; malformed frames yield `undefined` and get rejected by `schema.parse` instead of throwing. */
export function frameKind(frame: unknown): string | undefined {
  if (isRecord(frame) && typeof frame.kind === 'string') return frame.kind
  return undefined
}

/** The `matches` array from a `react_find_components` result, or `undefined`. */
export function matchesOf(result: unknown): unknown[] | undefined {
  if (isRecord(result) && Array.isArray(result.matches)) return result.matches
  return undefined
}

/** The `queries` from a `query_list` result (non-record entries become `{}`), or `undefined`. */
export function parseQueryList(result: unknown): Record<string, unknown>[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.queries)) return undefined
  return result.queries.map((entry) => (isRecord(entry) ? entry : {}))
}

/** One `query_get` result as a record, or `undefined`. */
export function queryStateOf(result: unknown): Record<string, unknown> | undefined {
  return isRecord(result) ? result : undefined
}

/** The `router_get_state` result as a record, or `undefined`. */
export function routerStateOf(result: unknown): Record<string, unknown> | undefined {
  return isRecord(result) ? result : undefined
}
