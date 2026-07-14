import type { BridgeStatusMessage } from 'genie-react/protocol'
import { isRecord } from './guards'

export type ToolDescriptor = BridgeStatusMessage['tools'][number]

export type ToolsSelection =
  | { kind: 'tool'; tool: ToolDescriptor }
  | { kind: 'group'; tools: ToolDescriptor[] }
  | { kind: 'unknown'; message: string }

/** Exact tool name → its full contract; exact group → that group's listing; else suggestions, never a full dump. */
export function resolveToolsSelector(tools: ToolDescriptor[], selector: string): ToolsSelection {
  const tool = tools.find((candidate) => candidate.name === selector)
  if (tool) return { kind: 'tool', tool }
  const inGroup = tools.filter((candidate) => candidate.group === selector)
  if (inGroup.length > 0) return { kind: 'group', tools: inGroup }

  const needle = selector.toLowerCase()
  const near = tools
    .map((candidate) => candidate.name)
    .filter((name) => name.includes(needle))
    .slice(0, 5)
  const groups = [...new Set(tools.map((candidate) => candidate.group))].sort()
  const hint = near.length > 0 ? `Did you mean: ${near.join(', ')}? ` : ''
  return {
    kind: 'unknown',
    message: `Unknown tool or group "${selector}". ${hint}Groups: ${groups.join(', ')}`,
  }
}

const ACTION_PREFIXES: Record<string, string[]> = {
  router: ['router_'],
  query: ['query_', 'mutation_'],
  'react.render': ['react_'],
  'react.inspect': ['react_'],
  'react.tree': ['react_'],
  'react.profile': ['react_'],
  plugin: ['plugin_'],
}

/** Mutations pool in the generic action group; surface a domain's actions beside its reads. */
export function relatedActions(tools: ToolDescriptor[], group: string): string[] {
  const prefixes = ACTION_PREFIXES[group]
  if (!prefixes) return []
  return tools
    .filter(
      (tool) => tool.group === 'action' && prefixes.some((prefix) => tool.name.startsWith(prefix)),
    )
    .map((tool) => tool.name)
}

export function groupIndex(
  appName: string | undefined,
  tools: ToolDescriptor[],
): {
  app: string | null
  total: number
  groups: Array<{ group: string; count: number; tools: string[] }>
} {
  const byGroup = new Map<string, string[]>()
  for (const tool of tools) {
    const list = byGroup.get(tool.group) ?? []
    list.push(tool.name)
    byGroup.set(tool.group, list)
  }
  return {
    app: appName ?? null,
    total: tools.length,
    groups: [...byGroup]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, names]) => ({ group, count: names.length, tools: names })),
  }
}

/** Layer 1 of tool discovery: groups, counts, and a short name preview. */
export function formatGroupIndex(appName: string | undefined, tools: ToolDescriptor[]): string {
  const groups = groupIndex(appName, tools).groups
  const width = Math.max(0, ...groups.map((group) => group.group.length))
  const lines = [`${tools.length} tools from ${appName ?? 'the app'} · ${groups.length} groups`, '']
  for (const group of groups) {
    const preview =
      group.tools.slice(0, 3).join(', ') +
      (group.tools.length > 3 ? `, +${group.tools.length - 3} more` : '')
    lines.push(`  ${group.group.padEnd(width)} ${String(group.count).padStart(2)} — ${preview}`)
  }
  lines.push(
    '',
    'drill in: genie-react tools <group> · one tool: genie-react tools <tool> · everything: genie-react tools --all',
  )
  return lines.join('\n')
}

/** Layer 3 of tool discovery: one complete contract and a runnable example. */
export function formatToolDetail(tool: ToolDescriptor): string {
  const lines = [
    `${tool.name} — ${tool.title} [${tool.group}]`,
    '',
    tool.description,
    '',
    'params:',
  ]
  const object = objectSchema(tool.inputJsonSchema)
  const properties = object && isRecord(object.properties) ? object.properties : {}
  const required = new Set(Array.isArray(object?.required) ? object.required : [])
  const names = Object.keys(properties)
  if (names.length === 0) lines.push('  (none)')
  for (const name of names) {
    const property = properties[name]
    appendSchemaProperty(lines, name, property, required.has(name), 2, 0)
  }
  lines.push('', `example: genie-react call ${tool.name} '${exampleArgs(properties, required)}'`)
  return lines.join('\n')
}

