import { z } from 'zod'

export const sourceSchema = z
  .object({
    file: z.string(),
    line: z.number().nullable(),
    column: z.number().nullable(),
    functionName: z.string().nullable(),
    sourceMapConfidence: z.enum(['mapped', 'served']).optional(),
  })
  .nullable()

export const sourceProvenanceSchema = z.object({
  definitionSource: sourceSchema,
  allocationCallsite: sourceSchema,
  hookDefinitionOwner: sourceSchema,
  hookCallsite: sourceSchema,
  package: z.string().nullable(),
  sourceMapConfidence: z.enum(['mapped', 'served', 'unknown']),
  failureReason: z
    .enum([
      'source-unresolved',
      'definition-and-allocation-not-distinguished',
      'hook-provenance-unavailable',
    ])
    .nullable(),
  usageOrDefinitionFallback: sourceSchema,
})

export const wrapperFrameSchema = z.object({
  kind: z.enum(['memo', 'forward-ref', 'lazy', 'compiler-memo-cache', 'wrapper']),
  name: z.string(),
})
