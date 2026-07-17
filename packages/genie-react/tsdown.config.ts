import { defineConfig } from 'tsdown'

const shared = {
  format: ['esm'],
  dts: true,
  treeshake: true,
  fixedExtension: false,
} satisfies Parameters<typeof defineConfig>[0]

// Browser and Node entries build separately; browser entries share chunks, so the injected client and <Genie /> get one module instance per page.
export default defineConfig([
  {
    ...shared,
    entry: {
      index: 'src/react/index.ts',
      hook: 'src/collectors/react/hook.ts',
      'hook-hmr': 'src/collectors/react/hook-hmr.ts',
      client: 'src/client-entry.ts',
      collectors: 'src/collectors/index.ts',
      'collectors/query': 'src/collectors/query.ts',
      'collectors/router': 'src/collectors/router.ts',
      native: 'src/native/index.ts',
      script: 'src/script.ts',
      next: 'src/next/index.ts',
      protocol: 'src/protocol/index.ts',
    },
    platform: 'neutral',
    clean: true,
    external: [
      /^bippy/,
      /^react/,
      /^@tanstack\//,
      /^genie-react\//,
      'zod',
      'superjson',
      'ws',
      '@jridgewell/sourcemap-codec',
    ],
  },
  {
    ...shared,
    entry: {
      vite: 'src/vite/index.ts',
      hub: 'src/hub/index.ts',
    },
    platform: 'node',
    clean: false,
    external: ['vite', 'ws', 'zod', 'superjson'],
  },
  {
    format: ['iife'],
    entry: { 'client.global': 'src/client-global.ts' },
    platform: 'browser',
    dts: false,
    minify: true,
    treeshake: true,
    fixedExtension: false,
    clean: false,
    // Self-contained on purpose: the hub serves this single file to pages with no bundler integration.
    noExternal: [/./],
  },
])
