import { Component, Suspense, createContext, useContext, useRef, useState } from "react"
import type { ReactNode } from "react"
import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/lab")({ component: LabPage })

const ThemeContext = createContext("light")
ThemeContext.displayName = "ThemeContext"

interface LabErrorBoundaryState {
  hasError: boolean
}

class LabErrorBoundary extends Component<{ children: ReactNode }, LabErrorBoundaryState> {
  state: LabErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): LabErrorBoundaryState {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) return <p data-testid="lab-error">lab-error</p>
    return this.props.children
  }
}

function Counter() {
  const [count, setCount] = useState(0)
  const clicksRef = useRef(0)

  return (
    <p data-testid="lab-counter">
      count:{count}
      <button
        type="button"
        onClick={() => {
          clicksRef.current += 1
          setCount((value) => value + 1)
        }}
      >
        increment
      </button>
    </p>
  )
}

function ThemeLabel() {
  const theme = useContext(ThemeContext)
  return <p data-testid="lab-theme">theme:{theme}</p>
}

function SuspenseContent() {
  return <p data-testid="lab-suspense">lab-content</p>
}

function LabPage() {
  return (
    <div className="flex min-h-svh flex-col gap-2 p-6 text-sm leading-loose">
      <h1 className="font-medium">Lab</h1>
      <ThemeContext.Provider value="light">
        <LabErrorBoundary>
          <Suspense fallback={<p data-testid="lab-fallback">lab-loading</p>}>
            <SuspenseContent />
          </Suspense>
          <Counter />
          <ThemeLabel />
        </LabErrorBoundary>
      </ThemeContext.Provider>
    </div>
  )
}
