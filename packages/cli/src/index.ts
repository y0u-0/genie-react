import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  devtoolsStatusContract,
  GENIE_CLIENT_PATH,
  GENIE_DEFAULT_HUB_PORT,
  GENIE_DISCOVERY_FILE,
  GENIE_INFO_PATH,
} from 'genie-react/protocol'
import { GenieAgentLink } from './agent-link'
import { type BridgeDiscovery, isPidAlive, parseBridgeDiscovery, resolveBridge } from './discovery'
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

const GENIE_PACKAGE = 'genie-react'
const VITE_PLUGIN_SPECIFIER = 'genie-react/vite'
const CLI_PACKAGE = '@genie-react/cli'
const AGENT_SKILL_PATH = '.agents/skills/genie/SKILL.md'
const VITE_IMPORT_LINE = `import { genie } from '${VITE_PLUGIN_SPECIFIER}'`
const GENIE_IMPORT_LINE = `import { Genie } from '${GENIE_PACKAGE}'`
const GENIE_RENDER_SNIPPET = '{import.meta.env.DEV && <Genie />}'

const ROOT_ROUTE_FILES = [
  'src/routes/__root.tsx',
  'src/routes/__root.jsx',
  'app/routes/__root.tsx',
  'app/routes/__root.jsx',
] as const

const NEXT_LAYOUT_FILES = [
  'app/layout.tsx',
  'app/layout.jsx',
  'src/app/layout.tsx',
  'src/app/layout.jsx',
] as const

const NEXT_INSTRUMENTATION_FILES = [
  'instrumentation.ts',
  'instrumentation.js',
  'src/instrumentation.ts',
  'src/instrumentation.js',
] as const

const NEXT_IMPORT_LINE = `import { GenieScript } from '${GENIE_PACKAGE}/next'`
const NEXT_INSTRUMENTATION_TEMPLATE = `export async function register(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerGenie } = await import('genie-react/next')
    await registerGenie()
  }
}
`

const OK = '✓'
const FAIL = '✗'
const WARN = '!'
const PREVIEW = '  '

/** Host shape, which decides wiring: Vite hosts get the plugin; Next.js gets the standalone hub + `<GenieScript />`. */
export type Framework = 'react-vite' | 'tanstack-router' | 'tanstack-start' | 'nextjs' | 'unknown'

export interface InitOptions {
  cwd?: string
  dryRun?: boolean
  yes?: boolean
  logger?: Logger
}

export type ViteConfigOutcome =
  | { action: 'missing' }
  | { action: 'skip'; reason: string }
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
  /** Next.js only: outcome for the instrumentation.ts that auto-starts the hub. */
  instrumentation?: RootRouteOutcome
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
  versions: {
    cli: string
    runtime: string | null
    bundledSkill: string | null
    activeSkill: string | null
  }
  skill: {
    path: string | null
    bundledHash: string | null
    activeHash: string | null
    current: boolean
  }
  bridgeCandidates: BridgeDiscovery[]
  remediation: string[]
  live?: {
    sessionHealth: SessionProbe | null
    sourceMapHealth: SourceMapHealth | null
  }
}

