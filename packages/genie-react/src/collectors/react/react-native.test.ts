// @vitest-environment jsdom

import {
  type Fiber,
  type FiberRoot,
  FunctionComponentTag,
  HostComponentTag,
  HostRootTag,
} from 'bippy'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeNativeHostFiber,
  domForFiber,
  findRootFiber,
  forgetCommittedRoots,
  noteCommittedRoot,
} from './fiber'

afterEach(() => {
  document.body.innerHTML = ''
  forgetCommittedRoots()
})

// A mounted root: current has a child, the liveness signal noteCommittedRoot keys on.
const rootFiber = (): Fiber => {
  const root = { tag: HostRootTag, return: null, alternate: null, child: null } as unknown as Fiber
  ;(root as { child: unknown }).child = {
    tag: HostComponentTag,
    return: root,
    alternate: null,
    child: null,
    sibling: null,
  }
  return root
}

const emptiedRootFiber = (): Fiber =>
  ({ tag: HostRootTag, return: null, alternate: null, child: null }) as unknown as Fiber

const asRoot = (current: Fiber | null): FiberRoot => ({ current }) as unknown as FiberRoot

const nativeHost = (
  type: unknown,
  props: Record<string, unknown> = {},
  extra: Partial<Fiber> = {},
): Fiber =>
  ({
    tag: HostComponentTag,
    type,
    stateNode: { _nativeTag: 1 },
    memoizedProps: props,
    child: null,
    sibling: null,
    return: null,
    ...extra,
  }) as unknown as Fiber

const domHost = (
  tag: string,
  attrs: Record<string, string> = {},
  extra: Partial<Fiber> = {},
): Fiber =>
  ({
    tag: HostComponentTag,
    type: tag.toLowerCase(),
    stateNode: {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      classList: [],
      textContent: '',
      getAttribute: (name: string) => attrs[name] ?? null,
    },
    child: null,
    sibling: null,
    return: null,
    ...extra,
  }) as unknown as Fiber

// A composite fiber whose direct children are the given hosts (linked as a child + sibling chain, the shape bippy walks).
const componentWith = (children: Fiber[], name = 'C'): Fiber => {
  const type = (): null => null
  ;(type as { displayName?: string }).displayName = name
  const fiber = {
    tag: FunctionComponentTag,
    type,
    child: children[0] ?? null,
    sibling: null,
    return: null,
  } as unknown as Fiber
  children.forEach((child, index) => {
    ;(child as { return: Fiber }).return = fiber
    ;(child as { sibling: Fiber | null }).sibling = children[index + 1] ?? null
  })
  return fiber
}

describe('findRootFiber', () => {
  it('returns null when nothing is committed and no DOM root exists', () => {
    expect(findRootFiber()).toBeNull()
  })

  it('returns the captured root when there is no DOM to seed from', () => {
    const root = rootFiber()
    noteCommittedRoot(asRoot(root))
    expect(findRootFiber()).toBe(root)
  })

  it('climbs to the topmost fiber if the stored current is not the root', () => {
    const root = rootFiber()
    const mid = {
      tag: FunctionComponentTag,
      return: root,
      alternate: null,
      child: root.child,
    } as unknown as Fiber
    noteCommittedRoot(asRoot(mid))
    expect(findRootFiber()).toBe(root)
  })

  it('keeps the first live root when a second root commits later', () => {
    const first = rootFiber()
    const second = rootFiber()
    noteCommittedRoot(asRoot(first))
    noteCommittedRoot(asRoot(second))
    expect(findRootFiber()).toBe(first)
  })

  it('selects the largest mounted tree when several renderers share the page', () => {
    const overlay = rootFiber()
    const app = rootFiber()
    const appComponent = componentWith([domHost('main'), domHost('button')], 'App')
    ;(app as { child: Fiber }).child = appComponent
    ;(appComponent as { return: Fiber }).return = app

    noteCommittedRoot(asRoot(overlay))
    noteCommittedRoot(asRoot(app))

    expect(findRootFiber()).toBe(app)
  })

  it('follows a recommit of the same root to its new current fiber', () => {
    const root = asRoot(rootFiber())
    const after = rootFiber()
    noteCommittedRoot(root)
    ;(root as { current: Fiber }).current = after
    noteCommittedRoot(root)
    expect(findRootFiber()).toBe(after)
  })

  it('returns null after the only root unmounts (empty commit)', () => {
    const root = asRoot(rootFiber())
    noteCommittedRoot(root)
    ;(root as { current: Fiber }).current = emptiedRootFiber()
    noteCommittedRoot(root)
    expect(findRootFiber()).toBeNull()
  })

  it('falls over to the next live root when the first unmounts', () => {
    const first = asRoot(rootFiber())
    const second = rootFiber()
    noteCommittedRoot(first)
    noteCommittedRoot(asRoot(second))
    ;(first as { current: Fiber }).current = emptiedRootFiber()
    noteCommittedRoot(first)
    expect(findRootFiber()).toBe(second)
  })

  it('falls back to the captured root when the DOM has no React fiber', () => {
    const div = document.createElement('div')
    div.id = 'root'
    document.body.appendChild(div)
    const root = rootFiber()
    noteCommittedRoot(asRoot(root))
    expect(findRootFiber()).toBe(root)
  })

  it('prefers the DOM-seeded root over the captured one (web path wins)', () => {
    const domRoot = rootFiber()
    const div = document.createElement('div')
    div.id = 'root'
    ;(div as unknown as Record<string, unknown>).__reactFiber$test = domRoot
    document.body.appendChild(div)
    noteCommittedRoot(asRoot(rootFiber()))
    expect(findRootFiber()).toBe(domRoot)
  })
})

