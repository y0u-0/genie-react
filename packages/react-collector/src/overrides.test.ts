import { ClassComponentTag, type Fiber, FunctionComponentTag, SuspenseComponentTag } from 'bippy'
import { describe, expect, it } from 'vitest'
import { hookChain } from './fiber'
import {
  applyContextOverride,
  applyErrorOverride,
  applyHookStateOverride,
  applySuspenseOverride,
  type DevRenderer,
  findErrorBoundary,
  findSuspenseBoundary,
  isErrorBoundaryFiber,
  isStateHook,
  overrideFiberProps,
  resolveContextProvider,
} from './overrides'

const CONTEXT_PROVIDER_TAG = 10

const fiber = (over: Record<string, unknown> = {}): Fiber =>
  ({
    tag: FunctionComponentTag,
    type: function Component() {},
    return: null,
    alternate: null,
    memoizedState: null,
    dependencies: null,
    stateNode: null,
    ...over,
  }) as unknown as Fiber

function fakeRenderer() {
  const scheduled: Fiber[] = []
  const hookCalls: Array<[Fiber, string, string[], unknown]> = []
  const propsCalls: Array<[Fiber, string[], unknown]> = []
  let suspenseHandler: ((instance: unknown) => boolean) | null = null
  let errorHandler: ((f: Fiber) => boolean) | null = null
  const renderer: DevRenderer = {
    scheduleUpdate: (f) => void scheduled.push(f),
    setSuspenseHandler: (h) => {
      suspenseHandler = h
    },
    setErrorHandler: (h) => {
      errorHandler = h
    },
    overrideHookState: (f, id, path, value) => void hookCalls.push([f, id, path, value]),
    overrideProps: (f, path, value) => void propsCalls.push([f, path, value]),
  }
  return {
    renderer,
    scheduled,
    hookCalls,
    propsCalls,
    suspense: (instance: unknown) => suspenseHandler?.(instance),
    error: (f: Fiber) => errorHandler?.(f),
  }
}

describe('findSuspenseBoundary / findErrorBoundary', () => {
  it('walks up to the nearest Suspense fiber, or null', () => {
    const boundary = fiber({ tag: SuspenseComponentTag, type: undefined })
    const child = fiber({ return: boundary })
    expect(findSuspenseBoundary(child)).toBe(boundary)
    expect(findSuspenseBoundary(boundary)).toBe(boundary)
    expect(findSuspenseBoundary(fiber())).toBeNull()
  })

  it('recognizes error boundaries by static getDerivedStateFromError or componentDidCatch', () => {
    const viaStatic = fiber({
      tag: ClassComponentTag,
      type: Object.assign(function Boundary() {}, { getDerivedStateFromError: () => ({}) }),
    })
    const viaInstance = fiber({
      tag: ClassComponentTag,
      type: function Catcher() {},
      stateNode: { componentDidCatch: () => {} },
    })
    const plainClass = fiber({ tag: ClassComponentTag, type: function Plain() {} })
    expect(isErrorBoundaryFiber(viaStatic)).toBe(true)
    expect(isErrorBoundaryFiber(viaInstance)).toBe(true)
    expect(isErrorBoundaryFiber(plainClass)).toBe(false)
    expect(isErrorBoundaryFiber(fiber())).toBe(false)

    const child = fiber({ return: viaStatic })
    expect(findErrorBoundary(child)).toBe(viaStatic)
    expect(findErrorBoundary(fiber())).toBeNull()
  })
})

