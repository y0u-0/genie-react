import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(docsRoot, '../..')
const contentRoot = resolve(docsRoot, 'content/docs')
const toolsRoot = resolve(contentRoot, 'tools')
const contractsRoot = resolve(repoRoot, 'packages/genie-react/src')
const errors = []

function displayPath(path) {
  return relative(repoRoot, path).split(sep).join('/')
}

function addError(path, message) {
  errors.push(`${displayPath(path)}: ${message}`)
}

function entries(path) {
  return readdirSync(path, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'))
}

function filesBelow(root, extension) {
  const files = []

  function visit(directory) {
    for (const entry of entries(directory)) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && extname(entry.name) === extension) files.push(path)
    }
  }

  visit(root)
  return files.sort()
}

function parseRequiredText(rawValue) {
  const value = rawValue?.trim()
  if (!value || value === '|' || value === '>') return null
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      return typeof parsed === 'string' && parsed.trim() ? parsed : null
    } catch {
      return null
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return null
    const parsed = value.slice(1, -1).replaceAll("''", "'")
    return parsed.trim() ? parsed : null
  }
  if (/^(?:null|true|false|~)$/i.test(value) || /^[{[]/.test(value)) return null
  return value
}

function validateFrontmatter(path, source) {
  const lines = source.split(/\r?\n/)
  if (lines[0] !== '---') {
    addError(path, 'frontmatter must start on the first line with ---')
    return
  }

  const end = lines.indexOf('---', 1)
  if (end === -1) {
    addError(path, 'frontmatter is missing its closing ---')
    return
  }

  const fields = new Map()
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]
    if (!line.trim() || /^\s/.test(line)) continue
    const field = /^([A-Za-z][\w-]*):(?:\s*(.*))?$/.exec(line)
    if (!field) {
      addError(path, `frontmatter line ${index + 1} is not a valid top-level field`)
      continue
    }
    const [, key, rawValue] = field
    if (fields.has(key)) addError(path, `frontmatter field "${key}" is duplicated`)
    else fields.set(key, rawValue)
  }

  for (const field of ['title', 'description']) {
    if (!parseRequiredText(fields.get(field))) {
      addError(path, `frontmatter field "${field}" must be a non-empty single-line string`)
    }
  }

  if (!lines.slice(end + 1).some((line) => line.trim())) {
    addError(path, 'page body is empty')
  }
}

function validateJsonExamples(path, source) {
  const examples = [...source.matchAll(/^```json[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)]

  for (const example of examples) {
    const body = example[1].trim()
    try {
      JSON.parse(body)
    } catch (error) {
      addError(
        path,
        `line ${lineAt(source, example.index)} has invalid JSON (${error instanceof Error ? error.message : error})`,
      )
    }
    if (!body.includes('\n') && body.length > 160) {
      addError(
        path,
        `line ${lineAt(source, example.index)} has dense one-line JSON; format it for scanning`,
      )
    }
  }

  if (
    path.startsWith(`${toolsRoot}${sep}`) &&
    examples.length > 0 &&
    !source.includes('The JSON examples below show selected fields from the full response.')
  ) {
    addError(path, 'tool pages with JSON examples must say that the examples show selected fields')
  }

  return examples.length
}

function validateBashExamples(path, source) {
  const examples = [...source.matchAll(/^```bash[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)]

  const combinedResult =
    examples.length === 0
      ? null
      : spawnSync('bash', ['-n'], {
          input: examples.map((example) => example[1]).join('\n\n'),
          encoding: 'utf8',
        })

  if (combinedResult && combinedResult.status !== 0) {
    for (const example of examples) {
      const result = spawnSync('bash', ['-n'], {
        input: example[1],
        encoding: 'utf8',
      })
      if (result.status === 0) continue
      const detail = result.stderr.trim().split(/\r?\n/).at(-1) ?? 'unknown syntax error'
      addError(path, `line ${lineAt(source, example.index)} has invalid bash (${detail})`)
    }
  }

  if (source.includes('/__genie/bridge')) {
    addError(path, 'bridge commands must use the /__genie/ws WebSocket endpoint')
  }

  return examples.length
}

function hasDocs(directory) {
  for (const entry of entries(directory)) {
    if (entry.isFile() && extname(entry.name) === '.mdx') return true
    if (entry.isDirectory() && hasDocs(resolve(directory, entry.name))) return true
  }
  return false
}

function validateNavigation(directory) {
  const metaPath = resolve(directory, 'meta.json')
  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (error) {
    addError(metaPath, `cannot read valid JSON (${error instanceof Error ? error.message : error})`)
    return
  }

  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    addError(metaPath, 'navigation metadata must be an object')
    return
  }
  if (typeof meta.title !== 'string' || !meta.title.trim()) {
    addError(metaPath, '"title" must be a non-empty string')
  }
  if ('icon' in meta && (typeof meta.icon !== 'string' || !meta.icon.trim())) {
    addError(metaPath, '"icon" must be a non-empty string when present')
  }
  if ('defaultOpen' in meta && typeof meta.defaultOpen !== 'boolean') {
    addError(metaPath, '"defaultOpen" must be a boolean when present')
  }
  if (!Array.isArray(meta.pages) || !meta.pages.every((page) => typeof page === 'string')) {
    addError(metaPath, '"pages" must be an array of strings')
    return
  }

  const directoryEntries = entries(directory)
  const available = new Set(
    directoryEntries.flatMap((entry) => {
      if (entry.isFile() && extname(entry.name) === '.mdx') {
        return [entry.name.slice(0, -extname(entry.name).length)]
      }
      if (entry.isDirectory() && hasDocs(resolve(directory, entry.name))) return [entry.name]
      return []
    }),
  )
  const listed = new Set()

  for (const page of meta.pages) {
    if (/^---.+---$/.test(page)) continue
    if (!page.trim()) {
      addError(metaPath, '"pages" cannot contain an empty entry')
      continue
    }
    if (listed.has(page)) addError(metaPath, `navigation entry "${page}" is duplicated`)
    listed.add(page)
    if (!available.has(page))
      addError(metaPath, `navigation entry "${page}" has no page or section`)
  }

  for (const page of available) {
    if (!listed.has(page))
      addError(metaPath, `page or section "${page}" is missing from navigation`)
  }

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) continue
    const child = resolve(directory, entry.name)
    if (hasDocs(child)) validateNavigation(child)
  }
}

