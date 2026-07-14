import {
  type AgentErrorCode,
  type AppInfo,
  devtoolsInteractionBeginContract,
  devtoolsInteractionStopContract,
  formatToolValidationError,
  INTERACTION_SCHEMA_VERSION,
  newId,
  type ToolDescriptor,
  type WaitDomain,
} from '../protocol'

const MAX_ACTIVE_INTERACTIONS = 20
const MAX_COMPLETED_INTERACTIONS = 20

interface InteractionRequestResult {
  ok: boolean
  result?: unknown
  error?: string
  errorCode?: AgentErrorCode
}

export interface InteractionSession {
  sessionId: string
  logicalSessionId?: string
  documentGeneration?: number
  sessionName?: string
  app: AppInfo
  tools: ToolDescriptor[]
}

export interface InteractionSettleResult {
  ok: boolean
  waitedMs: number
  reason?: string
  domains: Partial<
    Record<
      WaitDomain,
      {
        status: 'met' | 'pending' | 'failed' | 'unsupported'
        reason?: string
        lastObserved?: unknown
      }
    >
  >
}

export type InteractionInvocation =
  | { ok: true; result: unknown }
  | {
      ok: false
      error: string
      errorCode: Extract<
        AgentErrorCode,
        'invalid-args' | 'not-connected' | 'unknown-session' | 'tool-error'
      >
    }

interface InteractionManagerOptions<TSession extends InteractionSession> {
  resolveSession: (target?: string) => TSession | null
  unknownSessionError: (target: string) => string
  isCurrentSession: (session: TSession) => boolean
  request: (session: TSession, tool: string, args: unknown) => Promise<InteractionRequestResult>
  settle: (
    session: TSession,
    domains: WaitDomain[],
    quietMs: number,
    timeoutMs: number,
  ) => Promise<InteractionSettleResult>
}

interface ActiveInteraction<TSession extends InteractionSession> {
  interactionId: string
  name: string
  startedAt: string
  session: TSession
  observationId: string | null
  startDocumentCommitId: number | null
  observationConfig?: unknown
  components: string[]
}

interface ToolEvidence {
  status: 'ok' | 'unavailable' | 'error'
  tool: string
  args: unknown
  capturedAt: string
  durationMs: number
  result?: unknown
  error?: string
}

const INTERACTION_TOOL_NAMES = new Set([
  devtoolsInteractionBeginContract.name,
  devtoolsInteractionStopContract.name,
])

export function isInteractionTool(tool: string): boolean {
  return INTERACTION_TOOL_NAMES.has(tool)
}

/** Owns one-document interaction windows and freezes React evidence before generalized settling. */
export class InteractionManager<TSession extends InteractionSession> {
  private readonly active = new Map<string, ActiveInteraction<TSession>>()
  private readonly completed = new Map<string, unknown>()

  constructor(private readonly options: InteractionManagerOptions<TSession>) {}

  clear(): void {
    this.active.clear()
    this.completed.clear()
  }

  async invoke(
    tool: string,
    args: unknown,
    sessionTarget?: string,
  ): Promise<InteractionInvocation> {
    if (tool === devtoolsInteractionBeginContract.name) {
      const parsed = devtoolsInteractionBeginContract.input.safeParse(args ?? {})
      if (!parsed.success) return invalidArguments(tool, parsed.error)
      return this.begin(parsed.data, sessionTarget)
    }
    if (tool === devtoolsInteractionStopContract.name) {
      const parsed = devtoolsInteractionStopContract.input.safeParse(args ?? {})
      if (!parsed.success) return invalidArguments(tool, parsed.error)
      return this.stop(parsed.data, sessionTarget)
    }
    throw new Error(`InteractionManager cannot handle ${JSON.stringify(tool)}.`)
  }