describe('applySuspenseOverride', () => {
  it('throws with an actionable message when no boundary exists', () => {
    const { renderer } = fakeRenderer()
    expect(() => applySuspenseOverride(fiber(), true, renderer)).toThrow(/No <Suspense> boundary/)
  })

  it('forces and releases a boundary, matching both fiber buffers', () => {
    const harness = fakeRenderer()
    const alternate = fiber({ tag: SuspenseComponentTag, type: undefined })
    const boundary = fiber({ tag: SuspenseComponentTag, type: undefined, alternate })
    Object.assign(alternate, { alternate: boundary })
    const inside = fiber({ return: boundary })

    const forced = applySuspenseOverride(inside, true, harness.renderer)
    expect(forced.boundary).toBe(boundary)
    expect(forced.active).toBe(1)
    expect(harness.scheduled).toContain(boundary)
    expect(harness.suspense(boundary)).toBe(true)
    expect(harness.suspense(alternate)).toBe(true)
    expect(harness.suspense(fiber({ tag: SuspenseComponentTag, type: undefined }))).toBe(false)

    // Idempotent: forcing again does not double-count the boundary.
    expect(applySuspenseOverride(boundary, true, harness.renderer).active).toBe(1)

    const released = applySuspenseOverride(alternate, false, harness.renderer)
    expect(released.active).toBe(0)
    expect(harness.suspense(boundary)).toBe(false)
  })

  it('releasing a boundary that was never forced is a no-op (no re-render)', () => {
    const harness = fakeRenderer()
    const boundary = fiber({ tag: SuspenseComponentTag, type: undefined })
    const before = harness.scheduled.length
    const result = applySuspenseOverride(boundary, false, harness.renderer)
    expect(harness.scheduled.length).toBe(before)
    expect(result.boundary).toBe(boundary)
  })
})

describe('applyErrorOverride', () => {
  const boundaryFiber = () =>
    fiber({
      tag: ClassComponentTag,
      type: Object.assign(function Boundary() {}, { getDerivedStateFromError: () => ({}) }),
    })

  it('throws with an actionable message when no boundary exists', () => {
    const { renderer } = fakeRenderer()
    expect(() => applyErrorOverride(fiber(), true, renderer)).toThrow(/No error boundary/)
  })

  it('forces, then releases with a one-shot false that self-clears', () => {
    const harness = fakeRenderer()
    const boundary = boundaryFiber()
    const inside = fiber({ return: boundary })

    const forced = applyErrorOverride(inside, true, harness.renderer)
    expect(forced.boundary).toBe(boundary)
    expect(forced.active).toBe(1)
    expect(harness.error(boundary)).toBe(true)
    expect(harness.error(boundaryFiber())).toBeNull()

    const released = applyErrorOverride(boundary, false, harness.renderer)
    expect(released.active).toBe(0)
    expect(harness.error(boundary)).toBe(false)
    expect(harness.error(boundary)).toBeNull()
  })

  it('releasing a boundary that was never forced is a no-op (no reset re-render)', () => {
    const harness = fakeRenderer()
    const boundary = boundaryFiber()
    const before = harness.scheduled.length
    applyErrorOverride(boundary, false, harness.renderer)
    expect(harness.scheduled.length).toBe(before)
    expect(harness.error(boundary)).toBeNull()
  })
})

describe('applyHookStateOverride', () => {
  const stateHook = (value: unknown, next: unknown = null) => ({
    memoizedState: value,
    queue: { dispatch: () => {} },
    next,
  })
  const effectHook = (next: unknown = null) => ({
    memoizedState: { create: () => {}, deps: [] },
    queue: null,
    next,
  })

  it('validates the component kind, hook index, and hook kind', () => {
    const { renderer } = fakeRenderer()
    const classFiber = fiber({ tag: ClassComponentTag, type: function Classy() {} })
    expect(() => applyHookStateOverride(classFiber, 0, [], 1, renderer)).toThrow(/class component/)

    const hookless = fiber()
    expect(() => applyHookStateOverride(hookless, 0, [], 1, renderer)).toThrow(/has no hooks/)

    const oneHook = fiber({ memoizedState: stateHook(0) })
    expect(() => applyHookStateOverride(oneHook, 3, [], 1, renderer)).toThrow(
      /hook 3 does not exist/,
    )

    const withEffect = fiber({ memoizedState: stateHook(0, effectHook()) })
    expect(() => applyHookStateOverride(withEffect, 1, [], 1, renderer)).toThrow(
      /not a stateful hook/,
    )
  })

  it('forwards to the renderer with a string hook id and string path', () => {
    const harness = fakeRenderer()
    const target = fiber({ memoizedState: stateHook(0, stateHook({ page: 1 })) })
    applyHookStateOverride(target, 1, ['filters', 0], 'dark', harness.renderer)
    expect(harness.hookCalls).toEqual([[target, '1', ['filters', '0'], 'dark']])
  })

  it('hookChain and isStateHook classify the memoizedState list', () => {
    const chainHead = stateHook(0, effectHook(stateHook('x')))
    const target = fiber({ memoizedState: chainHead })
    const hooks = hookChain(target)
    expect(hooks).toHaveLength(3)
    expect(hooks.map((hook) => isStateHook(hook))).toEqual([true, false, true])
  })
})

