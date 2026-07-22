#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_ROOT = join(ROOT, 'packages/genie-react')
const PROFILES = {
  minimum: {
    react: '18.0.0',
    'react-dom': '18.0.0',
    vite: '5.0.0',
    '@tanstack/react-query': '5.0.0',
    '@tanstack/react-router': '1.0.0',
  },
  // Keep these exact pins aligned with the workspace's resolved development stack.
  current: {
    react: '19.2.7',
    'react-dom': '19.2.7',
    vite: '8.1.0',
    '@tanstack/react-query': '5.101.2',
    '@tanstack/react-router': '1.170.17',
  },
}

function selectedProfiles(argv) {
  if (argv.length === 0) return Object.keys(PROFILES)
  if (argv.length === 2 && argv[0] === '--profile' && argv[1] in PROFILES) return [argv[1]]
  throw new Error(
    `Usage: node scripts/check-compatibility.mjs [--profile ${Object.keys(PROFILES).join('|')}]`,
  )
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function packRuntime(directory) {
  const output = execFileSync('pnpm', ['pack', '--json', '--pack-destination', directory], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
  return resolve(JSON.parse(output).filename)
}

function writeConsumer(directory, profile, versions, tarball) {
  mkdirSync(join(directory, 'src'), { recursive: true })
  writeJson(join(directory, 'package.json'), {
    name: `genie-compatibility-${profile}`,
    private: true,
    type: 'module',
  })
  writeFileSync(
    join(directory, 'index.html'),
    '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>\n',
  )
  writeFileSync(
    join(directory, 'vite.config.mjs'),
    `import { defineConfig } from 'vite'\nimport { genie } from 'genie-react/vite'\n\nexport default defineConfig({ plugins: [genie()] })\n`,
  )
  writeFileSync(
    join(directory, 'src/main.js'),
    `import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { RootRoute, Route, Router, RouterProvider } from '@tanstack/react-router'
import { Genie } from 'genie-react'

const queryClient = new QueryClient()
const rootRoute = new RootRoute()
const indexRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/',
  component: App,
})
const router = new Router({ routeTree: rootRoute.addChildren([indexRoute]) })

function App() {
  const query = useQuery({ queryKey: ['compatibility'], queryFn: async () => 'ready' })
  return createElement('main', null, query.data ?? query.status)
}

createRoot(document.getElementById('root')).render(
  createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(RouterProvider, { router }),
    createElement(Genie, { queryClient, router }),
  ),
)
`,
  )
  writeFileSync(
    join(directory, 'verify-imports.mjs'),
    `import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { QueryClient } from '@tanstack/react-query'
import * as TanStackRouterModule from '@tanstack/react-router'
import { Genie } from 'genie-react'
import { queryCollector } from 'genie-react/collectors/query'
import { routerCollector } from 'genie-react/collectors/router'
import { genie } from 'genie-react/vite'

const { RootRoute, Route, Router } =
  TanStackRouterModule.default ?? TanStackRouterModule
const queryClient = new QueryClient()
const rootRoute = new RootRoute()
const indexRoute = new Route({ getParentRoute: () => rootRoute, path: '/' })
const router = new Router({ routeTree: rootRoute.addChildren([indexRoute]) })
const rendered = renderToString(createElement(Genie, { queryClient, router }))
if (rendered !== '') throw new Error('Genie must render no markup')
if (!Array.isArray(queryCollector(queryClient).tools)) {
  throw new Error('Query collector did not initialize')
}
const routerTools = routerCollector(router).tools
const routerToolNames = routerTools?.map((tool) => tool.contract.name)
if (
  routerToolNames?.length !== 11 ||
  !routerToolNames.includes('router_get_state') ||
  !routerToolNames.includes('router_navigate')
) {
  throw new Error('Router collector did not initialize with the expected tools')
}
const plugins = genie({ enabled: false })
if (!Array.isArray(plugins) || plugins.length !== 2) {
  throw new Error('Vite plugin did not initialize')
}
`,
  )

  const dependencies = [
    tarball,
    ...Object.entries(versions).map(([name, version]) => `${name}@${version}`),
  ]
  execFileSync(
    'npm',
    [
      'install',
      '--strict-peer-deps',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      ...dependencies,
    ],
    { cwd: directory, stdio: 'inherit' },
  )
}

function assertInstalledVersions(directory, expected) {
  for (const [name, version] of Object.entries(expected)) {
    const manifest = JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json')))
    if (manifest.version !== version) {
      throw new Error(`${name}: expected ${version}, installed ${manifest.version}`)
    }
  }
}

function verifyConsumer(directory) {
  execFileSync(process.execPath, ['verify-imports.mjs'], { cwd: directory, stdio: 'inherit' })
  execFileSync(process.execPath, [join(directory, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: directory,
    stdio: 'inherit',
  })
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'genie-compatibility-'))

try {
  const tarball = packRuntime(temporaryRoot)
  for (const profile of selectedProfiles(process.argv.slice(2))) {
    const directory = join(temporaryRoot, profile)
    const versions = PROFILES[profile]
    writeConsumer(directory, profile, versions, tarball)
    assertInstalledVersions(directory, versions)
    verifyConsumer(directory)
    process.stdout.write(
      `Compatibility ${profile} passed on Node ${process.version}: ${Object.entries(versions)
        .map(([name, version]) => `${name}@${version}`)
        .join(', ')}\n`,
    )
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