  private async begin(
    input: ReturnType<typeof devtoolsInteractionBeginContract.input.parse>,
    sessionTarget?: string,
  ): Promise<InteractionInvocation> {
    for (const [interactionId, interaction] of this.active) {
      if (!this.options.isCurrentSession(interaction.session)) this.active.delete(interactionId)
    }
    const session = this.options.resolveSession(sessionTarget)
    if (!session) return this.noSession(sessionTarget)
    if (
      [...this.active.values()].some(
        (interaction) => interaction.session.sessionId === session.sessionId,
      )
    ) {
      return {
        ok: false,
        error: `Session ${JSON.stringify(session.sessionId)} already has a recording interaction. Stop it before beginning another; clearing now would invalidate its boundary.`,
        errorCode: 'invalid-args',
      }
    }
    if (this.active.size >= MAX_ACTIVE_INTERACTIONS) {
      return {
        ok: false,
        error: `The bridge already has ${MAX_ACTIVE_INTERACTIONS} active interactions. Stop an existing interaction before starting another.`,
        errorCode: 'tool-error',
      }
    }
    if (!hasTool(session, 'react_clear_renders')) {
      return {
        ok: false,
        error:
          'The selected app does not advertise react_clear_renders; interaction capture requires the React collector.',
        errorCode: 'tool-error',
      }
    }

    const observationArgs = {
      components: input.components,
      roots: input.roots,
      budget: input.budget,
      lifecycle: input.lifecycle,
    }
    const response = await this.options.request(session, 'react_clear_renders', observationArgs)
    if (!response.ok) {
      return {
        ok: false,
        error: response.error ?? 'react_clear_renders failed while beginning the interaction.',
        errorCode: response.errorCode === 'invalid-args' ? 'invalid-args' : 'tool-error',
      }
    }
    const result = recordOf(response.result)
    const observation = result ? recordOf(result.observation) : null
    const interactionId = `int_${newId()}`
    const startedAt = new Date().toISOString()
    const active: ActiveInteraction<TSession> = {
      interactionId,
      name: input.name,
      startedAt,
      session,
      observationId: stringField(observation, 'id'),
      startDocumentCommitId: numberField(result, 'documentCommitId'),
      ...(result && 'observationConfig' in result
        ? { observationConfig: result.observationConfig }
        : {}),
      components: input.components,
    }
    this.active.set(interactionId, active)
    const warnings: string[] = []
    if (active.observationId === null)
      warnings.push('The React collector did not return an observation ID.')
    if (active.startDocumentCommitId === null)
      warnings.push('The React collector did not return a start document commit ID.')
    return {
      ok: true,
      result: {
        schemaVersion: INTERACTION_SCHEMA_VERSION,
        kind: 'interaction-observation',
        interactionId,
        name: input.name,
        state: 'recording',
        startedAt,
        session: sessionIdentity(session),
        observationId: active.observationId,
        startDocumentCommitId: active.startDocumentCommitId,
        ...(active.observationConfig === undefined
          ? {}
          : { observationConfig: active.observationConfig }),
        warnings,
      },
    }
  }