function appendSchemaProperty(
  lines: string[],
  path: string,
  schema: unknown,
  required: boolean,
  indent: number,
  depth: number,
): void {
  const parts = [`${' '.repeat(indent)}${path}${required ? '' : '?'}: ${jsonSchemaType(schema)}`]
  if (isRecord(schema)) {
    const constraints = jsonSchemaConstraints(schema)
    if (constraints) parts.push(constraints)
    if (schema.default !== undefined) parts.push(`(default ${JSON.stringify(schema.default)})`)
    if (typeof schema.description === 'string') parts.push(`— ${schema.description}`)
  }
  lines.push(parts.join(' '))
  if (depth >= 5 || !isRecord(schema)) return

  const nested = nestedObjectSchema(schema)
  if (!nested || !isRecord(nested.properties)) return
  const nestedRequired = new Set(Array.isArray(nested.required) ? nested.required : [])
  const prefix = schema.type === 'array' ? `${path}[]` : path
  for (const [name, child] of Object.entries(nested.properties)) {
    appendSchemaProperty(
      lines,
      `${prefix}.${name}`,
      child,
      nestedRequired.has(name),
      indent + 2,
      depth + 1,
    )
  }
}

function nestedObjectSchema(schema: Record<string, unknown>): Record<string, unknown> | null {
  if (schema.type === 'array' && isRecord(schema.items)) return objectSchema(schema.items)
  const direct = objectSchema(schema)
  if (direct?.properties !== schema.properties || isRecord(schema.properties)) return direct
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) {
      const found = isRecord(branch) ? nestedObjectSchema(branch) : null
      if (found) return found
    }
  }
  return null
}

export function slimDescriptor(tool: ToolDescriptor): {
  name: string
  title: string
  params: string
} {
  return { name: tool.name, title: tool.title, params: describeToolParams(tool.inputJsonSchema) }
}

/** Renders the complete catalog grouped by domain; optional params carry a question mark. */
export function formatToolsListing(status: {
  app?: { name?: string } | null
  tools: ToolDescriptor[]
}): string {
  const lines: string[] = [`${status.tools.length} tools from ${status.app?.name ?? 'the app'}:`]
  const groups = new Map<string, ToolDescriptor[]>()
  for (const tool of status.tools) {
    const list = groups.get(tool.group) ?? []
    list.push(tool)
    groups.set(tool.group, list)
  }
  for (const [group, tools] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push('', `  ${group}`)
    for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(
        `    ${tool.name} — ${tool.title}`,
        `      ${describeToolParams(tool.inputJsonSchema)}`,
      )
    }
  }
  return lines.join('\n')
}

function exampleArgs(properties: Record<string, unknown>, required: Set<unknown>): string {
  const example: Record<string, unknown> = {}
  for (const name of Object.keys(properties)) {
    if (required.has(name)) example[name] = examplePropValue(properties[name], name)
  }
  return JSON.stringify(example)
}

function examplePropValue(schema: unknown, name: string): unknown {
  if (isRecord(schema)) {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
    if (schema.default !== undefined) return schema.default
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
    if (type === 'number' || type === 'integer') return 1
    if (type === 'boolean') return true
    if (type === 'array') return []
    if (type === 'object') return {}
  }
  return `<${name}>`
}

function describeToolParams(schema: unknown): string {
  const object = objectSchema(schema)
  const properties = object && isRecord(object.properties) ? object.properties : {}
  const names = Object.keys(properties)
  if (names.length === 0) return '(no args)'
  const required = new Set(Array.isArray(object?.required) ? object.required : [])
  return names
    .map((name) => `${name}${required.has(name) ? '' : '?'}: ${jsonSchemaType(properties[name])}`)
    .join(', ')
}

/** Finds the object node carrying properties, including refined schemas wrapped in allOf. */
function objectSchema(schema: unknown): Record<string, unknown> | null {
  if (!isRecord(schema)) return null
  if (isRecord(schema.properties)) return schema
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      const found = objectSchema(part)
      if (found) return found
    }
  }
  return null
}

function jsonSchemaType(schema: unknown): string {
  if (!isRecord(schema)) return 'any'
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ')
  if (Array.isArray(schema.anyOf)) return [...new Set(schema.anyOf.map(jsonSchemaType))].join(' | ')
  if (typeof schema.type === 'string') return schema.type
  if (Array.isArray(schema.type)) return schema.type.join(' | ')
  return 'any'
}

function jsonSchemaConstraints(schema: Record<string, unknown>): string | null {
  const numberRange = range(schema.minimum, schema.maximum)
  if (numberRange) return numberRange
  const lengthRange = range(schema.minLength, schema.maxLength, 'length ')
  if (lengthRange) return lengthRange
  return range(schema.minItems, schema.maxItems, 'items ')
}

function range(minimum: unknown, maximum: unknown, label = ''): string | null {
  const min = typeof minimum === 'number' ? minimum : null
  const max = typeof maximum === 'number' ? maximum : null
  if (min !== null && max !== null) return `[${label}${min}..${max}]`
  if (min !== null) return `[${label}>=${min}]`
  if (max !== null) return `[${label}<=${max}]`
  return null
}
