import { describe, expect, it } from 'vitest'
import {
  CHECKOUT_INCIDENTS,
  INITIAL_CHECKOUT_STATE,
  checkoutDiagnosisSchema,
  diagnoseCheckout,
  incidentStep,
  nextCheckoutStep,
  normalizeCoupon,
  previousCheckoutStep,
} from './checkout-model'

describe('checkout model', () => {
  it('reports a healthy initial checkout with exact pricing', () => {
    const diagnosis = diagnoseCheckout(INITIAL_CHECKOUT_STATE)

    expect(checkoutDiagnosisSchema.parse(diagnosis)).toEqual(diagnosis)
    expect(diagnosis).toMatchObject({
      health: 'healthy',
      step: 'cart',
      canAdvance: true,
      pricing: { subtotal: 159, discount: 0, shipping: 0, total: 159 },
    })
  })

  it.each(CHECKOUT_INCIDENTS.filter((incident) => incident !== 'healthy'))(
    'turns %s into an actionable blocker',
    (incident) => {
      const diagnosis = diagnoseCheckout({
        ...INITIAL_CHECKOUT_STATE,
        step: incidentStep(incident),
        incident,
      })

      expect(checkoutDiagnosisSchema.parse(diagnosis)).toEqual(diagnosis)
      expect(diagnosis.health).toBe('blocked')
      expect(diagnosis.canAdvance).toBe(false)
      expect(diagnosis.blockingIssues).toHaveLength(1)
      expect(diagnosis.recommendedAction).toContain('app_checkout_recover')
    },
  )

  it('normalizes known coupons without accepting unknown values', () => {
    expect(normalizeCoupon(' save25 ')).toBe('SAVE25')
    expect(normalizeCoupon('not-a-coupon')).toBeNull()
  })

  it('clamps step navigation at both ends', () => {
    expect(previousCheckoutStep('cart')).toBe('cart')
    expect(nextCheckoutStep('done')).toBe('done')
    expect(nextCheckoutStep('payment')).toBe('review')
  })
})