  private async stop(
    input: ReturnType<typeof devtoolsInteractionStopContract.input.parse>,
    sessionTarget?: string,
  ): Promise<InteractionInvocation> {
    const completed = this.completed.get(input.interactionId)
    if (completed !== undefined) return { ok: true, result: structuredClone(completed) }
    const active = this.active.get(input.interactionId)
    if (!active) {
      return {
        ok: false,
        error: `Unknown or expired interaction ${JSON.stringify(input.interactionId)}. Begin a new one with devtools_interaction_begin.`,
        errorCode: 'invalid-args',
      }
    }
    if (sessionTarget) {
      const targeted = this.options.resolveSession(sessionTarget)
      if (!targeted) return this.noSession(sessionTarget)
      if (targeted.sessionId !== active.session.sessionId) {
        return {
          ok: false,
          error: `Interaction ${JSON.stringify(input.interactionId)} belongs to physical session ${JSON.stringify(active.session.sessionId)}, not ${JSON.stringify(targeted.sessionId)}.`,
          errorCode: 'invalid-args',
        }
      }
    }
    if (!this.options.isCurrentSession(active.session)) {
      this.active.delete(input.interactionId)
      return {
        ok: false,
        error: `Interaction ${JSON.stringify(input.interactionId)} cannot cross an app reload or disconnect; its original physical document is gone. Begin a new interaction.`,
        errorCode: 'not-connected',
      }
    }

    const freeze = await this.captureTool(active.session, 'react_profile_stop', {})
    const trackingFrozen = freeze.status === 'ok' && recordOf(freeze.result)?.tracking === false
    const boundaryProbe = await this.captureTool(active.session, 'react_get_renders', {
      sort: 'renders',
      limit: 1,
      appOnly: false,
    })
    const stopResult = recordOf(boundaryProbe.result)
    const stopDocumentCommitId = numberField(stopResult, 'documentCommitId')

    const settle = await this.options.settle(
      active.session,
      input.domains,
      input.quietMs,
      input.timeoutMs,
    )
    const renders = await this.captureTool(active.session, 'react_get_renders', {
      sort: 'renders',
      limit: 100,
      appOnly: false,
    })
    const causes = await this.captureTool(active.session, 'react_render_causes', {
      limit: 200,
      appOnly: false,
    })
    const effectTool = hasTool(active.session, 'react_effect_timeline')
      ? 'react_effect_timeline'
      : 'react_effect_events'
    const effects = await this.captureTool(active.session, effectTool, {
      ...(active.startDocumentCommitId === null
        ? {}
        : { afterDocumentCommitId: active.startDocumentCommitId }),
      limit: 200,
    })
    const cohorts: { component: string; evidence: ToolEvidence }[] = []
    for (const component of active.components) {
      cohorts.push({
        component,
        evidence: await this.captureTool(active.session, 'react_component_cohort', {
          component,
          exact: false,
          limit: 100,
        }),
      })
    }

    const renderResult = recordOf(renders.result)
    const finalDocumentCommitId = numberField(renderResult, 'documentCommitId')
    const recordedCommits =
      numberField(recordOf(freeze.result), 'commits') ?? numberField(renderResult, 'commits')
    const postInteractionCommits =
      stopDocumentCommitId === null || finalDocumentCommitId === null
        ? null
        : Math.max(0, finalDocumentCommitId - stopDocumentCommitId)
    const notComparableReasons = coverageReasons({
      active,
      trackingFrozen,
      settle,
      renders,
      causes,
      effects,
      cohorts,
    })
    const warnings = notComparableReasons.map((reason) => `Interaction evidence: ${reason}.`)
    if (postInteractionCommits !== null && postInteractionCommits > 0) {
      warnings.push(
        `${postInteractionCommits} post-interaction React commit${postInteractionCommits === 1 ? '' : 's'} occurred during settle and were excluded by the profile freeze.`,
      )
    }
    const stoppedAt = new Date().toISOString()
    const result = {
      schemaVersion: INTERACTION_SCHEMA_VERSION,
      kind: 'interaction-capture',
      interactionId: active.interactionId,
      name: active.name,
      state: 'completed',
      startedAt: active.startedAt,
      stoppedAt,
      session: sessionIdentity(active.session),
      boundary: {
        observationId: active.observationId,
        startDocumentCommitId: active.startDocumentCommitId,
        stopDocumentCommitId,
        finalDocumentCommitId,
        recordedCommits,
        postInteractionCommits,
        trackingFrozen,
        postInteractionPolicy: trackingFrozen
          ? 'excluded-by-profile-freeze'
          : 'not-excluded-profile-freeze-failed',
      },
      settle,
      sections: { renders, causes, effects, cohorts },
      coverage: {
        complete: notComparableReasons.length === 0,
        comparable: notComparableReasons.length === 0,
        notComparableReasons,
        boundary: 'profile-frozen-before-settle',
      },
      warnings,
    }
    this.active.delete(input.interactionId)
    this.completed.set(input.interactionId, result)
    while (this.completed.size > MAX_COMPLETED_INTERACTIONS) {
      const oldest = this.completed.keys().next().value as string | undefined
      if (!oldest) break
      this.completed.delete(oldest)
    }
    return { ok: true, result: structuredClone(result) }
  }