describe('overrideFiberProps / applyContextOverride', () => {
  it('applies a multi-key partial in one renderer call, merged over current props', () => {
    const harness = fakeRenderer()
    const target = fiber({ memoizedProps: { a: 1, b: 2, children: 'kids' } })
    overrideFiberProps(target, { b: 3, c: 4 }, harness.renderer)
    expect(harness.propsCalls).toEqual([[target, [], { a: 1, b: 3, c: 4, children: 'kids' }]])
  })

  it('shallow-merges a plain-object context value and replaces any other value', () => {
    const themeContext = { displayName: 'Theme' }
    const providerOf = () =>
      fiber({
        tag: CONTEXT_PROVIDER_TAG,
        type: { _context: themeContext },
        memoizedProps: { value: { theme: 'light', locale: 'en' }, children: 'kids' },
      })

    const merged = fakeRenderer()
    const provider = providerOf()
    applyContextOverride(provider, undefined, { theme: 'dark' }, merged.renderer)
    expect(merged.propsCalls).toEqual([
      [provider, [], { value: { theme: 'dark', locale: 'en' }, children: 'kids' }],
    ])

    const replaced = fakeRenderer()
    const provider2 = providerOf()
    applyContextOverride(provider2, undefined, 'dark', replaced.renderer)
    expect(replaced.propsCalls).toEqual([[provider2, [], { value: 'dark', children: 'kids' }]])
  })
})

describe('resolveContextProvider', () => {
  const themeContext = { displayName: 'Theme' }
  const localeContext = { displayName: 'Locale' }

  const consumerOf = (contexts: unknown[], parent: Fiber | null = null): Fiber => {
    let firstContext: unknown = null
    for (let i = contexts.length - 1; i >= 0; i--) {
      firstContext = { context: contexts[i], memoizedValue: null, next: firstContext }
    }
    return fiber({ type: function Consumer() {}, dependencies: { firstContext }, return: parent })
  }

  it('resolves the nearest matching provider for React ≤18 (type._context) and 19 (type is the context)', () => {
    const legacyProvider = fiber({ tag: CONTEXT_PROVIDER_TAG, type: { _context: themeContext } })
    const legacyConsumer = consumerOf([themeContext], legacyProvider)
    expect(resolveContextProvider(legacyConsumer).provider).toBe(legacyProvider)
    expect(resolveContextProvider(legacyConsumer).contextName).toBe('Theme')

    const modernProvider = fiber({ tag: CONTEXT_PROVIDER_TAG, type: themeContext })
    const modernConsumer = consumerOf([themeContext], modernProvider)
    expect(resolveContextProvider(modernConsumer).provider).toBe(modernProvider)
  })

  it('uses a provider fiber directly when one is passed', () => {
    const provider = fiber({ tag: CONTEXT_PROVIDER_TAG, type: { _context: localeContext } })
    const match = resolveContextProvider(provider)
    expect(match.provider).toBe(provider)
    expect(match.contextName).toBe('Locale')
  })

  it('demands a context name when several are consumed, and validates it', () => {
    const provider = fiber({ tag: CONTEXT_PROVIDER_TAG, type: { _context: localeContext } })
    const consumer = consumerOf([themeContext, localeContext], provider)
    expect(() => resolveContextProvider(consumer)).toThrow(/pass `context` to pick one/)
    expect(() => resolveContextProvider(consumer, 'Nope')).toThrow(/does not consume a context/)
    expect(resolveContextProvider(consumer, 'Locale').provider).toBe(provider)
  })

  it('explains default-value contexts and context-free components', () => {
    expect(() => resolveContextProvider(consumerOf([themeContext]))).toThrow(
      /running on its default value/,
    )
    expect(() => resolveContextProvider(fiber({ type: function Bare() {} }))).toThrow(
      /consumes no contexts/,
    )
  })
})
