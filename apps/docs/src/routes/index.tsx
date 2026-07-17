import { createFileRoute, Link } from '@tanstack/react-router'
import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { baseOptions } from '@/lib/layout.shared'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-20 sm:py-28">
        <p className="mb-4 font-mono text-sm text-fd-muted-foreground">
          Live app evidence for agents
        </p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">
          See what React did. Find the cause. Check the result.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-fd-muted-foreground">
          Pair Genie with agent-browser or agent-device. The agent drives the UI, reads the live
          React and TanStack state, then checks the change against live evidence.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            to="/docs/$"
            params={{ _splat: '' }}
            className="rounded-lg bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground"
          >
            Read the docs
          </Link>
          <a
            href="https://github.com/Genie-sa/genie-react"
            className="rounded-lg border px-4 py-2.5 text-sm font-medium"
          >
            View on GitHub
          </a>
        </div>
        <div className="mt-14 grid gap-px overflow-hidden rounded-xl border bg-fd-border sm:grid-cols-3">
          <Link
            to="/docs/$"
            params={{ _splat: 'case-studies/verify-ui-states' }}
            className="bg-fd-background p-5 transition-colors hover:bg-fd-accent"
          >
            <h2 className="font-medium">Test hard-to-reach states</h2>
            <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
              Read props, hooks, and Context. Force rare states, verify the UI, and save
              screenshots.
            </p>
          </Link>
          <Link
            to="/docs/$"
            params={{ _splat: 'case-studies/render-and-effect' }}
            className="bg-fd-background p-5 transition-colors hover:bg-fd-accent"
          >
            <h2 className="font-medium">Trace the observed cause</h2>
            <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
              Join one action to its hook change, render, effect, source, and coverage.
            </p>
          </Link>
          <Link
            to="/docs/$"
            params={{ _splat: 'case-studies/prove-an-optimization' }}
            className="bg-fd-background p-5 transition-colors hover:bg-fd-accent"
          >
            <h2 className="font-medium">Check the result</h2>
            <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
              Compare repeated runs and let the UI driver confirm behavior still works.
            </p>
          </Link>
        </div>
      </main>
    </HomeLayout>
  )
}
