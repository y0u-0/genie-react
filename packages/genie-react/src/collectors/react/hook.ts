// Side-effect entry — import as the page's very first module so the DevTools hook installs BEFORE React loads and commit callbacks are delivered.
import 'bippy/install-hook-only'
import { installErrorCapture, uninstallErrorCapture } from './error-tracker'
import { guardCommitStream } from './hook-guard'
import { disposeUnmountPruning, ensureUnmountPruning } from './overrides'
import { disposeRefreshTracking, startRefreshTracking } from './refresh-tracker'
import { disposeRenderTracking, startRenderTracking } from './render-tracker'

installErrorCapture()
startRefreshTracking()
startRenderTracking()
ensureUnmountPruning()
// Guard LAST, once every bippy registration is final, so the trapped upstream is the complete dispatcher.
const unguardCommitStream = guardCommitStream()

/** Explicit module teardown; Vite registers it through the separate ESM-only hook-hmr entry. */
export function disposeHookInstrumentation(): void {
  unguardCommitStream()
  uninstallErrorCapture()
  disposeUnmountPruning()
  disposeRenderTracking()
  disposeRefreshTracking()
}
