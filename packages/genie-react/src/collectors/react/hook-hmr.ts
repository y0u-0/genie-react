import { disposeHookInstrumentation } from './hook'
import { beginBundlerUpdate, completeBundlerUpdate } from './refresh-tracker'

interface HotModule {
  dispose(callback: () => void): void
  on(event: 'vite:beforeUpdate' | 'vite:afterUpdate', callback: () => void): void
  off(event: 'vite:beforeUpdate' | 'vite:afterUpdate', callback: () => void): void
}

const hot = (import.meta as ImportMeta & { hot?: HotModule }).hot
hot?.on('vite:beforeUpdate', beginBundlerUpdate)
hot?.on('vite:afterUpdate', completeBundlerUpdate)
hot?.dispose(() => {
  hot.off('vite:beforeUpdate', beginBundlerUpdate)
  hot.off('vite:afterUpdate', completeBundlerUpdate)
  disposeHookInstrumentation()
})
