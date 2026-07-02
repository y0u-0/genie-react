// Side-effect entry — import as the page's very first module so the DevTools hook installs BEFORE React loads and commit callbacks are delivered.
import 'bippy/install-hook-only'
import { installErrorCapture } from './error-tracker'
import { startRenderTracking } from './render-tracker'

installErrorCapture()
startRenderTracking()
