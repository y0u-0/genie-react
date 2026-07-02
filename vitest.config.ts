import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const entry = (path: string) =>
  fileURLToPath(new URL(`./packages/genie-react/src/${path}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: 'genie-react/protocol', replacement: entry('protocol/index.ts') },
      { find: 'genie-react/client', replacement: entry('client-entry.ts') },
      { find: 'genie-react/hook', replacement: entry('collectors/react/hook.ts') },
      { find: 'genie-react/hub', replacement: entry('hub/index.ts') },
      { find: 'genie-react/vite', replacement: entry('vite/index.ts') },
      { find: /^genie-react$/, replacement: entry('react/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
})
