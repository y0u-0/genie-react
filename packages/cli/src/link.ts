import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The unpublished "local link" install path: symlinks a checkout into node_modules so `@genie-react/*` resolve normally.

const LINKABLE = [
  'core',
  'client',
  'bridge',
  'react-collector',
  'tanstack-collector',
  'vite',
  'memory',
  'devtools-plugin',
  'react',
  'cli',
] as const

export interface LinkOptions {
  cwd?: string
  /** Path to the genie-react-agent checkout. Defaults to the repo this CLI was built from. */
  genieRoot?: string
}

const out = (message: string): void => void process.stdout.write(`${message}\n`)
const err = (message: string): void => void process.stderr.write(`${message}\n`)

export function runLink(opts: LinkOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd()
  const genieRoot = opts.genieRoot ?? detectGenieRoot()
  if (!genieRoot) {
    err('could not locate a genie checkout — pass its path: genie link <path-to-genie-react-agent>')
    return 1
  }
  const packagesDir = join(genieRoot, 'packages')
  if (!existsSync(packagesDir)) {
    err(`no packages/ under ${genieRoot} — is that the genie-react-agent repo?`)
    return 1
  }

  const scope = join(cwd, 'node_modules', '@genie-react')
  mkdirSync(scope, { recursive: true })

  let linked = 0
  let missingDist = false
  for (const pkg of LINKABLE) {
    const target = join(packagesDir, pkg)
    if (!existsSync(join(target, 'package.json'))) continue
    if (!existsSync(join(target, 'dist'))) missingDist = true
    const linkPath = join(scope, pkg)
    rmSync(linkPath, { recursive: true, force: true })
    symlinkSync(target, linkPath, 'dir')
    linked++
    out(`✓  @genie-react/${pkg} -> ${target}`)
  }

  if (linked === 0) {
    err('nothing linked')
    return 1
  }

  const binPath = missingDist ? null : dropGenieBin(cwd, packagesDir)
  if (binPath) out(`✓  bin -> ${binPath}`)
  if (missingDist) {
    out('\n!  some packages have no dist/ — run `pnpm -r build` in the genie repo first')
  }

  out('\nNext:')
  out('  1. add `genie()` to your Vite config (or run `genie init`), then start your dev server')
  out(
    '  2. run the live tools — `genie status` prints the bridge URL + a paste-ready `genie --url … call …`:',
  )
  out('       ./node_modules/.bin/genie status')
  out('       pnpm genie status')
  out('       npx genie status')
  return 0
}

function dropGenieBin(cwd: string, packagesDir: string): string | null {
  const cliBin = join(packagesDir, 'cli', 'dist', 'cli.js')
  if (!existsSync(cliBin)) return null
  const binDir = join(cwd, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const binPath = join(binDir, 'genie')
  rmSync(binPath, { force: true })
  symlinkSync(cliBin, binPath, 'file')
  return binPath
}

function detectGenieRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'packages')))
      return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