export function runInit(options: InitOptions = {}): InitResult {
  const cwd = options.cwd ?? process.cwd()
  const dryRun = options.dryRun ?? false
  const log = options.logger ?? defaultLogger

  const framework = detectFramework(cwd)
  log.info(
    dryRun ? 'genie-react init (dry run — no files will be written)\n' : 'genie-react init\n',
  )
  const ctx = { cwd, dryRun, log }
  if (framework === 'nextjs') return runNextInit(ctx, options)

  const viteConfig = planViteEdit(cwd)
  const rootRoute = planRootRouteEdit(cwd, framework)

  // No Vite, no Next: the hub + script-tag path IS the setup, so don't fail or print Vite-only guidance.
  if (framework === 'unknown' && viteConfig.action === 'missing') {
    printUniversalSetup(log)
    ensureGenieIgnored(ctx)
    ensureAgentSkill(ctx)
    printUniversalNextSteps(log, packageManagerHints(cwd))
    return {
      ok: true,
      dryRun,
      framework,
      viteConfig,
      rootRoute: { action: 'skip', reason: 'universal hub + script-tag setup' },
    }
  }

  applyViteOutcome(viteConfig, ctx)
  applyRootRouteOutcome(rootRoute, ctx)
  if (readPackageDeps(cwd).has('@cloudflare/vite-plugin')) {
    log.info(
      `${PREVIEW}@cloudflare/vite-plugin detected — genie() will run its bridge on a standalone hub (workerd owns this port's WebSocket upgrades)`,
    )
  }
  ensureGenieIgnored(ctx)
  ensureAgentSkill(ctx)
  printNextSteps(log, framework, rootRoute, packageManagerHints(cwd))
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

  if (framework === 'nextjs') {
    const layoutPath = detectNextLayout(cwd)
    checks.push({
      label: 'app layout renders <GenieScript />',
      ok: layoutPath !== null && /<GenieScript\b/.test(readFileSafe(layoutPath)),
      critical: true,
      detail: layoutPath ? relative(cwd, layoutPath) : 'no app layout found',
    })
  } else {
    const vitePath = detectViteConfig(cwd)
    if (!vitePath) {
      // Universal (hub + script tag) hosts have no Vite config to check; the hub's discovery file is the wiring proof.
      if (framework === 'unknown') {
        const discovered = readBridgeDiscovery(cwd) !== null
        checks.push({
          label: `universal setup: hub discovery file (${GENIE_DISCOVERY_FILE})`,
          ok: discovered,
          critical: true,
          detail: discovered ? undefined : `not found — run: npx ${CLI_PACKAGE} hub`,
        })
      } else {
        checks.push({
          label: `Vite config references ${VITE_PLUGIN_SPECIFIER}`,
          ok: false,
          critical: true,
          detail: 'no vite config found',
        })
      }
    } else {
      checks.push({
        label: `Vite config references ${VITE_PLUGIN_SPECIFIER}`,
        ok: referencesVitePlugin(readFileSafe(vitePath)),
        critical: true,
        detail: relative(cwd, vitePath),
      })
    }
  }

  for (const pkg of doctorPackages(framework)) {
    checks.push({
      label: `${pkg} resolvable in node_modules`,
      ok: findPackageDir(cwd, pkg) !== null,
      critical: true,
    })
  }

  const cliVersion = packageVersionAt(new URL('../package.json', import.meta.url)) ?? '0.0.0'
  const runtimeDirectory = findPackageDir(cwd, GENIE_PACKAGE)
  const runtimeVersion = runtimeDirectory
    ? packageVersionAt(join(runtimeDirectory, 'package.json'))
    : null
  const bundledSkill = readBundledSkill()
  const activeSkillPath = findActiveSkill(cwd)
  const activeSkill = activeSkillPath ? readFileSafe(activeSkillPath) : ''
  const bundledHash = bundledSkill ? sha256(bundledSkill) : null
  const activeHash = activeSkill ? sha256(activeSkill) : null
  const bundledSkillVersion = skillVersion(bundledSkill)
  const activeSkillVersion = skillVersion(activeSkill)
  const skillCurrent = bundledHash !== null && activeHash === bundledHash
  checks.push({
    label: 'agent skill matches the bundled CLI guidance',
    ok: skillCurrent,
    critical: true,
    detail: skillCurrent
      ? `${relative(cwd, activeSkillPath ?? '')} · sha256 ${activeHash?.slice(0, 12)}`
      : activeSkillPath
        ? `${relative(cwd, activeSkillPath)} is ${activeSkillVersion ?? 'unversioned'} / ${activeHash?.slice(0, 12)}; run: npx ${CLI_PACKAGE} init`
        : `${AGENT_SKILL_PATH} missing; run: npx ${CLI_PACKAGE} init`,
  })
  if (runtimeVersion) {
    checks.push({
      label: 'CLI and runtime package versions agree',
      ok: runtimeVersion === cliVersion,
      critical: true,
      detail: `cli ${cliVersion} · runtime ${runtimeVersion}`,
    })
  }

  let bridge = readBridgeDiscovery(cwd)
  let staleBridgePid: number | null = null
  if (bridge?.pid !== undefined && !isPidAlive(bridge.pid)) {
    staleBridgePid = bridge.pid
    rmSync(join(cwd, GENIE_DISCOVERY_FILE), { force: true })
    bridge = null
  }

  log.info('genie-react doctor\n')
  for (const check of checks) {
    const mark = check.ok ? OK : FAIL
    const detail = check.detail ? ` (${check.detail})` : ''
    log.info(`${mark} ${check.label}${detail}`)
  }

  if (bridge) {
    const pid = bridge.pid ? ` (pid ${bridge.pid})` : ''
    log.info(`\n${OK} bridge is live at ${bridge.url}${pid}`)
  } else if (staleBridgePid !== null) {
    log.info(
      `\n${WARN} stale ${GENIE_DISCOVERY_FILE} (pid ${staleBridgePid} is gone) — removed; restart your dev server or genie-react hub`,
    )
  } else {
    log.info('\n  bridge is not running — start your dev server to connect')
  }

  const ok = checks.every((check) => !check.critical || check.ok)
  if (!ok) {
    log.info("\nSome checks failed. Run 'npx @genie-react/cli init' to wire things up.")
  }

  const remediation = checks
    .filter((check) => !check.ok)
    .map((check) => check.detail ?? `Resolve failed check: ${check.label}`)
  return {
    ok,
    framework,
    checks,
    bridge,
    versions: {
      cli: cliVersion,
      runtime: runtimeVersion,
      bundledSkill: bundledSkillVersion,
      activeSkill: activeSkillVersion,
    },
    skill: {
      path: activeSkillPath ? relative(cwd, activeSkillPath) : null,
      bundledHash,
      activeHash,
      current: skillCurrent,
    },
    bridgeCandidates: bridge ? [bridge] : [],
    remediation,
  }
}

