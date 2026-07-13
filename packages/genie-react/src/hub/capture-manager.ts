import type { ZodError } from 'zod'
import {
  type AgentErrorCode,
  type AppInfo,
  CAPTURE_SCHEMA_VERSION,
  type CaptureArtifact,
  type CaptureDomain,
  dehydrate,
  devtoolsCaptureCompareContract,
  devtoolsCaptureCreateContract,
  devtoolsCaptureListContract,
  devtoolsCaptureReadContract,
  newId,
  type ToolDescriptor,
} from '../protocol'
import { compareCaptureCohorts } from './capture-comparison'

const MAX_RETAINED_CAPTURES = 20
const MAX_CAPTURE_BYTES = 2_000_000

type CaptureSection = NonNullable<CaptureArtifact['sections'][CaptureDomain]>
type CaptureToolResult = CaptureSection['tools'][string]

interface CaptureRecipeTool {
  name: string
  args: unknown
}

interface CaptureRequestResult {
  ok: boolean
  result?: unknown
  error?: string
  errorCode?: AgentErrorCode
}

export interface CaptureSession {
  sessionId: string
  logicalSessionId?: string
  documentGeneration?: number
  sessionName?: string
  app: AppInfo
  tools: ToolDescriptor[]
}

export type CaptureInvocation =
  | { ok: true; result: unknown }
  | {
      ok: false
      error: string
      errorCode: Extract<
        AgentErrorCode,
        'invalid-args' | 'not-connected' | 'unknown-session' | 'tool-error'
      >
    }

interface CaptureManagerOptions<TSession extends CaptureSession> {
  resolveSession: (target?: string) => TSession | null
  unknownSessionError: (target: string) => string
  isCurrentSession: (session: TSession) => boolean
  request: (session: TSession, tool: string, args: unknown) => Promise<CaptureRequestResult>
}

const REACT_COMMIT_PROBE: CaptureRecipeTool = {
  name: 'react_get_renders',
  args: { sort: 'renders', limit: 200, appOnly: true },
}

const CAPTURE_RECIPES: Record<CaptureDomain, CaptureRecipeTool[]> = {
  react: [
    REACT_COMMIT_PROBE,
    { name: 'react_render_causes', args: { limit: 200, appOnly: true } },
    { name: 'react_profile_report', args: { limit: 100 } },
  ],
  effects: [
    {
      name: 'react_effect_audit',
      args: {
        onlyHot: false,
        appOnly: true,
        minUpdates: 3,
        minFireRate: 1,
        limit: 200,
      },
    },
  ],
  query: [
    { name: 'query_list', args: { staleOnly: false, limit: 500 } },
    { name: 'query_is_fetching', args: {} },
  ],
  router: [
    { name: 'router_get_state', args: {} },
    { name: 'router_list_matches', args: { depth: 2 } },
  ],
  memory: [{ name: 'browser_get_memory', args: {} }],
  performance: [{ name: 'browser_fps', args: { durationMs: 250 } }],
}

const CAPTURE_TOOL_NAMES = new Set([
  devtoolsCaptureCreateContract.name,
  devtoolsCaptureListContract.name,
  devtoolsCaptureReadContract.name,
  devtoolsCaptureCompareContract.name,
])

export function isCaptureTool(tool: string): boolean {
  return CAPTURE_TOOL_NAMES.has(tool)
}

/** Owns capture validation, collection, retention, and comparison. The socket hub only supplies exact-session routing. */
export class CaptureManager<TSession extends CaptureSession> {
  private readonly captures = new Map<string, CaptureArtifact>()

  constructor(private readonly options: CaptureManagerOptions<TSession>) {}

  clear(): void {
    this.captures.clear()
  }

