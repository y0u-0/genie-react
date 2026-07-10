import type { Fiber } from 'bippy'
import { bench, describe } from 'vitest'
import { diffStateChanges, stateChanged } from './render-tracker'

interface HookNode {
  memoizedState: unknown
  queue: { dispatch: () => void; lastRenderedReducer: () => void }
  next: HookNode | null
}

function basicStateReducer(): void {}

function chain(values: unknown[]): HookNode | null {
  let head: HookNode | null = null
  for (let index = values.length - 1; index >= 0; index -= 1) {
    head = {
      memoizedState: values[index],
      queue: { dispatch: () => {}, lastRenderedReducer: basicStateReducer },
      next: head,
    }
  }
  return head
}

function fiber(after: unknown[], before: unknown[]): Fiber {
  return {
    tag: 0,
    memoizedState: chain(after),
    alternate: { memoizedState: chain(before) },
  } as unknown as Fiber
}

const unchanged20 = fiber(
  Array.from({ length: 20 }, (_, index) => index),
  Array.from({ length: 20 }, (_, index) => index),
)
const oneChange20 = fiber(
  Array.from({ length: 20 }, (_, index) => (index === 10 ? 99 : index)),
  Array.from({ length: 20 }, (_, index) => index),
)
const boundedObjectChange = fiber(
  [{ items: Array.from({ length: 100 }, (_, index) => ({ id: index, selected: index === 50 })) }],
  [{ items: Array.from({ length: 100 }, (_, index) => ({ id: index, selected: false })) }],
)

describe('commit-path state diff', () => {
  bench('previous boolean scan — 20 unchanged hooks', () => {
    stateChanged(unchanged20)
  })

  bench('detailed scan — 20 unchanged hooks', () => {
    diffStateChanges(unchanged20)
  })

  bench('detailed scan — one primitive change among 20 hooks', () => {
    diffStateChanges(oneChange20)
  })

  bench('detailed scan — bounded 100-item object change', () => {
    diffStateChanges(boundedObjectChange)
  })
})
