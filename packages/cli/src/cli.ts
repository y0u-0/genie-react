#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { errorMessage } from '@genie-react/core'
import { runCall, runStatus, runTools } from './agent'
import { isRecord } from './guards'
import { runDoctor, runInit } from './index'
import { runLink } from './link'

const HELP = `genie — give an AI agent live DevTools on your running React + TanStack app

Usage: npx @genie-react/cli <command> [options]

Setup commands:
  link [path]            symlink the Genie packages from a local checkout (no publish)
  init [--dry-run]       add the genie() plugin to your Vite config
  doctor                 check that Genie is set up correctly

Tool commands (dev server must be running with the genie() plugin):
  tools                  list the tools the live app advertises
  status                 show bridge connection + app info
  call <tool> '<json>'   invoke a tool, e.g. npx @genie-react/cli call react_get_renders '{"sort":"renders"}'

Options:
  --url <ws-url>   override the bridge URL (default: from .genie/bridge.json)
  --wait <ms>      how long to wait for the app to connect (default 15000)
  --session <id>   target one app session when several tabs are connected (status lists them)
  --json           print raw JSON instead of the compact summary
  --dry-run        (init) print intended changes without writing files
  --yes, -y        assume yes for any prompts
  --help, -h       show this help
  --version        print the version
  GENIE_BRIDGE_URL   env override for the bridge URL (same as --url; set once for the shell)`

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
      yes: { type: 'boolean', short: 'y' },
      url: { type: 'string' },
      wait: { type: 'string' },
      session: { type: 'string' },
      json: { type: 'boolean' },
    },
  })

  if (values.version) {
    process.stdout.write(`${readVersion()}\n`)
    return 0
  }

  const command = positionals[0]
  if (!command || values.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }

  const agentOptions = {
    url: values.url,
    waitMs: values.wait ? Number(values.wait) : undefined,
    json: values.json,
    session: values.session,
  }

  switch (command) {
    case 'init': {
      const result = runInit({
        dryRun: values['dry-run'] ?? false,
        yes: values.yes ?? false,
      })
      return result.ok ? 0 : 1
    }
    case 'doctor':
      return runDoctor().ok ? 0 : 1
    case 'link':
      return runLink({ genieRoot: positionals[1] })
    case 'tools':
      return runTools(agentOptions)
    case 'status':
      return runStatus(agentOptions)
    case 'call':
      return runCall(positionals[1], positionals[2], agentOptions)
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`)
      return 1
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`genie: ${errorMessage(error)}\n`)
    process.exit(1)
  })