  async invoke(tool: string, args: unknown, sessionTarget?: string): Promise<CaptureInvocation> {
    if (tool === devtoolsCaptureListContract.name) {
      const parsed = devtoolsCaptureListContract.input.safeParse(args ?? {})
      if (!parsed.success) return invalidArguments(tool, parsed.error)
      const captures = [...this.captures.values()]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map(captureSummary)
      return {
        ok: true,
        result: { captures, total: captures.length, maxRetained: MAX_RETAINED_CAPTURES },
      }
    }

    if (tool === devtoolsCaptureReadContract.name) {
      const parsed = devtoolsCaptureReadContract.input.safeParse(args ?? {})
      if (!parsed.success) return invalidArguments(tool, parsed.error)
      const capture = this.captures.get(parsed.data.captureId)
      return capture
        ? { ok: true, result: structuredClone(capture) }
        : {
            ok: false,
            error: `No retained capture ${JSON.stringify(parsed.data.captureId)}. Run devtools_capture_list to inspect retained IDs.`,
            errorCode: 'invalid-args',
          }
    }

    if (tool === devtoolsCaptureCompareContract.name) {
      const parsed = devtoolsCaptureCompareContract.input.safeParse(args ?? {})
      if (!parsed.success) return invalidArguments(tool, parsed.error)
      const requestedIds = [...parsed.data.baselineCaptureIds, ...parsed.data.candidateCaptureIds]
      const missing = requestedIds.filter((captureId) => !this.captures.has(captureId))
      if (missing.length > 0) {
        return {
          ok: false,
          error: `No retained capture${missing.length === 1 ? '' : 's'} ${missing.map((captureId) => JSON.stringify(captureId)).join(', ')}. Run devtools_capture_list to inspect retained IDs.`,
          errorCode: 'invalid-args',
        }
      }
      const getCapture = (captureId: string): CaptureArtifact => {
        const capture = this.captures.get(captureId)
        if (!capture) throw new Error(`Retained capture ${captureId} disappeared.`)
        return capture
      }
      return {
        ok: true,
        result: compareCaptureCohorts(
          parsed.data.baselineCaptureIds.map(getCapture),
          parsed.data.candidateCaptureIds.map(getCapture),
          parsed.data,
          { comparisonId: `cmp_${newId()}`, createdAt: new Date().toISOString() },
        ),
      }
    }

    if (tool !== devtoolsCaptureCreateContract.name) {
      throw new Error(`CaptureManager cannot handle ${JSON.stringify(tool)}.`)
    }
    const parsed = devtoolsCaptureCreateContract.input.safeParse(args ?? {})
    if (!parsed.success) return invalidArguments(tool, parsed.error)
    const session = this.options.resolveSession(sessionTarget)
    if (!session) {
      return {
        ok: false,
        error: sessionTarget
          ? this.options.unknownSessionError(sessionTarget)
          : 'No app connected. Start the dev server and open the app in a browser.',
        errorCode: sessionTarget ? 'unknown-session' : 'not-connected',
      }
    }
    try {
      return { ok: true, result: await this.create(session, parsed.data) }
    } catch (error) {
      return { ok: false, error: errorMessage(error), errorCode: 'tool-error' }
    }
  }

  private async create(
    session: TSession,
    input: { name: string; include: CaptureDomain[]; maxAttempts: number },
  ): Promise<CaptureArtifact> {
    let finalSections: CaptureArtifact['sections'] = {}
    let finalCommit: number | null = null
    let consistencyKind: CaptureArtifact['consistency']['kind'] = 'best-effort'
    let consistencyReason = 'React commit probes were unavailable.'
    let attempts = 0

    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
      attempts = attempt
      this.assertSameDocument(session)
      const firstProbe = await this.captureTool(session, REACT_COMMIT_PROBE)
      const sections: CaptureArtifact['sections'] = {}

      for (const domain of input.include) {
        sections[domain] = await this.captureSection(
          session,
          domain,
          domain === 'react' ? { react_get_renders: firstProbe } : undefined,
        )
      }

      const lastProbe = await this.captureTool(session, REACT_COMMIT_PROBE)
      this.assertSameDocument(session)
      const commitCounts = [
        commitCountOf(firstProbe),
        ...Object.values(sections)
          .filter((section): section is CaptureSection => section !== undefined)
          .flatMap((section) => Object.values(section.tools).map(commitCountOf)),
        commitCountOf(lastProbe),
      ].filter((commit): commit is number => commit !== null)
      const hasBothProbes = commitCountOf(firstProbe) !== null && commitCountOf(lastProbe) !== null
      const stable =
        hasBothProbes &&
        commitCounts.length >= 2 &&
        commitCounts.every((commit) => commit === commitCounts[0])

      finalSections = sections
      finalCommit = stable ? (commitCounts[0] ?? null) : null
      if (stable) {
        consistencyKind = 'react-commit-stable'
        consistencyReason =
          'React commit counters matched before, during, and after all captured sections.'
        break
      }
      if (hasBothProbes) {
        consistencyReason =
          attempt < input.maxAttempts
            ? 'React committed during the capture; retrying.'
            : 'React continued committing across every capture attempt.'
      }
    }

