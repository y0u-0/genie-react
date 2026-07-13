import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollectorContext, GenieCollector } from '../../client'
import { hasDomLookupRuntime, reactCollector } from './collector'
import { isTracking, startRenderTracking } from './render-tracker'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalElement = Object.getOwnPropertyDescriptor(globalThis, 'Element')

function setGlobalProperty(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
  })
}

const collectorContext: CollectorContext = {
  pushSnapshot() {},
  pushEvent() {},
  refreshTools() {},
  markActivity() {},
}

function call<T>(collector: GenieCollector, name: string, args: unknown): T {
  const tool = collector.tools?.find((entry) => entry.contract.name === name)
  if (!tool) throw new Error(`tool not found: ${name}`)
  return tool.handler(args as never, collectorContext) as T
}

describe('hasDomLookupRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (originalElement) Object.defineProperty(globalThis, 'Element', originalElement)
    else Reflect.deleteProperty(globalThis, 'Element')
  })

  it('returns false in React Native even if document-like globals exist', () => {
    setGlobalProperty('navigator', { product: 'ReactNative' })
    setGlobalProperty('document', { body: {}, querySelectorAll: () => [] })
    setGlobalProperty('Element', function Element() {})

    expect(hasDomLookupRuntime()).toBe(false)
  })

  it('requires a real DOM selector runtime', () => {
    setGlobalProperty('navigator', { product: 'Gecko' })
    setGlobalProperty('document', { body: {}, querySelectorAll: () => [] })
    setGlobalProperty('Element', function Element() {})

    expect(hasDomLookupRuntime()).toBe(true)
  })
})

describe('render measurement lifecycle', () => {
  afterEach(() => startRenderTracking())

  it('react_clear_renders resumes tracking after react_profile_stop', () => {
    const collector = reactCollector()
    startRenderTracking()

    call(collector, 'react_profile_stop', {})
    expect(isTracking()).toBe(false)

    const result = call<{ tracking: boolean }>(collector, 'react_clear_renders', {})
    expect(result.tracking).toBe(true)
    expect(isTracking()).toBe(true)
  })
})
