import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { GENIE_DISCOVERY_FILE } from '@genie-react/core'
import { type BridgeDiscovery, parseBridgeDiscovery } from './discovery'
import { isRecord } from './guards'

export interface Logger {
  info: (message: string) => void
  error: (message: string) => void
}

const defaultLogger: Logger = {
  info: (message) => process.stdout.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
}

const VITE_CONFIG_FILES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.js',
  'vite.config.cjs',
] as const

const VITE_PLUGIN_PACKAGE = '@genie-react/vite'
const REACT_PACKAGE = '@genie-react/react'
const CLI_PACKAGE = '@genie-react/cli'
const VITE_IMPORT_LINE = `import { genie } from '${VITE_PLUGIN_PACKAGE}'`
const GENIE_IMPORT_LINE = `import { Genie } from '${REACT_PACKAGE}'`
const GENIE_RENDER_SNIPPET = '{import.meta.env.DEV && <Genie />}'

const ROOT_ROUTE_FILES = [
  'src/routes/__root.tsx',
  'src/routes/__root.jsx',
  'app/routes/__root.tsx',
  'app/routes/__root.jsx',
] as const

const OK = '✓'
const FAIL = '✗'
const WARN = '!'

/** Host shape, which decides wiring: plain Vite needs only the plugin (`index.html` injection); Router/Start render `<Genie />`. */
export type Framework = 'react-vite' | 'tanstack-router' | 'tanstack-start' | 'unknown'

export interface InitOptions {
  cwd?: string
  dryRun?: boolean
  yes?: boolean
  logger?: Logger
}

export type ViteConfigOutcome =
  | { action: 'missing' }
  | { action: 'already'; path: string }
  | { action: 'edit'; path: string; contents: string }
  | { action: 'manual'; path: string; reason: string }

export type RootRouteOutcome =
  | { action: 'missing' }
  | { action: 'skip'; reason: string }
  | { action: 'already'; path: string }
  | { action: 'edit'; path: string; contents: string }
  | { action: 'manual'; path: string; reason: string }

export interface InitResult {
  /** Whether setup completed for this framework. Drives the CLI exit code. */
  ok: boolean
  dryRun: boolean
  framework: Framework
  viteConfig: ViteConfigOutcome
  rootRoute: RootRouteOutcome
}

export interface DoctorOptions {
  cwd?: string
  logger?: Logger
}

export interface DoctorCheck {
  label: string
  ok: boolean
  critical: boolean
  detail?: string
}

export interface DoctorResult {
  ok: boolean
  framework: Framework
  checks: DoctorCheck[]
  bridge: BridgeDiscovery | null
}

export function runInit(options: InitOptions = {}): InitResult {
  const cwd = options.cwd ?? process.cwd()
  const dryRun = options.dryRun ?? false
  const log = options.logger ?? defaultLogger

  const framework = detectFramework(cwd)
  const viteConfig = planViteEdit(cwd)
  const rootRoute = planRootRouteEdit(cwd, framework)

  log.info(dryRun ? 'genie init (dry run — no files will be written)\n' : 'genie init\n')
  const ctx = { cwd, dryRun, log }
  applyViteOutcome(viteConfig, ctx)
  applyRootRouteOutcome(rootRoute, ctx)
  printNextSteps(log, framework, rootRoute)
  if (!dryRun && !options.yes) {
    log.info(
      "\nTip: run 'npx @genie-react/cli doctor' to verify, or 'npx @genie-react/cli init --dry-run' to preview changes.",
    )
  }

  const viteWired = viteConfig.action === 'already' || viteConfig.action === 'edit'
  const componentWired =
    rootRoute.action === 'already' || rootRoute.action === 'edit' || rootRoute.action === 'skip'
  // Start has no index.html, so there `<Genie />` alone starts the client; elsewhere a failed insert is only a warning.
  const ok = framework === 'tanstack-start' ? viteWired && componentWired : viteWired
  return { ok, dryRun, framework, viteConfig, rootRoute }
}

