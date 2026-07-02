import { useEffect } from "react"
import { EventClient } from "@tanstack/devtools-event-client"

interface MetricsEventMap {
  mounted: { accepts: Array<string> }
  tick: { count: number }
  "request-reset": undefined
  "reset-done": { previousCount: number }
}

class MetricsDevtoolsClient extends EventClient<MetricsEventMap> {
  constructor() {
    super({ pluginId: "metrics-devtools" })
  }
}

export const metricsDevtoolsClient = new MetricsDevtoolsClient()

const TICK_INTERVAL_MS = 2000

export function useMetricsDevtools(): void {
  useEffect(() => {
    metricsDevtoolsClient.emit("mounted", { accepts: ["request-reset"] })
    let count = 0
    const interval = setInterval(() => {
      count += 1
      metricsDevtoolsClient.emit("tick", { count })
    }, TICK_INTERVAL_MS)
    const unsubscribe = metricsDevtoolsClient.on("request-reset", () => {
      const previousCount = count
      count = 0
      metricsDevtoolsClient.emit("reset-done", { previousCount })
    })
    return () => {
      clearInterval(interval)
      unsubscribe()
    }
  }, [])
}
