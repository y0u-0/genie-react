import { type Fiber, FunctionComponentTag, HostComponentTag } from 'bippy'
import { describe, expect, it } from 'vitest'
import { contextsForFiber, describeHostElement, nearestCompositeFiber } from './fiber'

const fakeElement = (opts: {
  tag: string
  attrs?: Record<string, string>
  classes?: string[]
  text?: string
}): Element => {
  const attrs = opts.attrs ?? {}
  return {
    tagName: opts.tag.toUpperCase(),
    nodeType: 1,
    classList: opts.classes ?? [],
    textContent: opts.text ?? '',
    getAttribute: (name: string) => attrs[name] ?? null,
  } as unknown as Element
}

describe('nearestCompositeFiber', () => {
  const composite = {
    tag: FunctionComponentTag,
    type: () => null,
    return: null,
  } as unknown as Fiber

  it('walks host fibers up to the owning component', () => {
    const host = { tag: HostComponentTag, type: 'button', return: composite } as unknown as Fiber
    expect(nearestCompositeFiber(host)).toBe(composite)
  })

  it('returns a composite fiber unchanged', () => {
    expect(nearestCompositeFiber(composite)).toBe(composite)
  })

  it('returns null when the chain is host-only', () => {
    const host = { tag: HostComponentTag, type: 'div', return: null } as unknown as Fiber
    expect(nearestCompositeFiber(host)).toBeNull()
  })
})

describe('describeHostElement', () => {
  it('prefers #id, then [data-testid], then tag + simple classes', () => {
    expect(describeHostElement(fakeElement({ tag: 'div', attrs: { id: 'root' } })).selector).toBe(
      '#root',
    )
    expect(
      describeHostElement(fakeElement({ tag: 'button', attrs: { 'data-testid': 'submit' } }))
        .selector,
    ).toBe('[data-testid="submit"]')
    expect(
      describeHostElement(fakeElement({ tag: 'span', classes: ['badge', 'badge-lg'] })).selector,
    ).toBe('span.badge.badge-lg')
  })

  it('drops utility-framework classes from the selector but keeps them in classes', () => {
    const info = describeHostElement(
      fakeElement({ tag: 'div', classes: ['hover:bg-red', 'md:flex', 'card'] }),
    )
    expect(info.selector).toBe('div.card')
    expect(info.classes).toEqual(['hover:bg-red', 'md:flex', 'card'])
  })

  it('falls back to the bare tag when every class is a non-selectable utility token', () => {
    expect(
      describeHostElement(fakeElement({ tag: 'section', classes: ['md:flex', 'hover:bg-red'] }))
        .selector,
    ).toBe('section')
  })

  it('extracts role / aria-label / name and truncates text', () => {
    const info = describeHostElement(
      fakeElement({
        tag: 'input',
        attrs: { role: 'searchbox', 'aria-label': 'Search', name: 'q' },
        text: 'x'.repeat(120),
      }),
    )
    expect(info.role).toBe('searchbox')
    expect(info.ariaLabel).toBe('Search')
    expect(info.name).toBe('q')
    expect(info.text).toBe(`${'x'.repeat(80)}…`)
  })

  it('normalizes empty/whitespace attributes and text to null', () => {
    const info = describeHostElement(fakeElement({ tag: 'div', attrs: { id: '  ' }, text: '   ' }))
    expect(info.domId).toBeNull()
    expect(info.text).toBeNull()
    expect(info.selector).toBe('div')
  })
})

const fiberWithContexts = (
  entries: Array<{ name?: string; value: unknown }>,
  displayName = 'Consumer',
): Fiber => {
  let head: unknown = null
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    head = {
      context: entry?.name ? { displayName: entry.name } : {},
      memoizedValue: entry?.value,
      next: head,
    }
  }
  const type = (): null => null
  ;(type as { displayName?: string }).displayName = displayName
  return {
    tag: 0,
    type,
    dependencies: head ? { firstContext: head } : undefined,
  } as unknown as Fiber
}

describe('contextsForFiber', () => {
  it('reads each consumed context in order with its provided value', () => {
    const result = contextsForFiber(
      fiberWithContexts([
        { name: 'ThemeContext', value: { mode: 'dark' } },
        { name: 'AuthContext', value: { user: 'ali' } },
      ]),
      { depth: 2 },
    )
    expect(result.name).toBe('Consumer')
    expect(result.contexts).toEqual([
      { name: 'ThemeContext', value: { mode: 'dark' } },
      { name: 'AuthContext', value: { user: 'ali' } },
    ])
  })

  it('labels an unnamed context "Context"', () => {
    const result = contextsForFiber(fiberWithContexts([{ value: 1 }]), { depth: 2 })
    expect(result.contexts[0]?.name).toBe('Context')
  })

  it('returns an empty list when the component consumes no context', () => {
    expect(contextsForFiber(fiberWithContexts([]), { depth: 2 }).contexts).toEqual([])
  })

  it('depth-bounds context values (deep nodes become dehydrated placeholders)', () => {
    const result = contextsForFiber(
      fiberWithContexts([{ name: 'Deep', value: { a: { b: { c: 1 } } } }]),
      { depth: 1 },
    )
    const value = result.contexts[0]?.value as { a: unknown }
    expect(value.a).not.toEqual({ b: { c: 1 } })
  })
})
