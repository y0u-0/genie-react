#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { CAPTURE_DOMAINS, type CaptureDomain, errorMessage } from 'genie-react/protocol'
import {
  formatAgentFailure,
  renderResult,
  runBatch,
  runCall,
  runCaptureExport,
  runStatus,
  runTools,
} from './agent'
import { isRecord } from './guards'
import { runHub } from './hub-command'
import { runDoctor, runInit, runLiveDoctor } from './index'
import { runLink } from './link'
import { installOutputFailureHandler, setOutputContext } from './output-safety'

installOutputFailureHandler()
setOutputContext({ operation: process.argv.slice(2, 4).join(' ') || 'help' })

const HELP = `genie-react — give an AI agent live DevTools on your running React + TanStack app

Usage: npx @genie-react/cli <command> [options]

Setup commands:
  link [<path>]          Symlink Genie packages from a local checkout without publishing
  init [--dry-run]       Wire Genie into a Vite or Next.js app
  doctor [--live]        Check setup; --json emits machine-readable health and remediation
  hub [--port <n>]       Run the standalone hub (default 4390; explicit ports are strict)

Tool commands (dev server must be running with the genie() plugin or hub):
  tools [<group|tool>]   Discover the catalog progressively; use --all for every contract
  status                 Show compact bridge, app, and session readiness
  call <tool> '<json>'   Invoke one live tool
  batch [<json-array>]   Run sequential calls; JSONL by default, one array with --json
  capture export <id>    Export a retained, checksummed capture to a local file

Run any command with --help for details and an example.

Options:
  --port <n>       Listen on this hub port
  --url <ws-url>   Override the bridge URL discovered from .genie/bridge.json
  --connect-timeout <ms> Bound bridge startup to 100–120000ms (default 8000)
  --wait <ms>      Call/tools/batch: wait up to 1–120000ms for an app (default 15000)
  --timeout <ms>   Bound each call; the bridge clamps to 1000–120000ms
  --fields <keys>  Project result records to validated comma-separated keys as JSONL
  --select <path>  Select nested output with JSON Pointer or dotted wildcards
  --max-bytes <n>  Hard output ceiling (512–50000000 bytes); reports omitted paths
  --session <target> Target a physical id, logical id, or unique session name
  --json           Print compact JSON and structured failures
  --ndjson         Batch: explicitly print one JSON object per result line
  --sessions-only  Status: omit app, domain, and tool metadata
  --all            Print every tool contract
  --verbose        Print bootstrap phases to stderr; machine stdout stays clean
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
  genie-react tools --verbose       show CLI version, bridge target, and time budgets on stderr

Example:
  genie-react tools react.render && genie-react tools react_get_renders`,
  call: `genie-react call — invoke a tool on the live app

Usage: genie-react call <tool> '<json-args>' [--session <id>] [--json] [--timeout <ms>] [--connect-timeout <ms>] [--fields <keys>|--select <path>] [--max-bytes <n>] [--fail-on-result-error]

Args are one JSON string; discover names and params with genie-react tools.
Output is a compact summary; --json prints the raw result.
--fields id,name,changes prints machine-first output: the first array-of-records
in the result, one JSON object per line, with only those keys (implies --json shape).
--timeout <ms> sets this call's time budget (clamped to [1000, 120000]); on a busy
app the failure is tagged [busy] with a retry hint instead of stalling.

Example:
  genie-react call react_get_renders '{"sort":"selfTime"}'
  genie-react call react_find_components '{"query":"Button"}' --fields id,name,path
  genie-react call devtools_capture_read '{"captureId":"cap_…","view":"full"}' --select sections.react --max-bytes 20000`,
  batch: `genie-react batch — run many tool calls over one connection

Usage: genie-react batch '<json-array>' [--session <target>] [--timeout <ms>] [--connect-timeout <ms>] [--json|--ndjson] [--select <path>] [--max-bytes <n>]

The array items are {tool, args?} objects; calls run sequentially and continue on
error. The default and --ndjson print one object per line for compatibility; --json
prints one valid JSON array. Exits 0 only if every call succeeded. Omit the argument
to read the JSON array from stdin. Unknown item keys are rejected (use "args", not "input").
--max-bytes applies to the whole command, including every JSONL result.

Example:
  genie-react batch '[{"tool":"react_find_components","args":{"query":"Btn"}},{"tool":"react_get_renders","args":{"sort":"selfTime"}}]'`,
  status: `genie-react status — bridge connection + app info

Shows connection/readiness state, app name, React version, tool count, and every
connected session. Target one by physical id, logical id, or unique name with
--session <target> / GENIE_SESSION. Use --sessions-only for the smallest response.
Use --marker <text> to correlate machine output and --select/--max-bytes to bound it.

Example:
  genie-react status --json
  genie-react status --verbose`,
  capture: `genie-react capture export — write a retained capture with verified SHA-256 integrity

Usage: genie-react capture export <capture-id> --output <path> [--section <domains>] [--force] [--json] [--select <path>] [--max-bytes <n>]

The export performs a full bridge read, verifies the capture's embedded checksum,
and writes through a temporary file. Existing files are refused unless --force.
--section accepts comma-separated domains such as react,effects.

Example:
  genie-react capture export cap_123 --output .context/captures/before.json --section react,effects`,
  doctor: `genie-react doctor — check that Genie is wired correctly

Usage: genie-react doctor [--live] [--json]

Static checks always run (config, packages, discovery file).
--live also probes the running stack: hub HTTP + identity, served client
bundle, a session round-trip, and React source-map health. --json includes
checks, CLI/runtime/skill versions and hashes, bridge candidates, session
health, and remediation without human text on stdout.

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
  doctor: new Set(['live', 'json', 'select', 'max-bytes']),
  hub: new Set(['port']),
  link: new Set(),
  tools: new Set([
    'url',
    'connect-timeout',
    'wait',
    'session',
    'json',
    'all',
    'select',
    'max-bytes',
    'verbose',
  ]),
  status: new Set([
    'url',
    'connect-timeout',
    'session',
    'json',
    'sessions-only',
    'select',
    'max-bytes',
    'marker',
    'verbose',
  ]),
  call: new Set([
    'url',
    'connect-timeout',
    'wait',
    'session',
    'json',
    'timeout',
    'fields',
    'select',
    'max-bytes',
    'fail-on-result-error',
    'verbose',
  ]),
  batch: new Set([
    'url',
    'connect-timeout',
    'wait',
    'session',
    'json',
    'ndjson',
    'timeout',
    'select',
    'max-bytes',
    'verbose',
  ]),
  capture: new Set([
    'url',
    'connect-timeout',
    'session',
    'json',
    'select',
    'max-bytes',
    'output',
    'section',
    'force',
    'verbose',
  ]),
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
  capture: 3,
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

function parseCaptureSections(raw: string | undefined): CaptureDomain[] | undefined {
  const sections = parseFields(raw)
  if (!sections) return undefined
  const allowed = new Set<string>(CAPTURE_DOMAINS)
  const invalid = sections.filter((section) => !allowed.has(section))
  if (invalid.length > 0) {
    throw new Error(
      `Unknown capture section ${JSON.stringify(invalid[0])}. Valid sections: ${CAPTURE_DOMAINS.join(', ')}.`,
    )
  }
  return sections as CaptureDomain[]
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
      'connect-timeout': { type: 'string' },
      wait: { type: 'string' },
      session: { type: 'string' },
      json: { type: 'boolean' },
      ndjson: { type: 'boolean' },
      'sessions-only': { type: 'boolean' },
      all: { type: 'boolean' },
      port: { type: 'string' },
      timeout: { type: 'string' },
      fields: { type: 'string' },
      select: { type: 'string' },
      'max-bytes': { type: 'string' },
      'fail-on-result-error': { type: 'boolean' },
      marker: { type: 'string' },
      output: { type: 'string' },
      section: { type: 'string' },
      force: { type: 'boolean' },
      verbose: { type: 'boolean' },
    },
  })

  if (values.version) {
    process.stdout.write(`${readVersion()}\n`)
    return 0
  }

  const command = positionals[0]
  const machine =
    values.json === true ||
    values.ndjson === true ||
    values.fields !== undefined ||
    values.select !== undefined ||
    values['max-bytes'] !== undefined
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
    values['connect-timeout'] !== undefined &&
    (!Number.isFinite(Number(values['connect-timeout'])) ||
      Number(values['connect-timeout']) < 100 ||
      Number(values['connect-timeout']) > 120_000)
  ) {
    writeCliFailure(machine, '--connect-timeout must be a number from 100 to 120000 milliseconds.')
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
  if (values.select !== undefined && values.select.trim() === '') {
    writeCliFailure(machine, '--select requires a non-empty JSON Pointer or dotted path.')
    return 1
  }
  if (values.fields !== undefined && values.select !== undefined) {
    writeCliFailure(machine, 'Choose either --fields or --select, not both.')
    return 1
  }
  if (
    values['max-bytes'] !== undefined &&
    (!Number.isInteger(Number(values['max-bytes'])) ||
      Number(values['max-bytes']) < 512 ||
      Number(values['max-bytes']) > 50_000_000)
  ) {
    writeCliFailure(machine, '--max-bytes must be an integer from 512 to 50000000.')
    return 1
  }
  if (
    values.marker !== undefined &&
    (values.marker.length === 0 ||
      values.marker.length > 80 ||
      [...values.marker].some((character) => (character.codePointAt(0) ?? 0) <= 31))
  ) {
    writeCliFailure(machine, '--marker must be 1–80 characters without control characters.')
    return 1
  }
  if (command === 'batch' && values.json === true && values.ndjson === true) {
    writeCliFailure(true, 'Choose either --json or --ndjson, not both.')
    return 1
  }
  const agentOptions = {
    url: values.url,
    connectTimeoutMs: values['connect-timeout'] ? Number(values['connect-timeout']) : undefined,
    waitMs: values.wait ? Number(values.wait) : undefined,
    json: values.json,
    ndjson: values.ndjson,
    session: values.session,
    all: values.all,
    timeoutMs: values.timeout ? Number(values.timeout) : undefined,
    fields: parseFields(values.fields),
    select: values.select,
    maxBytes: values['max-bytes'] ? Number(values['max-bytes']) : undefined,
    failOnResultError: values['fail-on-result-error'],
    marker: values.marker,
    sessionsOnly: values['sessions-only'],
    verbose: values.verbose,
    cliVersion: readVersion(),
  }

  if (values.verbose) {
    process.stderr.write(
      `genie-react: phase=bootstrap version=${agentOptions.cliVersion} command=${command}\n`,
    )
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
      const logger = machine ? { info: () => undefined, error: () => undefined } : undefined
      const result = values.live ? await runLiveDoctor({ logger }) : runDoctor({ logger })
      if (machine) {
        process.stdout.write(
          `${renderResult(
            'doctor',
            result,
            true,
            undefined,
            values.select,
            values['max-bytes'] ? Number(values['max-bytes']) : undefined,
          )}\n`,
        )
      }
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
    case 'capture': {
      if (positionals[1] !== 'export') {
        writeCliFailure(machine, 'Capture currently requires the `export` subcommand.')
        return 1
      }
      let sections: CaptureDomain[] | undefined
      try {
        sections = parseCaptureSections(values.section)
      } catch (error) {
        writeCliFailure(machine, errorMessage(error))
        return 1
      }
      return runCaptureExport(positionals[2], {
        ...agentOptions,
        output: values.output,
        sections,
        force: values.force,
      })
    }
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
      (arg) =>
        arg === '--json' ||
        arg === '--ndjson' ||
        arg === '--fields' ||
        arg.startsWith('--fields=') ||
        arg === '--select' ||
        arg.startsWith('--select=') ||
        arg === '--max-bytes' ||
        arg.startsWith('--max-bytes='),
    )
    const message = errorMessage(error)
    if (machine) {
      process.stdout.write(
        `${formatAgentFailure('invalid_input', message, { userActionRequired: true })}\n`,
      )
    } else {
      process.stderr.write(`genie-react: ${message}\n`)
    }
    process.exitCode = 1
  })