function routeFor(path) {
  const segments = relative(contentRoot, path)
    .split(sep)
    .map((segment) => segment.replace(/\.mdx$/, ''))
  if (segments.at(-1) === 'index') segments.pop()
  return segments.length === 0 ? '/docs' : `/docs/${segments.join('/')}`
}

function maskCode(source, { inline = true } = {}) {
  let fence = null
  return source
    .split(/(?<=\n)/)
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
      if (!fence && marker) {
        fence = marker[0]
        return line.replace(/[^\n]/g, ' ')
      }
      if (fence) {
        const closesFence = line.trimStart().startsWith(fence.repeat(3))
        if (closesFence) fence = null
        return line.replace(/[^\n]/g, ' ')
      }
      return inline ? line.replace(/(`+)[^\n]*?\1/g, (match) => match.replace(/[^\n]/g, ' ')) : line
    })
    .join('')
}

function lineAt(source, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

function internalLinks(source) {
  const masked = maskCode(source)
  const patterns = [
    /\]\(\s*<?(\/docs(?:[/?#][^)\s>]*)?)>?[^)]*\)/g,
    /\b(?:href|to)\s*=\s*["'](\/docs(?:[/?#][^"']*)?)["']/g,
    /\b(?:href|to)\s*=\s*\{\s*["'](\/docs(?:[/?#][^"']*)?)["']\s*\}/g,
  ]
  const links = []
  for (const pattern of patterns) {
    for (const match of masked.matchAll(pattern)) {
      links.push({ href: match[1], line: lineAt(source, match.index) })
    }
  }
  return links
}

function normalizedLinkPath(href) {
  try {
    const path = decodeURI(new URL(href, 'https://docs.local').pathname)
    return path.length > 1 ? path.replace(/\/+$/, '') : path
  } catch {
    return null
  }
}

function liveContractNames() {
  const names = new Map()
  const contractFiles = filesBelow(contractsRoot, '.ts').filter(
    (path) => !path.endsWith('.test.ts') && !path.endsWith('.bench.ts') && !path.endsWith('.d.ts'),
  )
  const callPattern = /defineAgentToolContract\s*\(/g
  const definitionPattern =
    /defineAgentToolContract\s*\(\s*\{\s*name\s*:\s*(['"])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\1/g

  for (const path of contractFiles) {
    const source = readFileSync(path, 'utf8')
    const callCount = [...source.matchAll(callPattern)].length
    const definitions = [...source.matchAll(definitionPattern)]
    if (callCount !== definitions.length) {
      addError(
        path,
        'every defineAgentToolContract call must declare a literal snake_case name as its first field',
      )
    }
    for (const definition of definitions) {
      const name = definition[2]
      const previous = names.get(name)
      if (previous)
        addError(path, `tool contract "${name}" is also declared in ${displayPath(previous)}`)
      else names.set(name, path)
    }
  }

  if (names.size === 0) addError(contractsRoot, 'no live tool contracts were found')
  return names
}

function documentedToolNames() {
  const names = new Map()
  const headingPattern = /^##\s+`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`\s*$/gm
  for (const path of filesBelow(toolsRoot, '.mdx')) {
    const source = maskCode(readFileSync(path, 'utf8'), { inline: false })
    for (const match of source.matchAll(headingPattern)) {
      const name = match[1]
      const previous = names.get(name)
      if (previous) {
        addError(path, `tool section "${name}" is already documented in ${displayPath(previous)}`)
      } else {
        names.set(name, path)
      }
    }
  }
  return names
}

function validateToolSections() {
  const headingPattern = /^##\s+`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`\s*$/gm

  for (const path of filesBelow(toolsRoot, '.mdx')) {
    const source = readFileSync(path, 'utf8')
    const masked = maskCode(source, { inline: false })
    const headings = [...masked.matchAll(headingPattern)]

    for (const [index, heading] of headings.entries()) {
      const name = heading[1]
      const start = heading.index + heading[0].length
      const end = headings[index + 1]?.index ?? source.length
      const section = source.slice(start, end)
      const inputAt = section.indexOf('**Input:**')
      const bashExamples = [...section.matchAll(/^```bash[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)]
      const jsonExamples = [...section.matchAll(/^```json[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)]
      const line = lineAt(source, heading.index)

      if (inputAt === -1) addError(path, `line ${line} tool "${name}" is missing **Input:**`)
      else if (!section.slice(0, inputAt).trim()) {
        addError(
          path,
          `line ${line} tool "${name}" needs a plain purpose sentence before **Input:**`,
        )
      }

      if (!bashExamples.some((example) => example[1].includes(`call ${name}`))) {
        addError(path, `line ${line} tool "${name}" needs a bash example that calls that exact ID`)
      }
      if (!section.includes('**Output (selected fields):**')) {
        addError(path, `line ${line} tool "${name}" is missing **Output (selected fields):**`)
      }
      if (jsonExamples.length === 0) {
        addError(path, `line ${line} tool "${name}" needs a JSON output example`)
      }
      if (!section.includes('**Agent use:**')) {
        addError(path, `line ${line} tool "${name}" is missing **Agent use:**`)
      }
    }
  }
}

const mdxFiles = filesBelow(contentRoot, '.mdx')
const routes = new Map()
let jsonExampleCount = 0
let bashExampleCount = 0
for (const path of mdxFiles) {
  const source = readFileSync(path, 'utf8')
  validateFrontmatter(path, source)
  jsonExampleCount += validateJsonExamples(path, source)
  bashExampleCount += validateBashExamples(path, source)
  const route = routeFor(path)
  const previous = routes.get(route)
  if (previous) addError(path, `route "${route}" is also created by ${displayPath(previous)}`)
  else routes.set(route, path)
}

validateNavigation(contentRoot)

let linkCount = 0
for (const path of mdxFiles) {
  const source = readFileSync(path, 'utf8')
  for (const link of internalLinks(source)) {
    linkCount += 1
    const route = normalizedLinkPath(link.href)
    if (!route) addError(path, `line ${link.line} has an invalid internal link: ${link.href}`)
    else if (!routes.has(route)) {
      addError(path, `line ${link.line} links to missing docs route "${route}"`)
    }
  }
}

const contracts = liveContractNames()
const documentedTools = documentedToolNames()
validateToolSections()
const toolsIndexPath = resolve(toolsRoot, 'index.mdx')
if (!readFileSync(toolsIndexPath, 'utf8').includes(`expose ${contracts.size} tools`)) {
  addError(toolsIndexPath, `tool count must say "expose ${contracts.size} tools"`)
}
for (const [name, path] of contracts) {
  if (!documentedTools.has(name)) {
    addError(
      path,
      `live tool "${name}" has no ## \`${name}\` section under apps/docs/content/docs/tools`,
    )
  }
}
for (const [name, path] of documentedTools) {
  if (!contracts.has(name)) addError(path, `tool section "${name}" has no live contract`)
}

if (errors.length > 0) {
  console.error(`Docs check failed with ${errors.length} error${errors.length === 1 ? '' : 's'}:`)
  for (const error of errors.sort()) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(
    `Docs check passed: ${mdxFiles.length} pages, ${linkCount} internal links, ${contracts.size} live tool contracts, ${jsonExampleCount} valid JSON examples, ${bashExampleCount} valid bash examples.`,
  )
}
