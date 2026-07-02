declare const brand: unique symbol

/** Nominal brand: assignable to `T` but not from it; the key is phantom, so values stay plain `T` at runtime (wire-safe). */
export type Brand<T, K extends string> = T & { readonly [brand]: K }