  private async captureTool(session: TSession, tool: string, args: unknown): Promise<ToolEvidence> {
    const started = Date.now()
    const capturedAt = new Date().toISOString()
    if (!hasTool(session, tool)) {
      return {
        status: 'unavailable',
        tool,
        args,
        capturedAt,
        durationMs: 0,
        error: `Tool ${tool} is not advertised by this app session.`,
      }
    }
    const response = await this.options.request(session, tool, args)
    return {
      status: response.ok ? 'ok' : 'error',
      tool,
      args,
      capturedAt,
      durationMs: Date.now() - started,
      ...(response.ok
        ? { result: response.result }
        : { error: response.error ?? `${tool} failed.` }),
    }
  }

  private noSession(sessionTarget?: string): InteractionInvocation {
    return {
      ok: false,
      error: sessionTarget
        ? this.options.unknownSessionError(sessionTarget)
        : 'No app connected. Start the dev server and open the app in a browser.',
      errorCode: sessionTarget ? 'unknown-session' : 'not-connected',
    }
  }
}

function coverageReasons(input: {
  active: ActiveInteraction<InteractionSession>
  trackingFrozen: boolean
  settle: InteractionSettleResult
  renders: ToolEvidence
  causes: ToolEvidence
  effects: ToolEvidence
  cohorts: { component: string; evidence: ToolEvidence }[]
}): string[] {
  const reasons: string[] = []
  if (!input.trackingFrozen) reasons.push('profile-freeze-failed')
  if (!input.settle.ok) reasons.push('settle-incomplete')
  for (const evidence of [input.renders, input.causes, input.effects]) {
    if (evidence.status !== 'ok') reasons.push(`${evidence.tool}-${evidence.status}`)
  }
  for (const cohort of input.cohorts) {
    if (cohort.evidence.status !== 'ok')
      reasons.push(`react_component_cohort-${cohort.evidence.status}:${cohort.component}`)
  }
  const render = recordOf(input.renders.result)
  if (render?.comparable === false) {
    const nested = Array.isArray(render.notComparableReasons)
      ? render.notComparableReasons.filter((value): value is string => typeof value === 'string')
      : []
    reasons.push(...(nested.length > 0 ? nested : ['render-evidence-not-comparable']))
  }
  const renderCoverage = render ? recordOf(render.coverage) : null
  if (renderCoverage?.complete === false) reasons.push('render-coverage-incomplete')
  const causeCoverage = recordOf(recordOf(input.causes.result)?.coverage)
  if (causeCoverage?.complete === false) reasons.push('render-cause-coverage-incomplete')
  const effectCoverage = recordOf(recordOf(input.effects.result)?.coverage)
  if (effectCoverage?.complete === false) reasons.push('effect-coverage-incomplete')
  const resultObservation = recordOf(render?.observation)
  const resultObservationId = stringField(resultObservation, 'id')
  if (
    input.active.observationId !== null &&
    resultObservationId !== null &&
    resultObservationId !== input.active.observationId
  ) {
    reasons.push('observation-id-mismatch')
  }
  return [...new Set(reasons)]
}

function sessionIdentity(session: InteractionSession): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    ...(session.logicalSessionId === undefined
      ? {}
      : { logicalSessionId: session.logicalSessionId }),
    ...(session.documentGeneration === undefined
      ? {}
      : { documentGeneration: session.documentGeneration }),
    ...(session.sessionName === undefined ? {} : { sessionName: session.sessionName }),
    app: session.app,
  }
}

function hasTool(session: InteractionSession, tool: string): boolean {
  return session.tools.some((descriptor) => descriptor.name === tool)
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' ? value : null
}

function invalidArguments(
  tool: string,
  error: { issues: Parameters<typeof formatToolValidationError>[1] },
): InteractionInvocation {
  return {
    ok: false,
    error: formatToolValidationError(tool, error.issues),
    errorCode: 'invalid-args',
  }
}
