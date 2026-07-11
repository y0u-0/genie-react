import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../packages/cli/src/', import.meta.url)
const banned = [
  /\b(?:successfully|Unable to|Oops|Whoops|Uh-oh|Please try again|An error occurred)\b/,
  /\b(?:seamlessly|effortlessly|leverage|utilize|streamline)\b/,
  /Do you want to|Would you like to|Something went wrong|In order to|At this time|click here/,
  /[🔗🔍🚀⏳✅⚠]/u,
]

const files = []
const visit = (directory) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) visit(path)
    else if (/\.[cm]?[jt]sx?$/.test(entry) && !entry.includes('.test.')) files.push(path)
  }
}
visit(root.pathname)

const failures = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  for (const [index, line] of lines.entries()) {
    for (const pattern of banned) {
      if (pattern.test(line)) failures.push(`${file}:${index + 1}: ${line.trim()}`)
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`CLI UX banned-copy check failed:\n${failures.join('\n')}\n`)
  process.exitCode = 1
}
