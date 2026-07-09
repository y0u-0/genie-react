import {
  Component,
  createContext,
  lazy,
  memo,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import heroImg from './assets/hero.png'
import './App.css'

interface ThemeValue {
  label: string
  accent: string
}

const ThemeContext = createContext<ThemeValue>({ label: 'default', accent: '#646cff' })
ThemeContext.displayName = 'ThemeContext'

const MemoChild = memo(function MemoChild({ badge }: { badge: { text: string } }): ReactNode {
  return <p className="lab-line">memo child badge: {badge.text}</p>
})

function ThemeReadout(): ReactNode {
  const theme = useContext(ThemeContext)
  return (
    <p className="lab-line">
      theme label: <strong>{theme.label}</strong> · accent {theme.accent}
    </p>
  )
}

function HotEffectProbe({ count }: { count: number }): ReactNode {
  const runs = useRef(0)
  const marker = { count }
  useEffect(() => {
    runs.current += 1
  }, [marker])
  return <p className="lab-line">hot effect runs: {runs.current}</p>
}

function Unmountable(): ReactNode {
  return <p className="lab-line">unmountable is mounted</p>
}

function Bomb({ armed }: { armed: boolean }): ReactNode {
  if (armed) throw new Error('Bomb detonated')
  return <p className="lab-line">bomb is stable</p>
}

class LabErrorBoundary extends Component<
  { onReset: () => void; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  private readonly reset = (): void => {
    this.setState({ error: null })
    this.props.onReset()
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="lab-boundary">
          <p>boundary caught: {this.state.error.message}</p>
          <button type="button" onClick={this.reset}>
            reset boundary
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function LoadedSlowChild(): ReactNode {
  return <p className="lab-line">slow child loaded</p>
}

const SlowChild = lazy(
  () =>
    new Promise<{ default: ComponentType }>((resolve) => {
      setTimeout(() => resolve({ default: LoadedSlowChild }), 1500)
    }),
)

function StressLabel({ text }: { text: string }): ReactNode {
  return <span className="lab-line">{text}</span>
}

function StressCell({ index }: { index: number }): ReactNode {
  return <StressLabel text={`cell ${index}`} />
}

function StressRow({ index }: { index: number }): ReactNode {
  return (
    <div>
      <StressCell index={index} />
    </div>
  )
}

/** Perf fixture: `?rows=N` renders N Row→Cell→Label chains (~6 fibers each) so tools can be exercised against arbitrary tree sizes; absent by default. */
function StressGrid(): ReactNode {
  const rows = Number(new URLSearchParams(window.location.search).get('rows') ?? '0')
  if (!Number.isFinite(rows) || rows <= 0) return null
  return (
    <section id="stress">
      {Array.from({ length: rows }, (_, index) => (
        <StressRow key={index} index={index} />
      ))}
    </section>
  )
}

function App(): ReactNode {
  const [count, setCount] = useState(0)
  const [armed, setArmed] = useState(false)
  const [showUnmountable, setShowUnmountable] = useState(true)
  const [themeLabel, setThemeLabel] = useState('lab')

  const themeValue: ThemeValue = { label: themeLabel, accent: '#646cff' }

  const greeting = useQuery({
    queryKey: ['greeting'],
    queryFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { message: 'hello from query', at: new Date().toISOString() }
    },
  })

  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (next: string) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return next
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['greeting'], { message: data, at: new Date().toISOString() })
    },
  })

  return (
    <ThemeContext.Provider value={themeValue}>
      <section id="center">
        <div className="hero">
          <img src={heroImg} className="base" width="170" height="179" alt="" />
          <img src={reactLogo} className="framework" alt="React logo" />
          <img src={viteLogo} className="vite" alt="Vite logo" />
        </div>
        <div>
          <h1>Get started</h1>
          <p>
            Edit <code>src/App.tsx</code> and save to test <code>HMR</code>
          </p>
        </div>
        <button
          type="button"
          className="counter"
          onClick={() => setCount((current) => current + 1)}
        >
          Count is {count}
        </button>
      </section>

      <div className="ticks"></div>

      <section id="lab">
        <h2>Genie lab</h2>
        <MemoChild badge={{ text: 'lab' }} />
        <HotEffectProbe count={count} />
        <ThemeReadout />
        <button
          type="button"
          onClick={() => setThemeLabel((label) => (label === 'lab' ? 'dark' : 'lab'))}
        >
          toggle theme label
        </button>

        <p className="lab-line">
          query:{' '}
          {greeting.isPending ? 'loading…' : greeting.isError ? 'error' : greeting.data?.message}
        </p>
        <p className="lab-line">
          mutation: {mutation.isPending ? 'running…' : (mutation.data ?? 'idle')}
        </p>
        <button type="button" onClick={() => mutation.mutate('mutated greeting')}>
          run mutation
        </button>

        <LabErrorBoundary onReset={() => setArmed(false)}>
          <Bomb armed={armed} />
        </LabErrorBoundary>
        <button type="button" onClick={() => setArmed(true)}>
          throw in bomb
        </button>

        <Suspense fallback={<p className="lab-line">loading slow child…</p>}>
          <SlowChild />
        </Suspense>

        <button type="button" onClick={() => setShowUnmountable((shown) => !shown)}>
          toggle unmountable
        </button>
        {showUnmountable && <Unmountable />}
      </section>

      <div className="ticks"></div>
      <StressGrid />
      <section id="spacer"></section>
    </ThemeContext.Provider>
  )
}

export default App
