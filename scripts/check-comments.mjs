#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

// Comment policy: one line per comment — multi-line blocks and consecutive `//` runs fail the build.

const ROOT = new URL('..', import.meta.url).pathname
const TARGET_DIRS = ['packages']
const SOURCE_FILE = /\.(ts|tsx)$/
const IGNORED = /(node_modules|dist|\.gen\.)/

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (IGNORED.test(path)) continue
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (SOURCE_FILE.test(entry.name)) yield path
  }
}

// A full parse (not a raw scanner) so template literals with `${}` can't desync comment detection.
function commentRanges(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  const byPos = new Map()
  const collect = (position) => {
    for (const range of ts.getLeadingCommentRanges(text, position) ?? [])
      byPos.set(range.pos, range)
    for (const range of ts.getTrailingCommentRanges(text, position) ?? [])
      byPos.set(range.pos, range)
  }
  const visit = (node) => {
    collect(node.getFullStart())
    collect(node.getEnd())
    node.forEachChild(visit)
  }
  visit(source)
  collect(source.endOfFileToken.getFullStart())
  return [...byPos.values()].sort((a, b) => a.pos - b.pos)
}

const lineOf = (text, offset) => text.slice(0, offset).split('\n').length

function violationsIn(path) {
  const text = readFileSync(path, 'utf8')
  const violations = []
  let run = { count: 0, line: 0, startLine: 0 }

  for (const range of commentRanges(path, text)) {
    const line = lineOf(text, range.pos)
    if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      if (text.slice(range.pos, range.end).includes('\n'))
        violations.push({ line, message: 'multi-line block comment — condense to one line' })
      run = { count: 0, line: 0, startLine: 0 }
      continue
    }
    run =
      line === run.line + 1
        ? { count: run.count + 1, line, startLine: run.startLine }
        : { count: 1, line, startLine: line }
    if (run.count === 2)
      violations.push({
        line: run.startLine,
        message: 'consecutive // lines — condense to one line',
      })
  }
  return violations
}

let failed = false
for (const dir of TARGET_DIRS) {
  for (const path of sourceFiles(join(ROOT, dir))) {
    for (const violation of violationsIn(path)) {
      failed = true
      process.stderr.write(`${relative(ROOT, path)}:${violation.line} ${violation.message}\n`)
    }
  }
}

if (failed) {
  process.stderr.write(
    '\ncomment policy: max one line per comment (see scripts/check-comments.mjs)\n',
  )
  process.exit(1)
}