export function runDoctor(options: DoctorOptions = {}): DoctorResult {
  const cwd = options.cwd ?? process.cwd()
  const log = options.logger ?? defaultLogger
  const framework = detectFramework(cwd)
  const checks: DoctorCheck[] = []

  const vitePath = detectViteConfig(cwd)
  if (!vitePath) {
    checks.push({
      label: 'Vite config references @genie-react/vite',
      ok: false,
      critical: true,
      detail: 'no vite config found',
    })
  } else {
    checks.push({
      label: 'Vite config references @genie-react/vite',
      ok: referencesVitePlugin(readFileSafe(vitePath)),
      critical: true,
      detail: relative(cwd, vitePath),
    })
  }

  for (const pkg of doctorPackages(framework)) {
    checks.push({
      label: `${pkg} resolvable in node_modules`,
      ok: findPackageDir(cwd, pkg) !== null,
      critical: true,
    })
  }

  const bridge = readBridgeDiscovery(cwd)

  log.info('genie doctor\n')
  for (const check of checks) {
    const mark = check.ok ? OK : FAIL
    const detail = check.detail ? ` (${check.detail})` : ''
    log.info(`${mark} ${check.label}${detail}`)
  }

  if (bridge) {
    const pid = bridge.pid ? ` (pid ${bridge.pid})` : ''
    log.info(`\n${OK} bridge is live at ${bridge.url}${pid}`)
  } else {
    log.info('\n  bridge is not running — start your dev server to connect')
  }

  const ok = checks.every((check) => !check.critical || check.ok)
  if (!ok) {
    log.info("\nSome checks failed. Run 'npx @genie-react/cli init' to wire things up.")
  }

  return { ok, framework, checks, bridge }
}

/** Classifies by deps, most-specific first; the router dep outranks `index.html` because Router SPAs ship one too. */
export function detectFramework(cwd: string): Framework {
  const deps = readPackageDeps(cwd)
  if (deps.has('@tanstack/react-start')) return 'tanstack-start'
  if (deps.has('@tanstack/react-router')) return 'tanstack-router'
  if (existsSync(join(cwd, 'index.html'))) return 'react-vite'
  return 'unknown'
}

function requiredPackages(framework: Framework): string[] {
  const base =
    framework === 'react-vite' ? [VITE_PLUGIN_PACKAGE] : [REACT_PACKAGE, VITE_PLUGIN_PACKAGE]
  return [...base, CLI_PACKAGE]
}

function doctorPackages(framework: Framework): readonly string[] {
  return framework === 'react-vite' ? [VITE_PLUGIN_PACKAGE] : [VITE_PLUGIN_PACKAGE, REACT_PACKAGE]
}

function readPackageDeps(cwd: string): Set<string> {
  const pkg = parseJson(readFileSafe(join(cwd, 'package.json')))
  const names = new Set<string>()
  if (!isRecord(pkg)) return names
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const section = pkg[key]
    if (isRecord(section)) {
      for (const name of Object.keys(section)) names.add(name)
    }
  }
  return names
}