describe('describeNativeHostFiber', () => {
  it('maps type, testID, and accessibility props', () => {
    expect(
      describeNativeHostFiber(
        nativeHost('RCTView', {
          testID: 'submit',
          accessibilityLabel: 'Submit',
          accessibilityRole: 'button',
          nativeID: 'n1',
        }),
      ),
    ).toEqual({
      tag: 'RCTView',
      selector: '[testID="submit"]',
      domId: null,
      testId: 'submit',
      role: 'button',
      ariaLabel: 'Submit',
      name: 'n1',
      classes: [],
      text: null,
    })
  })

  it('falls back to the tag as the selector when there is no testID', () => {
    expect(describeNativeHostFiber(nativeHost('View', {})).selector).toBe('View')
  })

  it('reads text from string children', () => {
    expect(describeNativeHostFiber(nativeHost('RCTText', { children: 'Hello' })).text).toBe('Hello')
  })

  it('reads text from the `text` prop (RCTRawText) when children is absent', () => {
    expect(describeNativeHostFiber(nativeHost('RCTRawText', { text: 'Raw' })).text).toBe('Raw')
  })

  it('prefers children over text when both are strings', () => {
    expect(describeNativeHostFiber(nativeHost('RCTText', { children: 'A', text: 'B' })).text).toBe(
      'A',
    )
  })

  it('reads text from number children', () => {
    expect(describeNativeHostFiber(nativeHost('RCTText', { children: 42 })).text).toBe('42')
  })

  it('joins the string and number segments of interpolated children', () => {
    expect(describeNativeHostFiber(nativeHost('RCTText', { children: ['Score: ', 42] })).text).toBe(
      'Score: 42',
    )
    expect(describeNativeHostFiber(nativeHost('RCTText', { children: ['a', {}, 'b'] })).text).toBe(
      'ab',
    )
  })

  it('ignores children and text with no textual segments', () => {
    expect(describeNativeHostFiber(nativeHost('View', { children: [{}, {}] })).text).toBeNull()
    expect(describeNativeHostFiber(nativeHost('View', { children: {}, text: {} })).text).toBeNull()
  })

  it('truncates text over 80 characters', () => {
    expect(describeNativeHostFiber(nativeHost('RCTText', { children: 'x'.repeat(120) })).text).toBe(
      `${'x'.repeat(80)}…`,
    )
  })

  it('prefers RN accessibility props but accepts the web aliases (role, aria-label)', () => {
    const web = describeNativeHostFiber(nativeHost('View', { role: 'link', 'aria-label': 'Home' }))
    expect(web.role).toBe('link')
    expect(web.ariaLabel).toBe('Home')
    const rn = describeNativeHostFiber(
      nativeHost('View', {
        accessibilityRole: 'button',
        role: 'link',
        accessibilityLabel: 'RN',
        'aria-label': 'web',
      }),
    )
    expect(rn.role).toBe('button')
    expect(rn.ariaLabel).toBe('RN')
  })

  it('normalizes empty / whitespace props to null and drops the testID selector', () => {
    const info = describeNativeHostFiber(
      nativeHost('View', {
        testID: '   ',
        accessibilityLabel: '',
        nativeID: '  ',
        accessibilityRole: '',
      }),
    )
    expect(info.testId).toBeNull()
    expect(info.ariaLabel).toBeNull()
    expect(info.name).toBeNull()
    expect(info.role).toBeNull()
    expect(info.selector).toBe('View')
  })

  it('trims surrounding whitespace on kept values', () => {
    const info = describeNativeHostFiber(
      nativeHost('View', { testID: '  go  ', children: '  hi  ' }),
    )
    expect(info.testId).toBe('go')
    expect(info.selector).toBe('[testID="go"]')
    expect(info.text).toBe('hi')
  })

  it('escapes quotes in the testID selector', () => {
    expect(describeNativeHostFiber(nativeHost('View', { testID: 'a"b' })).selector).toBe(
      '[testID="a\\"b"]',
    )
  })

  it('tolerates a missing memoizedProps object', () => {
    const info = describeNativeHostFiber({
      tag: HostComponentTag,
      type: 'View',
      stateNode: {},
    } as unknown as Fiber)
    expect(info.tag).toBe('View')
    expect(info.testId).toBeNull()
    expect(info.text).toBeNull()
  })

  it('uses "host" as the tag when the fiber type is not a string', () => {
    expect(describeNativeHostFiber(nativeHost(() => null, {})).tag).toBe('host')
    expect(describeNativeHostFiber(nativeHost(Symbol('x'), {})).tag).toBe('host')
  })

  it('always reports domId null and classes empty (no DOM in RN)', () => {
    const info = describeNativeHostFiber(nativeHost('View', { testID: 'x' }))
    expect(info.domId).toBeNull()
    expect(info.classes).toEqual([])
  })
})

