import { useMutation, useQuery } from "@tanstack/react-query"
import { Link, createFileRoute } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"

export const Route = createFileRoute("/")({ component: App })

interface Greeting {
  message: string
  at: number
}

async function fetchGreeting(): Promise<Greeting> {
  await new Promise((resolve) => setTimeout(resolve, 600))
  return { message: "Hello from TanStack Query", at: Date.now() }
}

function App() {
  const greeting = useQuery({ queryKey: ["demo", "greeting"], queryFn: fetchGreeting })
  const echo = useMutation({
    mutationKey: ["demo", "echo"],
    mutationFn: async (text: string) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return text.toUpperCase()
    },
  })

  return (
    <div className="flex min-h-svh p-6">
      <div className="flex max-w-md min-w-0 flex-col gap-4 text-sm leading-loose">
        <div>
          <h1 className="font-medium">Genie Demo</h1>
          <p>
            Query <code>["demo","greeting"]</code>: <strong>{greeting.status}</strong> (
            {greeting.fetchStatus})
          </p>
          <p role={greeting.isError ? "alert" : undefined}>
            {greeting.isError
              ? `Error: ${greeting.error.message}`
              : greeting.data
                ? greeting.data.message
                : "loading…"}
          </p>
          {echo.data ? <p>Mutation result: {echo.data}</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={() => greeting.refetch()}>Refetch</Button>
            <Button onClick={() => echo.mutate("hi")}>Mutate</Button>
            <Link to="/about" className="inline-flex items-center underline">
              About →
            </Link>
            <Link to="/dashboard" className="inline-flex items-center underline">
              Dashboard →
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
