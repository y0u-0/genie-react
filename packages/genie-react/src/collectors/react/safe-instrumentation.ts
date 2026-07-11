import {
  detectReactBuildType,
  type Fiber,
  type FiberRoot,
  getRDTHook,
  type ReactRenderer,
} from 'bippy'

const MIN_REACT_MAJOR = 18

function rendererFor(rendererId: number): ReactRenderer | null {
  try {
    return getRDTHook().renderers.get(rendererId) ?? null
  } catch {
    return null
  }
}

/** Fail closed: Genie only inspects supported development renderers. */
export function isSafeRenderer(rendererId: number): boolean {
  const renderer = rendererFor(rendererId)
  if (!renderer || detectReactBuildType(renderer) !== 'development') return false
  const major = Number.parseInt(renderer.version?.split('.')[0] ?? '', 10)
  return Number.isFinite(major) && major >= MIN_REACT_MAJOR
}

/** Local replacement for Bippy's removed secure(): renderer gating plus an exception boundary. */
export function safeCommitHandler(
  handler: (rendererId: number, root: FiberRoot) => void,
): (rendererId: number, root: FiberRoot) => void {
  return (rendererId, root) => {
    if (!isSafeRenderer(rendererId)) return
    try {
      handler(rendererId, root)
    } catch {
      // Instrumentation must never escape into React's commit lifecycle.
    }
  }
}

/** Unmount callbacks need the same production/version/error safeguards as root commits. */
export function safeUnmountHandler(
  handler: (rendererId: number, fiber: Fiber) => void,
): (rendererId: number, fiber: Fiber) => void {
  return (rendererId, fiber) => {
    if (!isSafeRenderer(rendererId)) return
    try {
      handler(rendererId, fiber)
    } catch {
      // Instrumentation must never escape into React's commit lifecycle.
    }
  }
}
