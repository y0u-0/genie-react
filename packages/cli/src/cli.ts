#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { errorMessage } from 'genie-react/protocol'
import { runCall, runStatus, runTools } from './agent'
import { isRecord } from './guards'
import { runHub } from './hub-command'
import { runDoctor, runInit, runLiveDoctor } from './index'
import { runLink } from './link'

const HELP = `genie — give an AI agent live DevTools on your running React + TanStack app

Usage: npx @genie-react/cli <command> [options]

Setup commands:
  link [path]            symlink the Genie packages from a local checkout (no publish)
  init [--dry-run]       wire Genie into your app (Vite plugin, or Next.js layout + instrumentation)
  doctor [--live]        check that Genie is set up correctly (--live also probes the running hub, client, and a session round-trip)
  hub [--port <n>]       run the standalone hub for Next.js / non-Vite apps (default 4390; busy ports walk upward, explicit --port is strict)

Tool commands (dev server must be running with the genie() plugin or hub):
  tools [group|tool]     discover the live catalog progressively: group index → group → full contract (--all for everything)
  status                 show bridge connection + app info
  call <tool> '<json>'   invoke a tool, e.g. npx @genie-react/cli call react_get_renders '{"sort":"renders"}'

Run any command with --help for details and an example.

Options:
  --port <n>       (hub) port to listen on
  --url <ws-url>   override the bridge URL (default: from .genie/bridge.json)
  --wait <ms>      how long to wait for the app to connect (default 15000)
  --session <id>   target one app session when several tabs are connected (status lists them)
  --json           print raw compact JSON instead of the summary
  --all            (tools) the complete flat catalog instead of the group index
  --dry-run        (init) print intended changes without writing files
  --yes, -y        assume yes for any prompts
  --help, -h       show this help
  --version        print the version
  GENIE_BRIDGE_URL   env override for the bridge URL (same as --url; set once for the shell)
  GENIE_SESSION      env pin for --session (set once per agent shell, so every call targets your tab)`

const COMMAND_HELP: Record<string, string> = {
  tools: `genie tools — discover the live tool catalog progressively

Usage:
  genie tools                 group index: every domain with counts + a name preview
  genie tools <group>         one group's tools with their params (e.g. genie tools react.render)
  genie tools <tool>          one tool's full contract: description, params, a runnable example
  genie tools --all           the complete flat catalog
  genie tools --json          machine output at every level (slim by default, full schema per tool)

Example:
  genie tools react.render && genie tools react_get_renders`,
  call: `genie call — invoke a tool on the live app

Usage: genie call <tool> '<json-args>' [--session <id>] [--json]

Args are one JSON string; discover names and params with genie tools.
Output is a compact summary; --json prints the raw result.

Example:
  genie call react_get_renders '{"sort":"unnecessary"}'`,
  status: `genie status — bridge connection + app info

Shows connection state, app name, React version, tool count, and every
connected session (target one with --session <id> or GENIE_SESSION).

Example:
  genie status --json`,
  doctor: `genie doctor — check that Genie is wired correctly

Usage: genie doctor [--live]

Static checks always run (config, packages, discovery file).
--live also probes the running stack: hub HTTP + identity, served client
bundle, and a session round-trip over the bridge.

Example:
  genie doctor --live`,
  hub: `genie hub — run the standalone hub (Next.js / non-Vite apps)

Usage: genie hub [--port <n>]

Defaults to port 4390 and walks upward when busy; an explicit --port is
strict. Prints the <script> tag to add first in <head>.

Example:
  genie hub`,
  init: `genie init — wire Genie into this app

Usage: genie init [--dry-run] [--yes]

Detects the host: Vite apps get the genie() plugin (+ <Genie /> where it
can be inserted), Next.js gets <GenieScript /> + instrumentation.ts, and
anything else gets the universal hub + script-tag setup.

Example:
  genie init --dry-run`,
  link: `genie link — symlink Genie packages from a local checkout (no publish)

Usage: genie link [path-to-genie-checkout]`,
}

function readVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url)
    const pkg: unknown = JSON.parse(readFileSync(url, 'utf8'))
    if (isRecord(pkg) && typeof pkg.version === 'string') return pkg.version
    return '0.0.0'
  } catch {
    return '0.0.0'
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      live: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      url: { type: 'string' },
      wait: { type: 'string' },
      session: { type: 'string' },
      json: { type: 'boolean' },
      all: { type: 'boolean' },
      port: { type: 'string' },
    },
  })

  if (values.version) {
    process.stdout.write(`${readVersion()}\n`)
    return 0
  }

  const command = positionals[0]
  if (values.help && command && command in COMMAND_HELP) {
    process.stdout.write(`${COMMAND_HELP[command]}\n`)
    return 0
  }
  if (!command || values.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }

  const agentOptions = {
    url: values.url,
    waitMs: values.wait ? Number(values.wait) : undefined,
    json: values.json,
    session: values.session,
    all: values.all,
  }

  switch (command) {
    case 'init': {
      const result = runInit({
        dryRun: values['dry-run'] ?? false,
        yes: values.yes ?? false,
      })
      return result.ok ? 0 : 1
    }
    case 'doctor': {
      const result = values.live ? await runLiveDoctor() : runDoctor()
      return result.ok ? 0 : 1
    }
    case 'hub': {
      const port = values.port ? Number(values.port) : undefined
      if (port !== undefined && (!Number.isInteger(port) || port <= 0)) {
        process.stderr.write(`genie hub: invalid --port ${values.port}\n`)
        return 1
      }
      return runHub({ port })
    }
    case 'link':
      return runLink({ genieRoot: positionals[1] })
    case 'tools':
      return runTools(positionals[1], agentOptions)
    case 'status':
      return runStatus(agentOptions)
    case 'call':
      return runCall(positionals[1], positionals[2], agentOptions)
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`)
      return 1
  }
}

// exitCode + natural exit, NOT process.exit(): exit() drops buffered stdout past the 64KB pipe window, truncating piped --json output.
main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`genie: ${errorMessage(error)}\n`)
    process.exitCode = 1
  })
