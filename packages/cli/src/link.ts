import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The unpublished "local link" install path: symlinks a checkout into node_modules so `genie-react` and this CLI resolve normally.

const LINKABLE = [
  { dir: 'genie-react', name: 'genie-react' },
  { dir: 'cli', name: '@genie-react/cli' },
] as const

export interface LinkOptions {
  cwd?: string
  /** Path to the genie-react checkout. Defaults to the repo this CLI was built from. */
  genieRoot?: string
}

const out = (message: string): void => void process.stdout.write(`${message}\n`)
const err = (message: string): void => void process.stderr.write(`${message}\n`)

export function runLink(opts: LinkOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd()
  const genieRoot = opts.genieRoot ?? detectGenieRoot()
  if (!genieRoot) {
    err('could not locate a genie checkout — pass its path: genie-react link <path-to-genie-react>')
    return 1
  }
  const packagesDir = join(genieRoot, 'packages')
  if (!existsSync(packagesDir)) {
    err(`no packages/ under ${genieRoot} — is that the genie-react repo?`)
    return 1
  }

  let linked = 0
  let missingDist = false
  for (const pkg of LINKABLE) {
    const target = join(packagesDir, pkg.dir)
    if (!existsSync(join(target, 'package.json'))) continue
    if (!existsSync(join(target, 'dist'))) missingDist = true
    const linkPath = join(cwd, 'node_modules', pkg.name)
    mkdirSync(dirname(linkPath), { recursive: true })
    rmSync(linkPath, { recursive: true, force: true })
    symlinkSync(target, linkPath, 'dir')
    linked++
    out(`  Package  ${pkg.name} -> ${target}`)
  }

  if (linked === 0) {
    err('nothing linked')
    return 1
  }

  const binPath = missingDist ? null : dropGenieBin(cwd, packagesDir)
  out(`✓ Linked ${linked} package${linked === 1 ? '' : 's'}`)
  if (binPath) out(`  Binary   ${binPath}`)
  if (missingDist) {
    err('! Some packages have no dist/. Run `pnpm -r build` in the Genie checkout.')
  }

  out('\nNext:')
  out(
    '  1. add `genie()` to your Vite config (or run `genie-react init`), then start your dev server',
  )
  out(
    '  2. run the live tools — `genie-react status` prints the bridge URL + a paste-ready `genie-react --url … call …`:',
  )
  out('       ./node_modules/.bin/genie-react status')
  out('       pnpm genie-react status')
  out('       npx genie-react status')
  return 0
}

function dropGenieBin(cwd: string, packagesDir: string): string | null {
  const cliBin = join(packagesDir, 'cli', 'dist', 'cli.js')
  if (!existsSync(cliBin)) return null
  const binDir = join(cwd, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  const binPath = join(binDir, 'genie-react')
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