export interface LiveDoctorOptions extends DoctorOptions {
  /** Per-probe timeout; the WS round-trip gets twice this. */
  timeoutMs?: number
}

/** `doctor --live`: the static checks plus a probe of the RUNNING stack — hub HTTP + identity, served client bundle, and a session round-trip over the bridge. */
export async function runLiveDoctor(options: LiveDoctorOptions = {}): Promise<DoctorResult> {
  const cwd = options.cwd ?? process.cwd()
  const log = options.logger ?? defaultLogger
  const timeoutMs = options.timeoutMs ?? 2_000
  const staticResult = runDoctor(options)
  const checks: DoctorCheck[] = []
  let sessionHealth: SessionProbe | null = null
  let sourceMapHealth: SourceMapHealth | null = null

  const { url, source } = await resolveBridge(cwd)
  const origin = httpOriginOf(url)
  if (!origin) {
    checks.push({ label: 'bridge url is well-formed', ok: false, critical: true, detail: url })
  } else {
    const hub = await probeHub(origin, timeoutMs)
    if (hub.kind === 'unreachable') {
      checks.push({
        label: `dev server / hub listening at ${origin}`,
        ok: false,
        critical: true,
        detail:
          source === 'fallback'
            ? `nothing answered at the default guess — no ${GENIE_DISCOVERY_FILE} found from ${cwd} upward; start your dev server or genie-react hub`
            : 'nothing answered — start your dev server or genie-react hub',
      })
    } else if (hub.kind === 'standalone') {
      checks.push({
        label: `standalone hub answering at ${origin}`,
        ok: true,
        critical: true,
        detail: `rootDir ${hub.rootDir}`,
      })
      const clientServed = await fetchNonEmpty(`${origin}${GENIE_CLIENT_PATH}`, timeoutMs)
      checks.push({
        label: 'hub serves the browser client',
        ok: clientServed,
        critical: true,
        detail: clientServed ? undefined : `${GENIE_CLIENT_PATH} did not return the bundle`,
      })
    } else {
      checks.push({
        label: `dev server answering at ${origin}`,
        ok: true,
        critical: true,
        detail: 'vite-mounted bridge (client is injected automatically)',
      })
    }

    if (hub.kind !== 'unreachable') {
      const session = await probeSession(url, timeoutMs)
      sessionHealth = session
      checks.push({
        label: 'bridge accepts agent connections',
        ok: session !== null,
        critical: true,
        detail: session ? undefined : 'WebSocket round-trip failed',
      })
      if (session) {
        sourceMapHealth = session.sourceMapHealth
        checks.push({
          label: session.connected ? 'an app session is connected' : 'no app session connected yet',
          ok: session.connected,
          critical: false,
          detail: session.connected
            ? [
                `${session.sessions} session(s)`,
                session.app,
                session.reactVersion && `react ${session.reactVersion}`,
              ]
                .filter(Boolean)
                .join(' · ')
            : 'open the app in a browser to connect one',
        })
        if (session.roundTripMs !== null) {
          checks.push({
            label: 'app tool round-trip',
            ok: true,
            critical: false,
            detail: `react_find_components answered in ${session.roundTripMs}ms`,
          })
        }
        if (session.sourceMapHealth) {
          checks.push({
            label: 'React source-map health',
            ok: session.sourceMapHealth.status !== 'unhealthy',
            critical: false,
            detail: `${session.sourceMapHealth.status} · mapped ${session.sourceMapHealth.mapped} · served ${session.sourceMapHealth.served} · unknown ${session.sourceMapHealth.unknown}`,
          })
        }
      }
    }
  }

  log.info('\nlive checks:')
  for (const check of checks) {
    const mark = check.ok ? OK : check.critical ? FAIL : WARN
    const detail = check.detail ? ` (${check.detail})` : ''
    log.info(`${mark} ${check.label}${detail}`)
  }

  const ok = staticResult.ok && checks.every((check) => !check.critical || check.ok)
  return {
    ok,
    framework: staticResult.framework,
    checks: [...staticResult.checks, ...checks],
    bridge: staticResult.bridge,
    versions: staticResult.versions,
    skill: staticResult.skill,
    bridgeCandidates: staticResult.bridgeCandidates,
    remediation: [
      ...staticResult.remediation,
      ...checks.filter((check) => !check.ok).map((check) => check.detail ?? check.label),
    ],
    live: { sessionHealth, sourceMapHealth },
  }
}

