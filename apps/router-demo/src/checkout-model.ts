import { z } from 'zod'

export const CHECKOUT_STEPS = ['cart', 'shipping', 'payment', 'review', 'done'] as const
export const CHECKOUT_INCIDENTS = [
  'healthy',
  'address_unverified',
  'payment_declined',
  'inventory_stale',
] as const
export const COUPON_CODES = ['SAVE10', 'SAVE25'] as const

export type CheckoutStep = (typeof CHECKOUT_STEPS)[number]
export type CheckoutIncident = (typeof CHECKOUT_INCIDENTS)[number]
export type CouponCode = (typeof COUPON_CODES)[number]

export interface CheckoutState {
  step: CheckoutStep
  coupon: CouponCode | null
  incident: CheckoutIncident
  recoveryCount: number
}

export const INITIAL_CHECKOUT_STATE: CheckoutState = {
  step: 'cart',
  coupon: null,
  incident: 'healthy',
  recoveryCount: 0,
}

export const CART_ITEMS = [
  { sku: 'KEY-75', name: 'K75 mechanical keyboard', quantity: 1, unitPrice: 129 },
  { sku: 'CAB-USB-C', name: 'Braided USB-C cable', quantity: 1, unitPrice: 30 },
] as const

const COUPON_DISCOUNTS: Record<CouponCode, number> = {
  SAVE10: 10,
  SAVE25: 25,
}

const INCIDENT_DETAILS: Record<
  Exclude<CheckoutIncident, 'healthy'>,
  {
    code: 'ADDRESS_UNVERIFIED' | 'PAYMENT_DECLINED' | 'INVENTORY_STALE'
    step: Exclude<CheckoutStep, 'review' | 'done'>
    summary: string
    hint: string
  }
> = {
  address_unverified: {
    code: 'ADDRESS_UNVERIFIED',
    step: 'shipping',
    summary: 'The shipping address needs verification before checkout can continue.',
    hint: 'Call app_checkout_recover with {"strategy":"auto"} to verify the demo address.',
  },
  payment_declined: {
    code: 'PAYMENT_DECLINED',
    step: 'payment',
    summary: 'The demo payment authorization was declined.',
    hint: 'Call app_checkout_recover with {"strategy":"auto"} to switch to the test fallback card.',
  },
  inventory_stale: {
    code: 'INVENTORY_STALE',
    step: 'cart',
    summary: 'Cart inventory is stale and must be rechecked before checkout can continue.',
    hint: 'Call app_checkout_recover with {"strategy":"auto"} to refresh inventory and totals.',
  },
}

export const checkoutIssueSchema = z
  .object({
    code: z.enum(['ADDRESS_UNVERIFIED', 'PAYMENT_DECLINED', 'INVENTORY_STALE']),
    step: z.enum(['cart', 'shipping', 'payment']),
    summary: z.string().min(1),
    hint: z.string().min(1),
  })
  .strict()

export const checkoutPricingSchema = z
  .object({
    currency: z.literal('USD'),
    subtotal: z.number().nonnegative(),
    discount: z.number().nonnegative(),
    shipping: z.number().nonnegative(),
    total: z.number().nonnegative(),
  })
  .strict()

export const checkoutDiagnosisSchema = z
  .object({
    health: z.enum(['healthy', 'blocked', 'complete']),
    step: z.enum(CHECKOUT_STEPS),
    stepNumber: z.number().int().min(1).max(CHECKOUT_STEPS.length),
    stepCount: z.literal(CHECKOUT_STEPS.length),
    canAdvance: z.boolean(),
    incident: z.enum(CHECKOUT_INCIDENTS),
    blockingIssues: z.array(checkoutIssueSchema),
    recommendedAction: z.string().nullable(),
    coupon: z.enum(COUPON_CODES).nullable(),
    pricing: checkoutPricingSchema,
    recoveryCount: z.number().int().nonnegative(),
  })
  .strict()

export const checkoutMutationOutputSchema = z
  .object({
    changed: z.boolean(),
    message: z.string().min(1),
    diagnosis: checkoutDiagnosisSchema,
  })
  .strict()

export type CheckoutDiagnosis = z.infer<typeof checkoutDiagnosisSchema>

export function normalizeCoupon(code: string): CouponCode | null {
  const normalized = code.trim().toUpperCase()
  return COUPON_CODES.find((candidate) => candidate === normalized) ?? null
}

export function incidentStep(incident: CheckoutIncident): CheckoutStep {
  return incident === 'healthy' ? 'cart' : INCIDENT_DETAILS[incident].step
}

export function diagnoseCheckout(state: CheckoutState): CheckoutDiagnosis {
  const subtotal = CART_ITEMS.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  const discount = state.coupon ? COUPON_DISCOUNTS[state.coupon] : 0
  const shipping = subtotal - discount >= 100 ? 0 : 12
  const issue = state.incident === 'healthy' ? null : INCIDENT_DETAILS[state.incident]
  const health = issue ? 'blocked' : state.step === 'done' ? 'complete' : 'healthy'

  return {
    health,
    step: state.step,
    stepNumber: CHECKOUT_STEPS.indexOf(state.step) + 1,
    stepCount: CHECKOUT_STEPS.length,
    canAdvance: health === 'healthy',
    incident: state.incident,
    blockingIssues: issue ? [{ ...issue }] : [],
    recommendedAction: issue?.hint ?? null,
    coupon: state.coupon,
    pricing: {
      currency: 'USD',
      subtotal,
      discount,
      shipping,
      total: subtotal - discount + shipping,
    },
    recoveryCount: state.recoveryCount,
  }
}

export function nextCheckoutStep(step: CheckoutStep): CheckoutStep {
  const index = CHECKOUT_STEPS.indexOf(step)
  return CHECKOUT_STEPS[Math.min(index + 1, CHECKOUT_STEPS.length - 1)] ?? 'done'
}

export function previousCheckoutStep(step: CheckoutStep): CheckoutStep {
  const index = CHECKOUT_STEPS.indexOf(step)
  return CHECKOUT_STEPS[Math.max(index - 1, 0)] ?? 'cart'
}
