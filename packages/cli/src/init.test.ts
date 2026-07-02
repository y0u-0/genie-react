import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectFramework, type Logger, runDoctor, runInit } from './index'

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`

const ROUTER_ROOT = `import { Outlet, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

export const Route = createRootRoute({ component: RootComponent })

function RootComponent() {
  return (
    <>
      <Outlet />
      <TanStackRouterDevtools position="bottom-right" />
    </>
  )
}
`

const START_ROOT = `import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({ shellComponent: RootDocument })

function RootDocument({ children }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
`

const NEXT_LAYOUT = `export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`

const pkg = (deps: Record<string, string>): string =>
  JSON.stringify({ name: 'fixture', private: true, type: 'module', dependencies: deps }, null, 2)

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'genie-init-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(root, 'p-'))
  for (const [rel, contents] of Object.entries(files)) {
    const path = join(dir, rel)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents, 'utf8')
  }
  return dir
}

function capture(): { logger: Logger; lines: string[] } {
  const lines: string[] = []
  return { logger: { info: (m) => lines.push(m), error: (m) => lines.push(m) }, lines }
}

const silent: Logger = { info: () => {}, error: () => {} }

describe('detectFramework', () => {
  it('classifies a project with @tanstack/react-start as tanstack-start', async () => {
    const dir = await project({
      'package.json': pkg({
        '@tanstack/react-start': 'latest',
        '@tanstack/react-router': 'latest',
      }),
      'src/routes/__root.tsx': START_ROOT,
    })
    expect(detectFramework(dir)).toBe('tanstack-start')
  })

  it('classifies @tanstack/react-router + a __root route as tanstack-router', async () => {
    const dir = await project({
      'package.json': pkg({ '@tanstack/react-router': 'latest' }),
      'index.html': '<div id="app"></div>',
      'src/routes/__root.tsx': ROUTER_ROOT,
    })
    expect(detectFramework(dir)).toBe('tanstack-router')
  })

  it('classifies a bare index.html (no TanStack deps) as react-vite', async () => {
    const dir = await project({
      'package.json': pkg({ react: '^19', 'react-dom': '^19' }),
      'index.html': '<div id="root"></div>',
    })
    expect(detectFramework(dir)).toBe('react-vite')
  })

  it('treats start as more specific than router when both deps are present', async () => {
    const dir = await project({
      'package.json': pkg({
        '@tanstack/react-start': 'latest',
        '@tanstack/react-router': 'latest',
      }),
      'index.html': '<div id="root"></div>',
      'src/routes/__root.tsx': START_ROOT,
    })
    expect(detectFramework(dir)).toBe('tanstack-start')
  })

  it('falls back to tanstack-router when the router dep is present but no __root exists', async () => {
    const dir = await project({ 'package.json': pkg({ '@tanstack/react-router': 'latest' }) })
    expect(detectFramework(dir)).toBe('tanstack-router')
  })

  it('classifies a router dep + index.html with a non-default routes dir as tanstack-router, not react-vite', async () => {
    const dir = await project({
      'package.json': pkg({ '@tanstack/react-router': 'latest' }),
      'index.html': '<div id="app"></div>',
      'routes/__root.tsx': ROUTER_ROOT,
    })
    expect(detectFramework(dir)).toBe('tanstack-router')
  })

  it('classifies a project with next as nextjs', async () => {
    const dir = await project({
      'package.json': pkg({ next: '^16', react: '^19' }),
      'app/layout.tsx': NEXT_LAYOUT,
    })
    expect(detectFramework(dir)).toBe('nextjs')
  })

  it('classifies an empty project as unknown', async () => {
    const dir = await project({ 'package.json': pkg({}) })
    expect(detectFramework(dir)).toBe('unknown')
  })

  it('detects app/routes/__root.jsx as well as src/routes', async () => {
    const dir = await project({
      'package.json': pkg({ '@tanstack/react-router': 'latest' }),
      'app/routes/__root.jsx': ROUTER_ROOT,
    })
    expect(detectFramework(dir)).toBe('tanstack-router')
  })
})

describe('runInit — plain React + Vite', () => {
  it('wires the plugin, skips the component, and reports success', async () => {
    const dir = await project({
      'package.json': pkg({ react: '^19' }),
      'index.html': '<div id="root"></div>',
      'vite.config.ts': VITE_CONFIG,
    })
    const { logger, lines } = capture()
    const result = runInit({ cwd: dir, dryRun: true, logger })

    expect(result.framework).toBe('react-vite')
    expect(result.viteConfig.action).toBe('edit')
    expect(result.rootRoute.action).toBe('skip')
    expect(result.ok).toBe(true)
    expect(lines.join('\n')).not.toContain('no root route found')
  })

  it('lists the single genie-react package in next steps for a plain React app', async () => {
    const dir = await project({
      'package.json': pkg({ react: '^19' }),
      'index.html': '<div id="root"></div>',
      'vite.config.ts': VITE_CONFIG,
    })
    const { logger, lines } = capture()
    runInit({ cwd: dir, dryRun: true, logger })
    const text = lines.join('\n')
    expect(text).toContain('pnpm add -D genie-react @genie-react/cli')
  })

  it('still prints the <Genie /> render step — only it surfaces the memory + plugin tools', async () => {
    const dir = await project({
      'package.json': pkg({ react: '^19' }),
      'index.html': '<div id="root"></div>',
      'vite.config.ts': VITE_CONFIG,
    })
    const { logger, lines } = capture()
    runInit({ cwd: dir, dryRun: true, logger })
    const text = lines.join('\n')
    expect(text).toContain('render Genie near your app root')
    expect(text).toContain('{import.meta.env.DEV && <Genie />}')
  })
})

describe('runInit — universal (no Vite, no Next)', () => {
  it('treats the hub + script-tag path as a valid setup and exits ok', async () => {
    const dir = await project({ 'package.json': pkg({ react: '^19' }) })
    const { logger, lines } = capture()
    const result = runInit({ cwd: dir, dryRun: true, logger })
    const text = lines.join('\n')

    expect(result.framework).toBe('unknown')
    expect(result.ok).toBe(true)
    expect(text).toContain('universal setup')
    expect(text).toContain('client.js')
    expect(text).not.toContain('add the plugin to your Vite config manually')
    expect(text).not.toContain('<Genie />}')
  })
})

describe('runInit — TanStack Router SPA', () => {
  it('inserts <Genie /> after <Outlet /> and adds the import', async () => {
    const dir = await project({
      'package.json': pkg({ '@tanstack/react-router': 'latest' }),
      'index.html': '<div id="app"></div>',
      'vite.config.ts': VITE_CONFIG,
      'src/routes/__root.tsx': ROUTER_ROOT,
    })
    const result = runInit({ cwd: dir, dryRun: true, logger: silent })

    expect(result.framework).toBe('tanstack-router')
    expect(result.rootRoute.action).toBe('edit')
    if (result.rootRoute.action !== 'edit') throw new Error('expected edit')
    expect(result.rootRoute.contents).toContain('<><Outlet />{import.meta.env.DEV && <Genie />}</>')
    expect(result.rootRoute.contents).toContain("import { Genie } from 'genie-react'")
    expect(result.ok).toBe(true)
  })

  it('reports manual when the root route has no <Outlet />, but still exits ok', async () => {
    const dir = await project({
      'package.json': pkg({ '@tanstack/react-router': 'latest' }),
      'index.html': '<div id="app"></div>',
      'vite.config.ts': VITE_CONFIG,
      'src/routes/__root.tsx': 'export const Route = {}\n',
    })
    const result = runInit({ cwd: dir, dryRun: true, logger: silent })

    expect(result.rootRoute.action).toBe('manual')
    expect(result.ok).toBe(true)
  })
})

describe('runInit — TanStack Start', () => {
  it('inserts <Genie /> before </body>', async () => {
    const dir = await project({
      'package.json': pkg({ '@tanstack/react-start': 'latest' }),
      'vite.config.ts': VITE_CONFIG,
      'src/routes/__root.tsx': START_ROOT,
    })
    const result = runInit({ cwd: dir, dryRun: true, logger: silent })

    expect(result.framework).toBe('tanstack-start')
    expect(result.rootRoute.action).toBe('edit')
    if (result.rootRoute.action !== 'edit') throw new Error('expected edit')
    expect(result.rootRoute.contents).toMatch(
      /\{import\.meta\.env\.DEV && <Genie \/>\}\n\s*<\/body>/,
    )
    expect(result.ok).toBe(true)
  })

  it('fails when the component cannot be wired (no </body>), since Start has no other client path', async () => {
    const dir = await project({
      'package.json': pkg({ '@tanstack/react-start': 'latest' }),
      'vite.config.ts': VITE_CONFIG,
      'src/routes/__root.tsx': 'export const Route = {}\n',
    })
    const result = runInit({ cwd: dir, dryRun: true, logger: silent })

    expect(result.rootRoute.action).toBe('manual')
    expect(result.ok).toBe(false)
  })
})

describe('runInit — apps wired by the published 0.1.0 names stay idempotent', () => {
  it('treats @genie-react/vite and @genie-react/react imports as already wired', async () => {
    const dir = await project({
      'package.json': pkg({ '@tanstack/react-router': 'latest' }),
      'index.html': '<div id="app"></div>',
      'vite.config.ts': `import { genie } from '@genie-react/vite'\n${VITE_CONFIG.replace('react()', 'genie(), react()')}`,
      'src/routes/__root.tsx': `import { Genie } from '@genie-react/react'\n${ROUTER_ROOT.replace('<Outlet />', '<><Outlet />{import.meta.env.DEV && <Genie />}</>')}`,
    })
    const result = runInit({ cwd: dir, dryRun: true, logger: silent })

    expect(result.viteConfig.action).toBe('already')
    expect(result.rootRoute.action).toBe('already')
  })
})

describe('runInit — Next.js', () => {
  it('inserts <GenieScript /> after <body> and plans instrumentation.ts', async () => {
    const dir = await project({
      'package.json': pkg({ next: '^16', react: '^19' }),
      'app/layout.tsx': NEXT_LAYOUT,
    })
    const result = runInit({ cwd: dir, dryRun: true, logger: silent })

    expect(result.framework).toBe('nextjs')
    expect(result.rootRoute.action).toBe('edit')
    if (result.rootRoute.action !== 'edit') throw new Error('expected edit')
    expect(result.rootRoute.contents).toContain("import { GenieScript } from 'genie-react/next'")
    expect(result.rootRoute.contents).toMatch(/<body>\n\s*<GenieScript \/>/)
    expect(result.instrumentation?.action).toBe('edit')
    if (result.instrumentation?.action !== 'edit') throw new Error('expected edit')
    expect(result.instrumentation.contents).toContain('registerGenie')
    expect(result.ok).toBe(true)
  })

  it('creates instrumentation.ts and is idempotent on a second run', async () => {
    const dir = await project({
      'package.json': pkg({ next: '^16', react: '^19' }),
      'app/layout.tsx': NEXT_LAYOUT,
    })
    const first = runInit({ cwd: dir, logger: silent })
    expect(first.rootRoute.action).toBe('edit')
    expect(first.instrumentation?.action).toBe('edit')

    const instrumentation = await readFile(join(dir, 'instrumentation.ts'), 'utf8')
    expect(instrumentation).toContain("await import('genie-react/next')")

    const second = runInit({ cwd: dir, logger: silent })
    expect(second.rootRoute.action).toBe('already')
    expect(second.instrumentation?.action).toBe('already')
  })

  it('respects src/ layouts and leaves an existing foreign instrumentation file alone', async () => {
    const dir = await project({
      'package.json': pkg({ next: '^16', react: '^19' }),
      'src/app/layout.tsx': NEXT_LAYOUT,
      'src/instrumentation.ts': 'export function register() {}\n',
    })
    const result = runInit({ cwd: dir, logger: silent })

    expect(result.rootRoute.action).toBe('edit')
    expect(result.instrumentation?.action).toBe('manual')
    expect(result.ok).toBe(true)
  })

  it('reports manual when the layout has no <body>', async () => {
    const dir = await project({
      'package.json': pkg({ next: '^16', react: '^19' }),
      'app/layout.tsx': 'export default function RootLayout() { return null }\n',
    })
    const result = runInit({ cwd: dir, dryRun: true, logger: silent })

    expect(result.rootRoute.action).toBe('manual')
    expect(result.ok).toBe(false)
  })
})

describe('runDoctor — Next.js', () => {
  it('checks the app layout for <GenieScript /> instead of a Vite config', async () => {
    const dir = await project({
      'package.json': pkg({ next: '^16', react: '^19' }),
      'app/layout.tsx': NEXT_LAYOUT.replace('<body>', '<body>\n        <GenieScript />'),
    })
    const result = runDoctor({ cwd: dir, logger: silent })

    expect(result.framework).toBe('nextjs')
    const layoutCheck = result.checks.find((c) => c.label.includes('GenieScript'))
    expect(layoutCheck?.ok).toBe(true)
    expect(result.checks.some((c) => c.label.includes('Vite config'))).toBe(false)
  })
})

describe('runInit — idempotency and dry-run', () => {
  it('reports already on a second run for TanStack Router and writes nothing the second time', async () => {
    const dir = await project({
      'package.json': pkg({ '@tanstack/react-router': 'latest' }),
      'index.html': '<div id="app"></div>',
      'vite.config.ts': VITE_CONFIG,
      'src/routes/__root.tsx': ROUTER_ROOT,
    })

    const first = runInit({ cwd: dir, logger: silent })
    expect(first.rootRoute.action).toBe('edit')
    expect(first.viteConfig.action).toBe('edit')

    const afterFirst = await readFile(join(dir, 'src/routes/__root.tsx'), 'utf8')

    const second = runInit({ cwd: dir, logger: silent })
    expect(second.rootRoute.action).toBe('already')
    expect(second.viteConfig.action).toBe('already')

    const afterSecond = await readFile(join(dir, 'src/routes/__root.tsx'), 'utf8')
    expect(afterSecond).toBe(afterFirst)
  })

  it('writes no files in dry-run mode', async () => {
    const dir = await project({
      'package.json': pkg({ '@tanstack/react-start': 'latest' }),
      'vite.config.ts': VITE_CONFIG,
      'src/routes/__root.tsx': START_ROOT,
    })

    const result = runInit({ cwd: dir, dryRun: true, logger: silent })
    expect(result.dryRun).toBe(true)

    expect(await readFile(join(dir, 'vite.config.ts'), 'utf8')).toBe(VITE_CONFIG)
    expect(await readFile(join(dir, 'src/routes/__root.tsx'), 'utf8')).toBe(START_ROOT)
  })
})

describe('runDoctor — package checks', () => {
  it('checks the single genie-react package for a plain React + Vite app', async () => {
    const dir = await project({
      'package.json': pkg({ react: '^19' }),
      'index.html': '<div id="root"></div>',
      'vite.config.ts': VITE_CONFIG.replace('react()', 'genie(), react()'),
    })
    const result = runDoctor({ cwd: dir, logger: silent })

    expect(result.framework).toBe('react-vite')
    const labels = result.checks.map((c) => c.label)
    expect(labels).toContain('genie-react resolvable in node_modules')
  })

  it('checks the same package set for a TanStack Start app', async () => {
    const dir = await project({
      'package.json': pkg({ '@tanstack/react-start': 'latest' }),
      'vite.config.ts': VITE_CONFIG,
      'src/routes/__root.tsx': START_ROOT,
    })
    const result = runDoctor({ cwd: dir, logger: silent })

    expect(result.framework).toBe('tanstack-start')
    const labels = result.checks.map((c) => c.label)
    expect(labels).toContain('genie-react resolvable in node_modules')
  })
})
