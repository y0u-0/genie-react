import type { Fiber } from 'bippy'
import { describe, expect, it } from 'vitest'
import { createRenderEvidenceBudget, inputCoverage } from './render-budget'
import { childrenChanged, diffProps } from './render-inputs'

const asFiber = (shape: unknown): Fiber => shape as Fiber

describe('render input safety', () => {
  it('never invokes accessor props and discloses incomplete coverage', () => {
    let reads = 0
    const props = (label: string): Record<string, unknown> => {
      const value = { safe: label }
      Object.defineProperty(value, 'computed', {
        enumerable: true,
        get: () => {
          reads += 1
          return label
        },
      })
      return value
    }
    const evidence = createRenderEvidenceBudget()
    const changes = diffProps(
      asFiber({
        memoizedProps: props('after'),
        alternate: { memoizedProps: props('before') },
      }),
      evidence,
    )

    expect(changes).toEqual([])
    expect(reads).toBe(0)
    expect(inputCoverage(evidence)).toMatchObject({
      complete: false,
      scanTruncated: false,
      propsNotEnumerated: true,
    })
  })

  it('never asks an app Proxy for arbitrary prop keys', () => {
    let ownKeyScans = 0
    const props = (value: number): object =>
      new Proxy(
        { value },
        {
          ownKeys(target) {
            ownKeyScans += 1
            return Reflect.ownKeys(target)
          },
        },
      )
    const evidence = createRenderEvidenceBudget()

    expect(
      diffProps(
        asFiber({ memoizedProps: props(2), alternate: { memoizedProps: props(1) } }),
        evidence,
      ),
    ).toEqual([])
    expect(ownKeyScans).toBe(0)
    expect(inputCoverage(evidence)).toMatchObject({
      complete: false,
      scanTruncated: false,
      propsNotEnumerated: true,
    })
  })

  it('never reads an accessor-backed children prop', () => {
    let reads = 0
    const props = Object.defineProperty({}, 'children', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'child'
      },
    })
    const evidence = createRenderEvidenceBudget()

    expect(
      childrenChanged(
        asFiber({ memoizedProps: props, alternate: { memoizedProps: props } }),
        evidence,
      ),
    ).toBe(false)
    expect(reads).toBe(0)
    expect(inputCoverage(evidence)).toMatchObject({ complete: false, scanTruncated: true })
  })
})