    const warnings = captureWarnings(finalSections)
    if (consistencyKind === 'best-effort') warnings.push(consistencyReason)
    const capture: CaptureArtifact = {
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      captureId: `cap_${newId()}`,
      name: input.name,
      createdAt: new Date().toISOString(),
      session: {
        sessionId: session.sessionId,
        ...(session.logicalSessionId === undefined
          ? {}
          : { logicalSessionId: session.logicalSessionId }),
        ...(session.documentGeneration === undefined
          ? {}
          : { documentGeneration: session.documentGeneration }),
        ...(session.sessionName === undefined ? {} : { sessionName: session.sessionName }),
        app: session.app,
      },
      include: [...input.include],
      consistency: {
        kind: consistencyKind,
        attempts,
        reactCommit: finalCommit,
        reason: consistencyReason,
      },
      sections: finalSections,
      complete:
        input.include.every((domain) => finalSections[domain]?.status === 'ok') &&
        consistencyKind === 'react-commit-stable',
      warnings,
      sizeBytes: 0,
    }
    capture.sizeBytes = captureSizeBytes(capture)
    if (capture.sizeBytes > MAX_CAPTURE_BYTES) {
      throw new Error(
        `Capture is ${capture.sizeBytes} bytes; the retained-artifact limit is ${MAX_CAPTURE_BYTES} bytes. Capture fewer domains.`,
      )
    }
    this.retain(capture)
    return structuredClone(capture)
  }

  private async captureSection(
    session: TSession,
    domain: CaptureDomain,
    existing: Record<string, CaptureToolResult> = {},
  ): Promise<CaptureSection> {
    const tools: Record<string, CaptureToolResult> = { ...existing }
    for (const recipe of CAPTURE_RECIPES[domain]) {
      tools[recipe.name] ??= await this.captureTool(session, recipe)
    }
    const statuses = Object.values(tools).map((tool) => tool.status)
    const status: CaptureSection['status'] = statuses.every((value) => value === 'ok')
      ? 'ok'
      : statuses.every((value) => value === 'unavailable')
        ? 'unavailable'
        : statuses.every((value) => value === 'error')
          ? 'error'
          : 'partial'
    return { status, tools }
  }

  private async captureTool(
    session: TSession,
    recipe: CaptureRecipeTool,
  ): Promise<CaptureToolResult> {
    const startedAt = Date.now()
    if (!session.tools.some((tool) => tool.name === recipe.name)) {
      return {
        status: 'unavailable',
        capturedAt: new Date().toISOString(),
        durationMs: 0,
        error: `Tool ${JSON.stringify(recipe.name)} is not advertised by this app.`,
      }
    }
    const response = await this.options.request(session, recipe.name, recipe.args)
    if (!response.ok && response.errorCode === 'not-connected') {
      throw new Error('The app document changed during capture. Retry against the ready successor.')
    }
    const durationMs = Date.now() - startedAt
    return response.ok
      ? {
          status: 'ok',
          capturedAt: new Date().toISOString(),
          durationMs,
          result: dehydrate(response.result, {
            depth: 12,
            maxEntries: 1_000,
            maxStringLength: 10_000,
          }),
        }
      : {
          status: 'error',
          capturedAt: new Date().toISOString(),
          durationMs,
          error: response.error ?? `Tool ${JSON.stringify(recipe.name)} failed.`,
        }
  }

  private assertSameDocument(session: TSession): void {
    if (!this.options.isCurrentSession(session)) {
      throw new Error('The app document changed during capture. Retry against the ready successor.')
    }
  }

  private retain(capture: CaptureArtifact): void {
    this.captures.set(capture.captureId, structuredClone(capture))
    while (this.captures.size > MAX_RETAINED_CAPTURES) {
      const oldest = this.captures.keys().next().value
      if (oldest === undefined) break
      this.captures.delete(oldest)
    }
  }
}

function invalidArguments(tool: string, error: ZodError): CaptureInvocation {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'arguments'
    return `${safeDiagnostic(path)}: ${safeDiagnostic(issue.message)}`
  })
  return {
    ok: false,
    error: `Invalid ${tool} arguments — ${issues.join('; ')}.`,
    errorCode: 'invalid-args',
  }
}

function safeDiagnostic(value: string): string {
  const printable = [...value]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0
      return point <= 31 || point === 127 ? '?' : character
    })
    .join('')
  return printable.length > 200 ? `${printable.slice(0, 200)}…` : printable
}

function commitCountOf(result: CaptureToolResult): number | null {
  if (result.status !== 'ok' || typeof result.result !== 'object' || result.result === null) {
    return null
  }
  const commits = Reflect.get(result.result, 'commits')
  return typeof commits === 'number' && Number.isSafeInteger(commits) && commits >= 0
    ? commits
    : null
}

function captureWarnings(sections: CaptureArtifact['sections']): string[] {
  const warnings: string[] = []
  for (const [domain, section] of Object.entries(sections)) {
    if (!section || section.status === 'ok') continue
    for (const [tool, result] of Object.entries(section.tools)) {
      if (result.status === 'ok') continue
      const detail = result.error ? `: ${result.error}` : ''
      warnings.push(`${domain}.${tool} is ${result.status}${detail}`)
    }
  }
  return warnings.slice(0, 20)
}

function captureSummary(capture: CaptureArtifact): Omit<CaptureArtifact, 'sections' | 'warnings'> {
  const { sections: _sections, warnings: _warnings, ...summary } = capture
  return summary
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Computes the serialized artifact size including the size field itself. */
function captureSizeBytes(capture: CaptureArtifact): number {
  let size = capture.sizeBytes
  for (let pass = 0; pass < 4; pass += 1) {
    capture.sizeBytes = size
    const measured = Buffer.byteLength(JSON.stringify(capture), 'utf8')
    if (measured === size) return size
    size = measured
  }
  capture.sizeBytes = size
  return Buffer.byteLength(JSON.stringify(capture), 'utf8')
}