function httpOriginOf(wsUrl: string): string | null {
  try {
    const parsed = new URL(wsUrl)
    const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    return `${protocol}//${parsed.host}`
  } catch {
    return null
  }
}

type HubProbe = { kind: 'unreachable' } | { kind: 'standalone'; rootDir: string } | { kind: 'http' }

// Any HTTP answer (a Vite 404 included) proves a server owns the port; only {genie:true} proves a standalone hub.
async function probeHub(origin: string, timeoutMs: number): Promise<HubProbe> {
  try {
    const response = await fetch(`${origin}${GENIE_INFO_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) {
      const body: unknown = await response.json().catch(() => null)
      if (isRecord(body) && body.genie === true && typeof body.rootDir === 'string') {
        return { kind: 'standalone', rootDir: body.rootDir }
      }
    }
    return { kind: 'http' }
  } catch {
    return { kind: 'unreachable' }
  }
}

async function fetchNonEmpty(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok && (await response.text()).length > 0
  } catch {
    return false
  }
}

interface SessionProbe {
  connected: boolean
  sessions: number
  app: string | null
  reactVersion: string | null
  roundTripMs: number | null
  sourceMapHealth: SourceMapHealth | null
}

interface SourceMapHealth {
  status: 'healthy' | 'partial' | 'unhealthy' | 'unavailable'
  mapped: number
  served: number
  unknown: number
}

async function probeSession(url: string, timeoutMs: number): Promise<SessionProbe | null> {
  const link = new GenieAgentLink({
    url,
    connectTimeoutMs: timeoutMs,
    invokeTimeoutMs: timeoutMs * 2,
  })
  link.start()
  try {
    const status = await link.invoke(devtoolsStatusContract, {})
    let roundTripMs: number | null = null
    let sourceMapHealth: SourceMapHealth | null = null
    if (status.connected && status.domains.includes('react')) {
      const started = Date.now()
      roundTripMs = await link
        .invoke('react_find_components', { query: '__genie_live_doctor__' })
        .then(() => Date.now() - started)
        .catch(() => null)
      const provenance = await link
        .invoke('react_provenance', { limit: 50, appOnly: false })
        .catch(() => null)
      sourceMapHealth = sourceMapHealthOf(provenance)
    }
    return {
      connected: status.connected,
      sessions: status.sessions.length,
      app: status.app?.name ?? null,
      reactVersion: status.app?.reactVersion ?? null,
      roundTripMs,
      sourceMapHealth,
    }
  } catch {
    return null
  } finally {
    link.close()
  }
}

export function sourceMapHealthOf(value: unknown): SourceMapHealth | null {
  if (!isRecord(value) || !isRecord(value.summary) || !isRecord(value.summary.sourceMaps)) {
    return null
  }
  const maps = value.summary.sourceMaps
  const mapped = typeof maps.mapped === 'number' ? maps.mapped : 0
  const served = typeof maps.served === 'number' ? maps.served : 0
  const unknown = typeof maps.unknown === 'number' ? maps.unknown : 0
  const total = mapped + served + unknown
  return {
    status:
      total === 0
        ? 'unavailable'
        : mapped + served === 0
          ? 'unhealthy'
          : unknown > 0 || served > 0
            ? 'partial'
            : 'healthy',
    mapped,
    served,
    unknown,
  }
}

/** Classifies by deps, most-specific first; the router dep outranks `index.html` because Router SPAs ship one too. */
export function detectFramework(cwd: string): Framework {
  const deps = readPackageDeps(cwd)
  if (deps.has('@tanstack/react-start')) return 'tanstack-start'
  if (deps.has('next')) return 'nextjs'
  if (deps.has('@tanstack/react-router')) return 'tanstack-router'
  if (existsSync(join(cwd, 'index.html'))) return 'react-vite'
  return 'unknown'
}

// The plugin, collectors, and <Genie /> ship in the one genie-react package, so the install set no longer varies by framework.
function requiredPackages(_framework: Framework): string[] {
  return [GENIE_PACKAGE, CLI_PACKAGE]
}

function doctorPackages(_framework: Framework): readonly string[] {
  return [GENIE_PACKAGE]
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
      reason:
        'plain React + Vite — genie() injects the react + session tools; render <Genie /> (next steps) for the memory + plugin tools',
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
  // Exact-match the root specifier so `genie-react/vite` in the same file doesn't count; the 0.1.0 name counts as wired so init stays idempotent across the rename.
  const importsGenie = /['"](genie-react|@genie-react\/react)['"]/.test(code)
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
    case 'skip':
      log.info(`${PREVIEW}${outcome.reason}`)
      return
    case 'missing':
      log.info(`${WARN} no Vite config found (looked for ${VITE_CONFIG_FILES.join(', ')})`)
      printViteManual(log)
      return
    case 'already':
      log.info(`${PREVIEW}${rel(ctx, outcome.path)} already wires ${VITE_PLUGIN_SPECIFIER}`)
      return
    case 'manual':
      log.info(`${WARN} could not edit ${rel(ctx, outcome.path)}: ${outcome.reason}`)
      printViteManual(log)
      return
    case 'edit': {
      const label = rel(ctx, outcome.path)
      if (dryRun) {
        log.info(`${PREVIEW}Would add the genie() plugin and its import to ${label}`)
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
      log.info(`${PREVIEW}${outcome.reason}`)
      return
    case 'already':
      log.info(`${PREVIEW}${rel(ctx, outcome.path)} already renders <Genie />`)
      return
    case 'manual':
      log.info(`${WARN} could not edit ${rel(ctx, outcome.path)}: ${outcome.reason}`)
      return
    case 'edit': {
      const label = rel(ctx, outcome.path)
      if (dryRun) {
        log.info(`${PREVIEW}Would render <Genie /> (dev-only) in ${label}`)
      } else {
        writeFileSync(outcome.path, outcome.contents)
        log.info(`${OK} added <Genie /> (dev-only) and its import to ${label}`)
      }
      return
    }
  }
}

function printNextSteps(
  log: Logger,
  framework: Framework,
  rootRoute: RootRouteOutcome,
  pm: PackageManagerHints,
): void {
  // 'skip' (plain React + Vite) still wants the render step: only <Genie /> surfaces the memory + plugin tools there.
  const componentHandled = rootRoute.action === 'edit' || rootRoute.action === 'already'
  let step = 1
  log.info('\nNext steps:')
  log.info(`  ${step++}. install Genie (if you have not yet):`)
  log.info('       npx @genie-react/cli link <path-to-genie>   # local checkout (no publish), or:')
  log.info(`       ${pm.add} ${requiredPackages(framework).join(' ')}`)
  if (!componentHandled) {
    log.info(`  ${step++}. render Genie near your app root (dev only):`)
    log.info(`       ${GENIE_IMPORT_LINE}`)
    log.info(`       ${GENIE_RENDER_SNIPPET}`)
  }
  log.info(`  ${step++}. start your dev server:`)
  log.info(`       ${pm.dev}`)
  log.info(`  ${step++}. drive the live tools from your shell:`)
  log.info('       npx @genie-react/cli status')
  log.info('       npx @genie-react/cli tools')
  log.info('       npx @genie-react/cli call react_get_renders \'{"sort":"renders"}\'')
}

function runNextInit(ctx: ApplyContext, options: InitOptions): InitResult {
  const { cwd, dryRun, log } = ctx
  const layout = planNextLayoutEdit(cwd)
  const instrumentation = planInstrumentation(cwd)

  applyNextLayoutOutcome(layout, ctx)
  applyInstrumentationOutcome(instrumentation, ctx)
  ensureGenieIgnored(ctx)
  ensureAgentSkill(ctx)
  printNextStepsForNext(log, packageManagerHints(cwd))
  if (!dryRun && !options.yes) {
    log.info("\nTip: run 'npx @genie-react/cli doctor' to verify the wiring.")
  }

  const layoutWired = layout.action === 'already' || layout.action === 'edit'
  return {
    ok: layoutWired,
    dryRun,
    framework: 'nextjs',
    viteConfig: {
      action: 'skip',
      reason: 'Next.js — the standalone hub serves the client, no Vite config needed',
    },
    rootRoute: layout,
    instrumentation,
  }
}

function detectNextLayout(cwd: string): string | null {
  for (const file of NEXT_LAYOUT_FILES) {
    const candidate = join(cwd, file)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function planNextLayoutEdit(cwd: string): RootRouteOutcome {
  const path = detectNextLayout(cwd)
  if (!path) return { action: 'missing' }

  const result = editNextLayout(readFileSafe(path))
  switch (result.kind) {
    case 'already':
      return { action: 'already', path }
    case 'manual':
      return { action: 'manual', path, reason: result.reason }
    case 'edited':
      return { action: 'edit', path, contents: result.code }
  }
}

function editNextLayout(code: string): ViteEditResult {
  const importsScript = /['"]genie-react\/(next|script)['"]/.test(code)
  const rendersScript = /<GenieScript\b/.test(code)
  if (importsScript && rendersScript) return { kind: 'already' }

  let next = code
  if (!rendersScript) {
    const match = /([ \t]*)<body([^>]*)>/.exec(next)
    if (!match) {
      return {
        kind: 'manual',
        reason: 'no <body> in the root layout — render <GenieScript /> by hand',
      }
    }
    const indent = match[1] ?? ''
    const insertion = `${match[0]}\n${indent}  <GenieScript />`
    next = next.slice(0, match.index) + insertion + next.slice(match.index + match[0].length)
  }
  if (!importsScript) next = insertImportLine(next, NEXT_IMPORT_LINE)
  return { kind: 'edited', code: next }
}

function planInstrumentation(cwd: string): RootRouteOutcome {
  for (const file of NEXT_INSTRUMENTATION_FILES) {
    const candidate = join(cwd, file)
    if (existsSync(candidate)) {
      if (/registerGenie/.test(readFileSafe(candidate)))
        return { action: 'already', path: candidate }
      return {
        action: 'manual',
        path: candidate,
        reason:
          'already exists — add `await registerGenie()` (from genie-react/next) to register() yourself',
      }
    }
  }
  const target = existsSync(join(cwd, 'src', 'app'))
    ? join(cwd, 'src', 'instrumentation.ts')
    : join(cwd, 'instrumentation.ts')
  return { action: 'edit', path: target, contents: NEXT_INSTRUMENTATION_TEMPLATE }
}

function applyNextLayoutOutcome(outcome: RootRouteOutcome, ctx: ApplyContext): void {
  const { dryRun, log } = ctx
  switch (outcome.action) {
    case 'missing':
      log.info(`${WARN} no root layout found (looked for ${NEXT_LAYOUT_FILES.join(', ')})`)
      return
    case 'skip':
      log.info(`${PREVIEW}${outcome.reason}`)
      return
    case 'already':
      log.info(`${PREVIEW}${rel(ctx, outcome.path)} already renders <GenieScript />`)
      return
    case 'manual':
      log.info(`${WARN} could not edit ${rel(ctx, outcome.path)}: ${outcome.reason}`)
      return
    case 'edit': {
      const label = rel(ctx, outcome.path)
      if (dryRun) {
        log.info(`${PREVIEW}Would render <GenieScript /> (dev-only) in ${label}`)
      } else {
        writeFileSync(outcome.path, outcome.contents)
        log.info(`${OK} added <GenieScript /> (dev-only) and its import to ${label}`)
      }
      return
    }
  }
}

function applyInstrumentationOutcome(outcome: RootRouteOutcome, ctx: ApplyContext): void {
  const { dryRun, log } = ctx
  switch (outcome.action) {
    case 'already':
      log.info(`${PREVIEW}${rel(ctx, outcome.path)} already calls registerGenie()`)
      return
    case 'manual':
      log.info(`${WARN} ${rel(ctx, outcome.path)}: ${outcome.reason}`)
      return
    case 'edit': {
      const label = rel(ctx, outcome.path)
      if (dryRun) {
        log.info(`${PREVIEW}Would create ${label} (starts the genie-react hub with next dev)`)
      } else {
        writeFileSync(outcome.path, outcome.contents)
        log.info(`${OK} created ${label} (starts the genie-react hub with next dev)`)
      }
      return
    }
    default:
      return
  }
}

function printNextStepsForNext(log: Logger, pm: PackageManagerHints): void {
  let step = 1
  log.info('\nNext steps:')
  log.info(`  ${step++}. install Genie (if you have not yet):`)
  log.info(`       ${pm.add} ${GENIE_PACKAGE} ${CLI_PACKAGE}`)
  log.info(
    `  ${step++}. start your dev server (instrumentation.ts starts the genie-react hub automatically):`,
  )
  log.info(`       ${pm.dev}`)
  log.info(`       # without instrumentation.ts, run the hub yourself: npx ${CLI_PACKAGE} hub`)
  log.info(`  ${step++}. drive the live tools from your shell:`)
  log.info(`       npx ${CLI_PACKAGE} status`)
  log.info(`       npx ${CLI_PACKAGE} call react_get_renders '{"sort":"renders"}'`)
}

function printUniversalSetup(log: Logger): void {
  log.info(`${PREVIEW}No Vite config or Next.js detected — universal setup for any React app:`)
  log.info(`  1. run the hub: npx ${CLI_PACKAGE} hub`)
  log.info(
    `  2. add first in <head>: <script src="http://localhost:${GENIE_DEFAULT_HUB_PORT}${GENIE_CLIENT_PATH}"></script>`,
  )
  log.info('     (the hub prints this tag with its actual port if 4390 was busy)')
}

function printUniversalNextSteps(log: Logger, pm: PackageManagerHints): void {
  let step = 1
  log.info('\nNext steps:')
  log.info(`  ${step++}. install Genie (if you have not yet):`)
  log.info(`       ${pm.add} ${GENIE_PACKAGE} ${CLI_PACKAGE}`)
  log.info(`  ${step++}. start the hub and your dev server, open the app in a browser`)
  log.info(`  ${step++}. drive the live tools from your shell:`)
  log.info(`       npx ${CLI_PACKAGE} status`)
  log.info(`       npx ${CLI_PACKAGE} call react_get_renders '{"sort":"renders"}'`)
}

function printViteManual(log: Logger): void {
  log.info('   add the plugin to your Vite config manually:')
  log.info(`     ${VITE_IMPORT_LINE}`)
  log.info('     export default defineConfig({')
  log.info('       plugins: [genie(), /* ...existing plugins */],')
  log.info('     })')
}

// The 0.1.0 scoped name counts as wired so re-running init after the rename cannot insert a duplicate import.
function referencesVitePlugin(code: string): boolean {
  return /['"](genie-react|@genie-react)\/vite['"]/.test(code)
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

/** `.genie/` holds the ephemeral bridge discovery file; keep it out of `git status` noise. */
function ensureGenieIgnored(ctx: ApplyContext): void {
  const { cwd, dryRun, log } = ctx
  if (!inGitRepo(cwd)) return
  const path = join(cwd, '.gitignore')
  const current = readFileSafe(path)
  if (/^\.genie\/?\s*$/m.test(current)) return
  if (dryRun) {
    log.info(`${PREVIEW}Would add .genie/ to .gitignore`)
    return
  }
  const base = current === '' || current.endsWith('\n') ? current : `${current}\n`
  writeFileSync(path, `${base}.genie/\n`)
  log.info(`${OK} added .genie/ to .gitignore`)
}

function ensureAgentSkill(ctx: ApplyContext): void {
  const bundled = readBundledSkill()
  if (!bundled) {
    ctx.log.info(`${WARN} bundled Genie skill is unavailable; reinstall ${CLI_PACKAGE}`)
    return
  }
  const path = join(ctx.cwd, AGENT_SKILL_PATH)
  if (readFileSafe(path) === bundled) return
  if (ctx.dryRun) {
    ctx.log.info(`${PREVIEW}Would install the versioned agent skill at ${AGENT_SKILL_PATH}`)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bundled)
  ctx.log.info(`${OK} installed the versioned agent skill at ${AGENT_SKILL_PATH}`)
}

function readBundledSkill(): string {
  try {
    return readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8')
  } catch {
    return ''
  }
}

function findActiveSkill(cwd: string): string | null {
  const candidates = [
    AGENT_SKILL_PATH,
    '.codex/skills/genie/SKILL.md',
    '.claude/skills/genie/SKILL.md',
  ]
  let directory = cwd
  while (true) {
    for (const candidate of candidates) {
      const path = join(directory, candidate)
      if (existsSync(path)) return path
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

function skillVersion(contents: string): string | null {
  const match = /^\s*version:\s*["']?([^\s"']+)/m.exec(contents)
  return match?.[1] ?? null
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function packageVersionAt(path: string | URL): string | null {
  const parsed = parseJson(readFileSafe(path))
  return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : null
}

// Walks up because monorepo apps keep `.git` at the repo root; worktrees/submodules use a `.git` file, which existsSync also covers.
function inGitRepo(cwd: string): boolean {
  let dir = cwd
  while (true) {
    if (existsSync(join(dir, '.git'))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

interface PackageManagerHints {
  add: string
  dev: string
}

function packageManagerHints(cwd: string): PackageManagerHints {
  switch (detectPackageManager(cwd)) {
    case 'yarn':
      return { add: 'yarn add -D', dev: 'yarn dev' }
    case 'bun':
      return { add: 'bun add -d', dev: 'bun dev' }
    case 'npm':
      return { add: 'npm install -D', dev: 'npm run dev' }
    case 'pnpm':
      return { add: 'pnpm add -D', dev: 'pnpm dev' }
  }
}

// Lockfile walk-up so a monorepo app dir reports the repo's real package manager; pnpm stays the no-lockfile default the docs use.
function detectPackageManager(cwd: string): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  let dir = cwd
  while (true) {
    if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
    if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
    if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun'
    if (existsSync(join(dir, 'package-lock.json'))) return 'npm'
    const parent = dirname(dir)
    if (parent === dir) return 'pnpm'
    dir = parent
  }
}

function rel(ctx: ApplyContext, path: string): string {
  return relative(ctx.cwd, path) || path
}

function readFileSafe(path: string | URL): string {
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