describe('domForFiber', () => {
  it('describes a native host (React Native)', () => {
    const result = domForFiber(componentWith([nativeHost('RCTView', { testID: 'card' })]), {
      limit: 5,
    })
    expect(result.total).toBe(1)
    expect(result.elements[0]).toMatchObject({ tag: 'RCTView', selector: '[testID="card"]' })
  })

  it('describes a DOM element host (web path unchanged)', () => {
    const result = domForFiber(componentWith([domHost('button', { id: 'go' })]), { limit: 5 })
    expect(result.total).toBe(1)
    expect(result.elements[0]?.tag).toBe('button')
    expect(result.elements[0]?.selector).toBe('#go')
  })

  it('skips a host with a null stateNode (detached / pre-mount)', () => {
    const host = nativeHost('View', {}, { stateNode: null as unknown as object })
    expect(domForFiber(componentWith([host]), { limit: 5 }).total).toBe(0)
  })

  it('skips a host whose stateNode is a primitive', () => {
    const host = nativeHost('View', {}, { stateNode: 5 as unknown as object })
    expect(domForFiber(componentWith([host]), { limit: 5 }).total).toBe(0)
  })

  it('counts every describable host in total but caps elements at the limit', () => {
    const hosts = [
      nativeHost('V1', { testID: 'a' }),
      nativeHost('V2', { testID: 'b' }),
      nativeHost('V3', { testID: 'c' }),
    ]
    const result = domForFiber(componentWith(hosts), { limit: 2 })
    expect(result.total).toBe(3)
    expect(result.elements).toHaveLength(2)
  })

  it('mixes DOM and native hosts and skips non-host state nodes', () => {
    const hosts = [
      domHost('div', { 'data-testid': 'd' }),
      nativeHost('RCTText', { children: 'hi' }),
      nativeHost('View', {}, { stateNode: null as unknown as object }),
    ]
    const result = domForFiber(componentWith(hosts), { limit: 10 })
    expect(result.total).toBe(2)
    expect(result.elements.map((element) => element.tag)).toEqual(['div', 'RCTText'])
  })

  it('returns an empty result for a component with no hosts', () => {
    const result = domForFiber(componentWith([]), { limit: 5 })
    expect(result.total).toBe(0)
    expect(result.elements).toEqual([])
  })

  it('includes the component id and name', () => {
    const result = domForFiber(componentWith([nativeHost('View', {})], 'Card'), { limit: 5 })
    expect(result.name).toBe('Card')
    expect(typeof result.id).toBe('number')
  })
})
