/** Undefined means lookup failed; null means the own property is absent. */
export function safeOwnPropertyDescriptor(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | null | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key) ?? null
  } catch {
    return undefined
  }
}

export function isDataDescriptor(
  descriptor: PropertyDescriptor | null | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && descriptor !== null && Object.hasOwn(descriptor, 'value')
}
