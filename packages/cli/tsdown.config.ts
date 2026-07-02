import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  treeshake: true,
  fixedExtension: false,
  platform: 'node',
  external: [/^genie-react/],
})
