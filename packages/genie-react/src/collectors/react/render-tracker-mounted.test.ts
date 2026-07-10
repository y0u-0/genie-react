// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react'
import { type Fiber, getFiberFromHostInstance, getLatestFiber } from 'bippy'
import { createElement, useMemo, useReducer, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nearestCompositeFiber } from './fiber'
import { clearRenders, getRenders, recordRender } from './render-tracker'

vi.mock('bippy/source', () => ({
  getSource: async () => null,
  isSourceFile: (file: string) => !file.includes('/node_modules/'),
  normalizeFileName: (file: string) => file,
  getFiberHooks: () => [],
  symbolicateStack: async (frames: unknown[]) => frames,
}))

const asFiber = (shape: unknown): Fiber => shape as Fiber

function Counter(): ReturnType<typeof createElement> {
  const [enabled, setEnabled] = useState(false)
  const label = useMemo(() => (enabled ? 'on' : 'off'), [enabled])
  const [count, increment] = useReducer((value: number) => value + 1, 0)

  return createElement(
    'button',
    {
      type: 'button',
      'data-testid': 'counter',
      onClick: () => {
        setEnabled(true)
        increment()
      },
    },
    `${label}:${count}`,
  )
}

beforeEach(() => clearRenders())

describe('render provenance against a live React tree', () => {
  it('reports only changed stateful hooks with their real flat and stateful positions', async () => {
    const view = render(createElement(Counter))
    const button = view.getByTestId('counter')

    fireEvent.click(button)
    expect(button.textContent).toBe('on:1')

    const host = getFiberFromHostInstance(button)
    const owner = host ? nearestCompositeFiber(getLatestFiber(host)) : null
    expect(owner).not.toBeNull()
    recordRender(asFiber(owner), 'update')

    const report = (await getRenders({ sort: 'renders', limit: 10 })).find(
      (component) => component.name === 'Counter',
    )
    expect(report?.changes).toEqual([
      {
        name: 'state[0]',
        kind: 'state',
        unstable: false,
        hook: { index: 0, stateIndex: 0, kind: 'state' },
        before: false,
        after: true,
      },
      {
        name: 'reducer[1]',
        kind: 'state',
        unstable: false,
        hook: { index: 2, stateIndex: 1, kind: 'reducer' },
        before: 0,
        after: 1,
      },
    ])
  })
})
