'use client'

import { queryCollector } from 'genie-react/collectors/query'
import { registerGenieCollector } from 'genie-react/protocol'
import { useEffect } from 'react'
import { queryClient } from './query-demo/query-client'

export function GenieQueryTools() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return

    return registerGenieCollector(queryCollector(queryClient))
  }, [])

  return null
}
