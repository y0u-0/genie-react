#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_PACKAGE_ROOT = join(ROOT, 'packages/genie-react')
const CLI_PACKAGE_ROOT = join(ROOT, 'packages/cli')
const MAX_PROCESS_OUTPUT = 20_000
const CONSUMER_DEPENDENCIES = [
  'react@19.2.7',
  'react-dom@19.2.7',
  'vite@8.1.0',
  '@tanstack/react-query@5.101.2',
]

const childProcesses = new Set()
let browser
let viteProcess
let ownedDiscovery
let cleanupPromise
let interrupted = false
let temporaryRoot
let cliEntry
let viteEntry
let discoveryDirectory
let discoveryFile

function appendBounded(current, chunk) {
  const combined = current + chunk.toString()
  return combined.length <= MAX_PROCESS_OUTPUT ? combined : combined.slice(-MAX_PROCESS_OUTPUT)
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && typeof error === 'object' && error.code === 'EPERM'
  }
}

async function readDiscovery() {
  if (!discoveryFile) return undefined
  try {
    const value = JSON.parse(await readFile(discoveryFile, 'utf8'))
    if (!value || typeof value !== 'object') return undefined
    return {
      pid: typeof value.pid === 'number' ? value.pid : undefined,
      url: typeof value.url === 'string' ? value.url : undefined,
    }
  } catch {
    return undefined
  }
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  )
  if (!address || typeof address === 'string') throw new Error('Could not allocate an E2E port')
  return address.port
}

