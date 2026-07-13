'use client'

import { Genie } from 'genie-react'
import { queryClient } from './query-demo/query-client'

export function GenieManual() {
  return process.env.NODE_ENV === 'production' ? null : <Genie queryClient={queryClient} />
}
