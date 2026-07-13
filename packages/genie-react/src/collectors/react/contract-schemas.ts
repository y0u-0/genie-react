import { z } from 'zod'

export const sourceSchema = z
  .object({
    file: z.string(),
    line: z.number().nullable(),
    column: z.number().nullable(),
    functionName: z.string().nullable(),
  })
  .nullable()