function startVite(port) {
  if (!temporaryRoot || !viteEntry) throw new Error('Packed Vite consumer is not installed')
  const child = spawn(
    process.execPath,
    [viteEntry, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: temporaryRoot,
      detached: process.platform !== 'win32',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  childProcesses.add(child)
  child.once('close', () => childProcesses.delete(child))
  child.stdout.on('data', (chunk) => {
    child.stdoutLog = appendBounded(child.stdoutLog ?? '', chunk)
  })
  child.stderr.on('data', (chunk) => {
    child.stderrLog = appendBounded(child.stderrLog ?? '', chunk)
  })
  return child
}

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await probe()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${label}${detail}`)
}

async function waitForVite(port) {
  return waitFor(
    'the Vite demo',
    async () => {
      if (viteProcess.exitCode !== null || viteProcess.signalCode !== null) {
        throw new Error(
          `Vite exited early\nstdout:\n${viteProcess.stdoutLog ?? ''}\nstderr:\n${viteProcess.stderrLog ?? ''}`,
        )
      }
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1_000),
      })
      return response.ok
    },
    30_000,
  )
}

async function runProcess(command, args, { cwd, env = process.env, timeoutMs = 12_000 } = {}) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  childProcesses.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout = appendBounded(stdout, chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr = appendBounded(stderr, chunk)
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  try {
    const [code, signal] = await once(child, 'close')
    return { code, signal, stdout, stderr }
  } finally {
    clearTimeout(timer)
    childProcesses.delete(child)
  }
}

async function runCli(args, timeoutMs = 12_000) {
  if (!temporaryRoot || !cliEntry) throw new Error('Packed CLI is not installed')
  const env = { ...process.env }
  delete env.GENIE_BRIDGE_URL
  delete env.GENIE_BRIDGE_PORT
  delete env.GENIE_SESSION
  return runProcess(process.execPath, [cliEntry, ...args], { cwd: temporaryRoot, env, timeoutMs })
}

function parseSuccessfulJson(command, result) {
  if (result.code !== 0) {
    throw new Error(
      `${command} exited ${result.code ?? result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`${command} emitted invalid JSON: ${error.message}\nstdout:\n${result.stdout}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function preparePackagedConsumer() {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'genie-vite-e2e-'))
  discoveryDirectory = join(temporaryRoot, '.genie')
  discoveryFile = join(discoveryDirectory, 'bridge.json')
  await mkdir(join(temporaryRoot, 'src'), { recursive: true })
  await writeFile(
    join(temporaryRoot, 'package.json'),
    `${JSON.stringify({ name: 'genie-vite-e2e', private: true, type: 'module' }, null, 2)}\n`,
  )
  await writeFile(
    join(temporaryRoot, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>\n',
  )
  await writeFile(
    join(temporaryRoot, 'vite.config.mjs'),
    `import { defineConfig } from 'vite'
import { genie } from 'genie-react/vite'

export default defineConfig({ plugins: [genie()] })
`,
  )
  await writeFile(
    join(temporaryRoot, 'src/main.js'),
    `import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { Genie } from 'genie-react'

const queryClient = new QueryClient()

function App() {
  const query = useQuery({ queryKey: ['greeting'], queryFn: async () => 'hello' })
  return createElement('main', { id: 'lab' }, query.data ?? query.status)
}

createRoot(document.getElementById('root')).render(
  createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(App),
    createElement(Genie, { queryClient }),
  ),
)
`,
  )

  const tarballs = []
  for (const packageRoot of [RUNTIME_PACKAGE_ROOT, CLI_PACKAGE_ROOT]) {
    const packed = parseSuccessfulJson(
      `pnpm pack ${packageRoot}`,
      await runProcess('pnpm', ['pack', '--json', '--pack-destination', temporaryRoot], {
        cwd: packageRoot,
        timeoutMs: 30_000,
      }),
    )
    assert(
      typeof packed.filename === 'string',
      `pnpm pack did not return a filename for ${packageRoot}`,
    )
    tarballs.push(resolve(packed.filename))
  }

  const installed = await runProcess(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      ...tarballs,
      ...CONSUMER_DEPENDENCIES,
    ],
    { cwd: temporaryRoot, timeoutMs: 120_000 },
  )
  if (installed.code !== 0) {
    throw new Error(
      `Install packed consumer exited ${installed.code ?? installed.signal}\nstdout:\n${installed.stdout}\nstderr:\n${installed.stderr}`,
    )
  }

  cliEntry = join(temporaryRoot, 'node_modules', '@genie-react', 'cli', 'dist', 'cli.js')
  viteEntry = join(temporaryRoot, 'node_modules', 'vite', 'bin', 'vite.js')
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'close')
  try {
    if (child === viteProcess && process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGTERM')
    } else {
      child.kill('SIGTERM')
    }
  } catch {}
  if (await Promise.race([exited.then(() => true), delay(2_000).then(() => false)])) return
  try {
    if (child === viteProcess && process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGKILL')
    } else {
      child.kill('SIGKILL')
    }
  } catch {}
  await Promise.race([once(child, 'close'), delay(2_000)])
}

async function removeOwnedDiscovery() {
  if (!ownedDiscovery) return
  const current = await readDiscovery()
  if (current?.pid !== ownedDiscovery.pid || current.url !== ownedDiscovery.url) return
  await rm(discoveryFile, { force: true })
  await rmdir(discoveryDirectory).catch(() => {})
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    if (!ownedDiscovery && viteProcess) ownedDiscovery = await readDiscovery()
    if (browser) await Promise.race([browser.close(), delay(3_000)]).catch(() => {})
    await Promise.all([...childProcesses].map(stopChild))
    await removeOwnedDiscovery()
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  })()
  return cleanupPromise
}

function handleSignal(signal) {
  if (interrupted) return
  interrupted = true
  void cleanup().finally(() => {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    process.kill(process.pid, signal)
  })
}

const onSigint = () => handleSignal('SIGINT')
const onSigterm = () => handleSignal('SIGTERM')

async function main() {
  await preparePackagedConsumer()
  const existingDiscovery = await readDiscovery()
  if (existingDiscovery?.pid && processIsAlive(existingDiscovery.pid)) {
    throw new Error(
      `A Genie dev server is already using ${discoveryFile} (pid ${existingDiscovery.pid}); stop it before running the E2E check.`,
    )
  }

  const port = await availablePort()
  viteProcess = startVite(port)
  await waitForVite(port)
  ownedDiscovery = await waitFor('Vite bridge discovery', readDiscovery, 5_000)

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
  await page.locator('#lab').waitFor({ state: 'visible', timeout: 10_000 })

  const status = await waitFor(
    'a ready CLI session',
    async () => {
      const result = await runCli(['status', '--json', '--connect-timeout', '1000'], 5_000)
      const value = parseSuccessfulJson('genie-react status --json', result)
      if (value.connected === true && value.ready === true) return value
      throw new Error(`latest status was ${result.stdout.trim()}`)
    },
    20_000,
  )
  assert(
    Array.isArray(status.sessions) && status.sessions.some((session) => session.ready === true),
    'CLI status did not report a ready browser session',
  )

  const tree = await waitFor(
    'React tree data through the CLI',
    async () => {
      const result = await runCli([
        'call',
        'react_get_tree',
        JSON.stringify({ depth: 4, maxNodes: 100 }),
        '--json',
        '--connect-timeout',
        '2000',
        '--wait',
        '5000',
      ])
      const value = parseSuccessfulJson('genie-react call react_get_tree', result)
      if (Array.isArray(value.nodes) && value.nodes.length > 0) return value
      throw new Error(`latest React tree was ${result.stdout.trim()}`)
    },
    15_000,
  )
  assert(
    tree.nodes.some((node) => node?.name === 'App'),
    'React tree did not include the demo App component',
  )

  const queryList = await waitFor(
    'TanStack Query data through the CLI',
    async () => {
      const result = await runCli([
        'call',
        'query_list',
        JSON.stringify({ limit: 20 }),
        '--json',
        '--connect-timeout',
        '2000',
        '--wait',
        '5000',
      ])
      const value = parseSuccessfulJson('genie-react call query_list', result)
      if (Array.isArray(value.queries) && value.queries.length > 0) return value
      throw new Error(`latest Query list was ${result.stdout.trim()}`)
    },
    15_000,
  )
  assert(
    queryList.queries.some((query) => JSON.stringify(query?.queryKey) === '["greeting"]'),
    'Query list did not include the demo greeting query',
  )
  assert(pageErrors.length === 0, `Browser page errors:\n${pageErrors.join('\n')}`)

  process.stdout.write(
    `Packed Vite E2E passed on port ${port}: CLI status ready, ${tree.nodes.length} React nodes, and ${queryList.queries.length} Query record(s).\n`,
  )
}

process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)

try {
  await main()
} finally {
  await cleanup()
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
}
