import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(docsRoot, '../..')
const toolsRoot = resolve(docsRoot, 'content/docs/tools')
const cliPath = resolve(repoRoot, 'packages/cli/dist/cli.js')
const { GENIE_BRIDGE_URL, GENIE_SESSION } = process.env

if (!GENIE_BRIDGE_URL || !GENIE_SESSION) {
  console.error('Set GENIE_BRIDGE_URL and GENIE_SESSION to one ready app before this check.')
  process.exit(1)
}

const sections = new Map()
const headingPattern = /^##\s+`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`\s*$/gm

for (const entry of readdirSync(toolsRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.mdx')) continue
  const path = resolve(toolsRoot, entry.name)
  const source = readFileSync(path, 'utf8')
  const headings = [...source.matchAll(headingPattern)]
  for (const [index, heading] of headings.entries()) {
    const start = heading.index
    const end = headings[index + 1]?.index ?? source.length
    sections.set(heading[1], source.slice(start, end))
  }
}

function runCli(...args) {
  const output = execFileSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: process.env,
  })
  return JSON.parse(output)
}

function schemaFields(schema, prefix = '') {
  if (!schema || typeof schema !== 'object') return []

  const fields = []
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key
    fields.push({ key, path, required: required.has(key) })
    fields.push(...schemaFields(child, path))
  }
  if (schema.items) fields.push(...schemaFields(schema.items, `${prefix}[]`))
  for (const branch of [
    ...(schema.allOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
  ]) {
    fields.push(...schemaFields(branch, prefix))
  }
  return fields.filter(
    (field, index, all) =>
      all.findIndex(
        (candidate) => candidate.path === field.path && candidate.required === field.required,
      ) === index,
  )
}

function inputText(section) {
  const start = section.indexOf('**Input:**')
  const end = section.indexOf('```bash', start)
  return start === -1 || end === -1 ? '' : section.slice(start, end).replaceAll(/\s+/g, ' ')
}

function requiredIsNamed(text, key) {
  return text
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => sentence.includes(`\`${key}\``) && /\brequir(?:e|es|ed)\b/i.test(sentence))
}

function exampleInput(section, toolName) {
  const blocks = [...section.matchAll(/^```bash[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)]
  for (const block of blocks) {
    const marker = new RegExp(`\\bcall\\s+${toolName.replaceAll('_', '\\_')}\\b`).exec(block[1])
    if (!marker) continue
    const rest = block[1].slice(marker.index + marker[0].length)
    const argument = /(?:\\\r?\n\s*)?('([\s\S]*?)'|\{[^\n]*\})/.exec(rest)
    if (!argument) continue
    const raw = argument[2] ?? argument[1]
    try {
      return JSON.parse(raw)
    } catch {}
  }
  return null
}

function exampleOutput(section) {
  const start = section.indexOf('**Output (selected fields):**')
  if (start === -1) return null
  const match = /^```json[^\n]*\n([\s\S]*?)^```[ \t]*$/m.exec(section.slice(start))
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

function validateSelectedFields(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return []
  for (const alternatives of [schema.anyOf, schema.oneOf]) {
    if (!Array.isArray(alternatives)) continue
    const attempts = alternatives.map((branch) => validateSelectedFields(value, branch, path))
    const passing = attempts.find((problems) => problems.length === 0)
    return passing ?? attempts[0]
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.flatMap((branch) => validateSelectedFields(value, branch, path))
  }

  const problems = []
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {}
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) {
        problems.push(...validateSelectedFields(child, properties[key], `${path}.${key}`))
      } else if (schema.additionalProperties === false) {
        problems.push(`${path}.${key} is not in the live output schema`)
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        problems.push(
          ...validateSelectedFields(child, schema.additionalProperties, `${path}.${key}`),
        )
      }
    }
  } else if (Array.isArray(value) && schema.items) {
    for (const [index, child] of value.entries()) {
      problems.push(...validateSelectedFields(child, schema.items, `${path}[${index}]`))
    }
  }
  return problems
}

function validateValue(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return []
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.flatMap((branch) => validateValue(value, branch, path))
  }
  for (const alternatives of [schema.anyOf, schema.oneOf]) {
    if (!Array.isArray(alternatives)) continue
    if (alternatives.some((branch) => validateValue(value, branch, path).length === 0)) return []
    return [`${path} does not match any allowed schema branch`]
  }

  const type = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const actual = Array.isArray(value)
    ? 'array'
    : value === null
      ? 'null'
      : Number.isInteger(value)
        ? 'integer'
        : typeof value === 'number'
          ? 'number'
          : typeof value
  if (
    type.length > 0 &&
    !type.includes(actual) &&
    !(actual === 'integer' && type.includes('number')) &&
    !(actual === 'object' && value !== null && !Array.isArray(value))
  ) {
    return [`${path} must be ${type.join(' or ')}, got ${actual}`]
  }
  if (schema.const !== undefined && value !== schema.const)
    return [`${path} must equal ${schema.const}`]
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return [`${path} must be one of ${schema.enum.join(', ')}`]
  }

  const problems = []
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${path}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) problems.push(`${path}.${key} is not allowed`)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) problems.push(...validateValue(child, properties[key], `${path}.${key}`))
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${path} needs at least ${schema.minItems} items`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      problems.push(`${path} allows at most ${schema.maxItems} items`)
    }
    for (const [index, child] of value.entries()) {
      problems.push(...validateValue(child, schema.items, `${path}[${index}]`))
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`${path} needs at least ${schema.minLength} characters`)
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push(`${path} allows at most ${schema.maxLength} characters`)
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${path} must be at least ${schema.minimum}`)
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${path} must be at most ${schema.maximum}`)
    }
  }
  return problems
}

const listing = runCli('tools', '--json')
const toolNames = listing.groups.flatMap((group) => group.tools).sort()
const errors = []

for (const toolName of toolNames) {
  const descriptor = runCli('tools', toolName, '--json')
  const section = sections.get(toolName)
  if (!section) {
    errors.push(`${toolName}: missing tool section`)
    continue
  }

  const documentedInput = inputText(section)
  const fields = schemaFields(descriptor.inputJsonSchema)
  for (const field of fields) {
    if (!documentedInput.includes(`\`${field.key}\``)) {
      errors.push(`${toolName}: input field ${field.path} is not named in the Input section`)
    }
    if (field.required && !requiredIsNamed(documentedInput, field.key)) {
      errors.push(`${toolName}: required input ${field.path} is not marked required`)
    }
  }

  const example = exampleInput(section, toolName)
  if (example === null) {
    errors.push(`${toolName}: no static JSON call example could be validated`)
  } else {
    for (const problem of validateValue(example, descriptor.inputJsonSchema)) {
      errors.push(`${toolName}: example ${problem}`)
    }
  }

  if (descriptor.outputJsonSchema) {
    const output = exampleOutput(section)
    if (output === null) {
      errors.push(`${toolName}: no selected JSON output example could be validated`)
    } else {
      for (const problem of validateSelectedFields(output, descriptor.outputJsonSchema)) {
        errors.push(`${toolName}: output example ${problem}`)
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`Live contract/docs check failed with ${errors.length} errors:`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(
  `Live contract/docs check passed: ${toolNames.length} runtime tools, nested inputs documented, required fields marked, calls schema-valid, and selected outputs checked when the runtime exposes an output schema.`,
)