function detectViteConfig(cwd: string): string | null {
  for (const file of VITE_CONFIG_FILES) {
    const candidate = join(cwd, file)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function planViteEdit(cwd: string): ViteConfigOutcome {
  const path = detectViteConfig(cwd)
  if (!path) return { action: 'missing' }

  const code = readFileSafe(path)
  const result = editViteConfig(code)
  switch (result.kind) {
    case 'already':
      return { action: 'already', path }
    case 'manual':
      return { action: 'manual', path, reason: result.reason }
    case 'edited':
      return { action: 'edit', path, contents: result.code }
  }
}

type ViteEditResult =
  | { kind: 'already' }
  | { kind: 'edited'; code: string }
  | { kind: 'manual'; reason: string }

function editViteConfig(code: string): ViteEditResult {
  if (isCommonJs(code)) {
    return { kind: 'manual', reason: 'CommonJS config — add the plugin by hand' }
  }

  const importsPlugin = referencesVitePlugin(code)
  const callsGenie = /\bgenie\s*\(/.test(code)
  if (importsPlugin && callsGenie) return { kind: 'already' }

  let next = code
  if (!callsGenie) {
    const inserted = insertGeniePlugin(next)
    if (inserted.kind === 'manual') return inserted
    next = inserted.code
  }
  if (!importsPlugin) {
    next = insertViteImport(next)
  }
  return { kind: 'edited', code: next }
}

function insertGeniePlugin(
  code: string,
): { kind: 'edited'; code: string } | { kind: 'manual'; reason: string } {
  const match = /plugins\s*:\s*\[/.exec(code)
  if (!match) {
    return { kind: 'manual', reason: 'no `plugins` array found in the config' }
  }

  const at = match.index + match[0].length
  const head = code.slice(0, at)
  const rest = code.slice(at)

  if (/^\s*\]/.test(rest)) {
    return { kind: 'edited', code: `${head}genie()${rest}` }
  }

  const multiline = /^[^\S\n]*\n([ \t]*)/.exec(rest)
  if (multiline) {
    const indent = multiline[1] ?? ''
    return { kind: 'edited', code: `${head}\n${indent}genie(),${rest}` }
  }

  return { kind: 'edited', code: `${head}genie(), ${rest}` }
}

function insertViteImport(code: string): string {
  return insertImportLine(code, VITE_IMPORT_LINE)
}

function insertImportLine(code: string, importLine: string): string {
  const firstImport = /^import\b/m.exec(code)
  if (firstImport) {
    return `${code.slice(0, firstImport.index)}${importLine}\n${code.slice(firstImport.index)}`
  }
  return `${importLine}\n${code}`
}

function detectRootRoute(cwd: string): string | null {
  for (const file of ROOT_ROUTE_FILES) {
    const candidate = join(cwd, file)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function planRootRouteEdit(cwd: string, framework: Framework): RootRouteOutcome {
  if (framework === 'react-vite') {
    return {
      action: 'skip',
      reason: 'plain React + Vite — the genie() plugin injects the in-browser client automatically',
    }
  }

  const path = detectRootRoute(cwd)
  if (!path) return { action: 'missing' }

  const result = editRootRoute(readFileSafe(path), framework)
  switch (result.kind) {
    case 'already':
      return { action: 'already', path }
    case 'manual':
      return { action: 'manual', path, reason: result.reason }
    case 'edited':
      return { action: 'edit', path, contents: result.code }
  }
}

function editRootRoute(code: string, framework: Framework): ViteEditResult {
  const importsGenie = /['"]@genie-react\/react['"]/.test(code)
  const rendersGenie = /<Genie\b/.test(code)
  if (importsGenie && rendersGenie) return { kind: 'already' }

  let next = code
  if (!rendersGenie) {
    // Router SPAs have no document shell (root renders <Outlet />); roots with a <body> get the snippet before </body>.
    const inserted =
      framework === 'tanstack-router' ? insertGenieAfterOutlet(next) : insertGenieBeforeBody(next)
    if (inserted.kind === 'manual') return inserted
    next = inserted.code
  }
  if (!importsGenie) next = insertImportLine(next, GENIE_IMPORT_LINE)
  return { kind: 'edited', code: next }
}

function insertGenieBeforeBody(
  code: string,
): { kind: 'edited'; code: string } | { kind: 'manual'; reason: string } {
  const match = /([ \t]*)<\/body>/.exec(code)
  if (!match) {
    return { kind: 'manual', reason: 'no </body> in the root route — render <Genie /> by hand' }
  }
  const indent = match[1] ?? ''
  const snippet = `${indent}  ${GENIE_RENDER_SNIPPET}\n`
  return { kind: 'edited', code: code.slice(0, match.index) + snippet + code.slice(match.index) }
}

function insertGenieAfterOutlet(
  code: string,
): { kind: 'edited'; code: string } | { kind: 'manual'; reason: string } {
  const match = /<Outlet\s*\/>/.exec(code)
  if (!match) {
    return {
      kind: 'manual',
      reason: 'no <Outlet /> in the root route — render <Genie /> after it by hand',
    }
  }
  // Fragment-wrap so it stays valid whether or not <Outlet /> already sits inside a parent element.
  const wrapped = `<>${match[0]}${GENIE_RENDER_SNIPPET}</>`
  return {
    kind: 'edited',
    code: code.slice(0, match.index) + wrapped + code.slice(match.index + match[0].length),
  }
}

interface ApplyContext {
  cwd: string
  dryRun: boolean
  log: Logger
}

function applyViteOutcome(outcome: ViteConfigOutcome, ctx: ApplyContext): void {
  const { dryRun, log } = ctx
  switch (outcome.action) {
    case 'missing':
      log.info(`${WARN} no Vite config found (looked for ${VITE_CONFIG_FILES.join(', ')})`)
      printViteManual(log)
      return
    case 'already':
      log.info(`${OK} ${rel(ctx, outcome.path)} already wires ${VITE_PLUGIN_PACKAGE}`)
      return
    case 'manual':
      log.info(`${WARN} could not edit ${rel(ctx, outcome.path)}: ${outcome.reason}`)
      printViteManual(log)
      return
    case 'edit': {
      const label = rel(ctx, outcome.path)
      if (dryRun) {
        log.info(`${OK} would add the genie() plugin and its import to ${label}`)
      } else {
        writeFileSync(outcome.path, outcome.contents)
        log.info(`${OK} added the genie() plugin and its import to ${label}`)
      }
      return
    }
  }
}

function applyRootRouteOutcome(outcome: RootRouteOutcome, ctx: ApplyContext): void {
  const { dryRun, log } = ctx
  switch (outcome.action) {
    case 'missing':
      log.info(`${WARN} no root route found (looked for ${ROOT_ROUTE_FILES.join(', ')})`)
      return
    case 'skip':
      log.info(`${OK} ${outcome.reason}`)
      return
    case 'already':
      log.info(`${OK} ${rel(ctx, outcome.path)} already renders <Genie />`)
      return
    case 'manual':
      log.info(`${WARN} could not edit ${rel(ctx, outcome.path)}: ${outcome.reason}`)
      return
    case 'edit': {
      const label = rel(ctx, outcome.path)
      if (dryRun) {
        log.info(`${OK} would render <Genie /> (dev-only) in ${label}`)
      } else {
        writeFileSync(outcome.path, outcome.contents)
        log.info(`${OK} added <Genie /> (dev-only) and its import to ${label}`)
      }
      return
    }
  }
}

function printNextSteps(log: Logger, framework: Framework, rootRoute: RootRouteOutcome): void {
  const componentHandled =
    rootRoute.action === 'edit' || rootRoute.action === 'already' || rootRoute.action === 'skip'
  let step = 1
  log.info('\nNext steps:')
  log.info(`  ${step++}. install Genie (if you have not yet):`)
  log.info('       npx @genie-react/cli link <path-to-genie>   # local checkout (no publish), or:')
  log.info(`       pnpm add -D ${requiredPackages(framework).join(' ')}`)
  if (!componentHandled) {
    log.info(`  ${step++}. render Genie near your app root (dev only):`)
    log.info(`       ${GENIE_IMPORT_LINE}`)
    log.info(`       ${GENIE_RENDER_SNIPPET}`)
  }
  log.info(`  ${step++}. start your dev server:`)
  log.info('       pnpm dev')
  log.info(`  ${step++}. drive the live tools from your shell:`)
  log.info('       npx @genie-react/cli status')
  log.info('       npx @genie-react/cli tools')
  log.info('       npx @genie-react/cli call react_get_renders \'{"sort":"renders"}\'')
}

function printViteManual(log: Logger): void {
  log.info('   add the plugin to your Vite config manually:')
  log.info(`     ${VITE_IMPORT_LINE}`)
  log.info('     export default defineConfig({')
  log.info('       plugins: [genie(), /* ...existing plugins */],')
  log.info('     })')
}

function referencesVitePlugin(code: string): boolean {
  return /['"]@genie-react\/vite['"]/.test(code)
}

function isCommonJs(code: string): boolean {
  if (/^\s*import\s/m.test(code) || /export\s+default/.test(code)) return false
  return /\bmodule\.exports\b|\brequire\s*\(/.test(code)
}

function readBridgeDiscovery(cwd: string): BridgeDiscovery | null {
  const path = join(cwd, GENIE_DISCOVERY_FILE)
  if (!existsSync(path)) return null
  return parseBridgeDiscovery(readFileSafe(path))
}

function findPackageDir(cwd: string, name: string): string | null {
  let dir = cwd
  while (true) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function rel(ctx: ApplyContext, path: string): string {
  return relative(ctx.cwd, path) || path
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
