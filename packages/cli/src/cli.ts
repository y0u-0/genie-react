#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { errorMessage } from 'genie-react/protocol'
import { formatAgentFailure, runBatch, runCall, runStatus, runTools } from './agent'
import { isRecord } from './guards'
import { runHub } from './hub-command'
import { runDoctor, runInit, runLiveDoctor } from './index'
import { runLink } from './link'

const HELP = `genie-react — give an AI agent live DevTools on your running React + TanStack app

Usage: npx @genie-react/cli <command> [options]

Setup commands:
  link [<path>]          Symlink Genie packages from a local checkout without publishing
  init [--dry-run]       Wire Genie into a Vite or Next.js app
  doctor [--live]        Check setup; --live also probes the hub, client, and session
  hub [--port <n>]       Run the standalone hub (default 4390; explicit ports are strict)

Tool commands (dev server must be running with the genie() plugin or hub):
  tools [<group|tool>]   Discover the catalog progressively; use --all for every contract
  status                 Show bridge, app, session, and tool details
  call <tool> '<json>'   Invoke one live tool
  batch [<json-array>]   Run sequential calls as JSONL; reads JSON from stdin when omitted

Run any command with --help for details and an example.

Options:
  --port <n>       Listen on this hub port
  --url <ws-url>   Override the bridge URL discovered from .genie/bridge.json
  --wait <ms>      Wait up to 1–120000ms for an app (default 15000)
  --timeout <ms>   Bound each call; the bridge clamps to 1000–120000ms
  --fields <keys>  Project result records to validated comma-separated keys as JSONL
  --session <id>   Target one app session; status lists IDs
  --json           Print compact JSON and structured failures
  --all            Print every tool contract
  --dry-run        Preview init changes without writing files
  --yes, -y        Accept safe init defaults
  --help, -h       Show help
  --version        Print the version
  GENIE_BRIDGE_URL   env override for the bridge URL (same as --url; set once for the shell)
  GENIE_SESSION      env pin for --session (set once per agent shell, so every call targets your tab)`

const COMMAND_HELP: Record<string, string> = {
  tools: `genie-react tools — discover the live tool catalog progressively

Usage:
  genie-react tools                 group index: every domain with counts + a name preview
  genie-react tools <group>         one group's tools with their params (e.g. genie-react tools react.render)
  genie-react tools <tool>          one tool's full contract: description, params, a runnable example
  genie-react tools --all           the complete flat catalog
  genie-react tools --json          machine output at every level (slim by default, full schema per tool)

Example:
  genie-react tools react.render && genie-react tools react_get_renders`,
  call: `genie-react call — invoke a tool on the live app

Usage: genie-react call <tool> '<json-args>' [--session <id>] [--json] [--timeout <ms>] [--fields <keys>]

Args are one JSON string; discover names and params with genie-react tools.
Output is a compact summary; --json prints the raw result.
--fields id,name,changes prints machine-first output: the first array-of-records
in the result, one JSON object per line, with only those keys (implies --json shape).
--timeout <ms> sets this call's time budget (clamped to [1000, 120000]); on a busy
app the failure is tagged [busy] with a retry hint instead of stalling.

Example:
  genie-react call react_get_renders '{"sort":"unnecessary"}'
  genie-react call react_find_components '{"query":"Button"}' --fields id,name,path`,
  batch: `genie-react batch — run many tool calls over one connection

Usage: genie-react batch '<json-array>' [--session <id>] [--timeout <ms>]

The array items are {tool, args?} objects; calls run sequentially and continue on
error. Prints one JSON line per item ({tool, ok:true, status:"ok", result} or {tool, ok:false,
status, reason, message, errorCode?}); exits 0 only if every call succeeded. Omit the argument to read the
JSON array from stdin.

Example:
  genie-react batch '[{"tool":"react_find_components","args":{"query":"Btn"}},{"tool":"react_get_renders","args":{"sort":"unnecessary"}}]'`,
  status: `genie-react status — bridge connection + app info

Shows connection state, app name, React version, tool count, and every
connected session (target one with --session <id> or GENIE_SESSION).

Example:
  genie-react status --json`,
  doctor: `genie-react doctor — check that Genie is wired correctly

Usage: genie-react doctor [--live]

Static checks always run (config, packages, discovery file).
--live also probes the running stack: hub HTTP + identity, served client
bundle, and a session round-trip over the bridge.

Example:
  genie-react doctor --live`,
  hub: `genie-react hub — run the standalone hub (Next.js / non-Vite apps)

Usage: genie-react hub [--port <n>]

Defaults to port 4390 and walks upward when busy; an explicit --port is
strict. Prints the <script> tag to add first in <head>.

Example:
  genie-react hub`,
  init: `genie-react init — wire Genie into this app

Usage: genie-react init [--dry-run] [--yes]

Detects the host: Vite apps get the genie() plugin (+ <Genie /> where it
can be inserted), Next.js gets <GenieScript /> + instrumentation.ts, and
anything else gets the universal hub + script-tag setup.

Example:
  genie-react init --dry-run`,
  link: `genie-react link — symlink Genie packages from a local checkout (no publish)

Usage: genie-react link [path-to-genie-checkout]`,
}

