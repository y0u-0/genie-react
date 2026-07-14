import { writeSync } from 'node:fs'

interface OutputContext {
  operation: string
  operationId?: string
}

let context: OutputContext = { operation: 'genie-react' }
let installed = false
let reported = false

export function setOutputContext(next: OutputContext): void {
  context = next
}

export function formatOutputFailureDiagnostic(error: NodeJS.ErrnoException): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    status: 'error',
    reason: 'output-failure',
    code: error.code ?? 'UNKNOWN',
    operation: context.operation,
    ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
    message:
      error.code === 'ENOSPC'
        ? 'The operation completed but stdout could not be stored because the destination is full. Recover disk space, then re-read the operation or capture by ID.'
        : error.code === 'EPIPE'
          ? 'The operation completed but the stdout pipe closed before the full response was delivered. Re-run with --output/--max-bytes or read the capture by ID.'
          : 'The operation completed but stdout failed before the full response was delivered. Re-run with --output/--max-bytes or read the capture by ID.',
  })
}

/** Prevent EPIPE/ENOSPC from becoming an unstructured crash after a successful remote mutation. */
export function installOutputFailureHandler(): void {
  if (installed) return
  installed = true
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (reported) return
    reported = true
    try {
      writeSync(2, `${formatOutputFailureDiagnostic(error)}\n`)
    } catch {
      // There is no safe output channel left; process.exitCode still records failure.
    }
    process.exitCode = 1
  })
}
