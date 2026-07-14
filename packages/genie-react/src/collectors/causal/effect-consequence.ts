export interface EffectConsequenceSignal {
  effectEventId: string
  domain: 'query-notification' | 'router-notification'
  notificationId: string
  timestamp: number
}

let activeEffectEventId: string | null = null
let listener: ((signal: EffectConsequenceSignal) => void) | null = null

export function runInEffectContext<T>(effectEventId: string, operation: () => T): T {
  const previous = activeEffectEventId
  activeEffectEventId = effectEventId
  try {
    return operation()
  } finally {
    activeEffectEventId = previous
  }
}

export function publishEffectConsequence(
  domain: EffectConsequenceSignal['domain'],
  notificationId: string,
): void {
  if (!activeEffectEventId) return
  listener?.({
    effectEventId: activeEffectEventId,
    domain,
    notificationId,
    timestamp: Date.now(),
  })
}

export function setEffectConsequenceListener(
  next: ((signal: EffectConsequenceSignal) => void) | null,
): void {
  listener = next
}