type ParsedValues = Record<string, boolean | string | undefined>

const COMMAND_OPTIONS: Record<string, ReadonlySet<string>> = {
  init: new Set(['dry-run', 'yes']),
  doctor: new Set(['live']),
  hub: new Set(['port']),
  link: new Set(),
  tools: new Set(['url', 'wait', 'session', 'json', 'all']),
  status: new Set(['url', 'session', 'json']),
  call: new Set(['url', 'wait', 'session', 'json', 'timeout', 'fields']),
  batch: new Set(['url', 'wait', 'session', 'json', 'timeout']),
}

const POSITIONAL_LIMITS: Record<string, number> = {
  init: 1,
  doctor: 1,
  hub: 1,
  link: 2,
  tools: 2,
  status: 1,
  call: 3,
  batch: 2,
}

function unsupportedOption(command: string, values: ParsedValues): string | null {
  const allowed = COMMAND_OPTIONS[command]
  if (!allowed) return null
  for (const [name, value] of Object.entries(values)) {
    if (name === 'help' || name === 'version' || value === undefined || value === false) continue
    if (!allowed.has(name)) return `Option --${name} isn't valid for ${command}.`
  }
  return null
}

function writeCliFailure(machine: boolean, message: string): void {
  if (machine) {
    process.stdout.write(
      `${formatAgentFailure('invalid_input', message, { userActionRequired: true })}\n`,
    )
  } else {
    process.stderr.write(`genie-react: ${message}\n`)
  }
}

function parseFields(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const fields = raw
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean)
  return fields.length > 0 ? fields : undefined
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
      timeout: { type: 'string' },
      fields: { type: 'string' },
    },
  })

  if (values.version) {
    process.stdout.write(`${readVersion()}\n`)
    return 0
  }

  const command = positionals[0]
  const machine = values.json === true || values.fields !== undefined
  if (values.help && command && command in COMMAND_HELP) {
    process.stdout.write(`${COMMAND_HELP[command]}\n`)
    return 0
  }
  if (!command || values.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }

  if (!(command in COMMAND_HELP)) {
    writeCliFailure(
      machine,
      `Unknown command "${command}". Run \`genie-react --help\` for commands.`,
    )
    return 1
  }

  const optionError = unsupportedOption(command, values)
  if (optionError) {
    writeCliFailure(machine, optionError)
    return 1
  }
  const positionalLimit = POSITIONAL_LIMITS[command]
  if (positionalLimit !== undefined && positionals.length > positionalLimit) {
    writeCliFailure(
      machine,
      `Too many arguments for ${command}. Run \`genie-react ${command} --help\`.`,
    )
    return 1
  }

  if (
    values.timeout !== undefined &&
    (!Number.isFinite(Number(values.timeout)) || Number(values.timeout) <= 0)
  ) {
    writeCliFailure(machine, '--timeout must be a positive number of milliseconds.')
    return 1
  }
  if (
    values.wait !== undefined &&
    (!Number.isFinite(Number(values.wait)) ||
      Number(values.wait) < 1 ||
      Number(values.wait) > 120_000)
  ) {
    writeCliFailure(machine, '--wait must be a number from 1 to 120000 milliseconds.')
    return 1
  }
  if (values.fields !== undefined && parseFields(values.fields) === undefined) {
    writeCliFailure(machine, '--fields requires at least one comma-separated field name.')
    return 1
  }
  const agentOptions = {
    url: values.url,
    waitMs: values.wait ? Number(values.wait) : undefined,
    json: values.json,
    session: values.session,
    all: values.all,
    timeoutMs: values.timeout ? Number(values.timeout) : undefined,
    fields: parseFields(values.fields),
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
      if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
        writeCliFailure(machine, '--port must be an integer from 1 to 65535.')
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
    case 'batch':
      return runBatch(positionals[1], agentOptions)
    default:
      return 1
  }
}

// exitCode + natural exit, NOT process.exit(): exit() drops buffered stdout past the 64KB pipe window, truncating piped --json output.
main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    const machine = process.argv.some(
      (arg) => arg === '--json' || arg === '--fields' || arg.startsWith('--fields='),
    )
    const message = errorMessage(error)
    if (machine) {
      process.stdout.write(`${formatAgentFailure('invalid_input', message)}\n`)
    } else {
      process.stderr.write(`genie-react: ${message}\n`)
    }
    process.exitCode = 1
  })
