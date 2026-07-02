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
      client: 'src/client-entry.ts',
      protocol: 'src/protocol/index.ts',
    },
    platform: 'neutral',
    clean: true,
    external: [
      /^bippy/,
      /^react/,
      /^@tanstack\//,
      'zod',
      'superjson',
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
])
