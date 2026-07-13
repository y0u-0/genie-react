import { type Fiber, isCompositeFiber, isHostFiber, type RenderPhase } from 'bippy'
import { type CommitWorkBudget, consumeCommitWork } from './commit-budget'
import { domForFiber, nameOf, registerFiber } from './fiber'

export type LogicalIdentityEvidence = 'keyed' | 'positional' | 'unknown'
export type MountGenerationEvidence = 'exact' | 'inferred' | 'unknown'

export interface InstanceParent {
  fiberId: number
  name: string
  key: string | null
}

export interface InstanceDescriptor {
  /** Physical React Fiber identity, stable across current/alternate buffer swaps. */
  fiberId: number
  /** One physical mount in this browser document. */
  mountId: string
  key: string | null
  siblingIndex: number | null
  parent: InstanceParent | null
  keyedParent: InstanceParent | null
  logicalPath: string
  logicalIdentityEvidence: LogicalIdentityEvidence
  mountGeneration: number
  mountGenerationEvidence: MountGenerationEvidence
  /** Best-effort host locator. Null when no host exists or the instance has unmounted. */
  hostSelector: string | null
}

export interface InstanceTombstone {
  componentName: string
  observationId: string
  profileCommitId: number
  documentCommitId: number
  instance: InstanceDescriptor
}

export interface PreparedInstanceRender {
  instance: InstanceDescriptor
  publish: () => void
}

const ANCESTRY_LIMIT = 50
const SIBLING_SCAN_LIMIT = 2_000
const TOMBSTONE_LIMIT = 1_000
const GENERATION_HISTORY_LIMIT = 10_000

let mountSequence = 0
let activeObservationId: string | null = null
const liveInstances = new Map<number, InstanceDescriptor>()
const generationsByPath = new Map<string, number>()
const observedInstanceIds = new Set<number>()
const tombstones: InstanceTombstone[] = []
let droppedTombstones = 0
let excludedLifecycleFibers = 0
let generationHistoryEvictions = 0

/** Reset only the measurement cohort. Physical mount identity intentionally survives a clear. */
export function beginInstanceObservation(observationId: string): void {
  activeObservationId = observationId
  observedInstanceIds.clear()
  tombstones.length = 0
  droppedTombstones = 0
  excludedLifecycleFibers = 0
}

export function noteInstanceRender(
  fiber: Fiber,
  phase: RenderPhase,
  profileCommitId: number,
  documentCommitId: number,
  budget?: CommitWorkBudget,
): InstanceDescriptor {
  const prepared = prepareInstanceRender(fiber, phase, profileCommitId, documentCommitId, budget)
  prepared.publish()
  return prepared.instance
}

/** Prepare identity and lifecycle evidence without mutating shared stores. */
export function prepareInstanceRender(
  fiber: Fiber,
  phase: RenderPhase,
  profileCommitId: number,
  documentCommitId: number,
  budget?: CommitWorkBudget,
): PreparedInstanceRender {
  if (phase === 'unmount') {
    const prepared = prepareInstanceDescription(fiber, false, true, budget)
    const observationId = activeObservationId
    const componentName = nameOf(fiber)
    let published = false
    return {
      instance: prepared.instance,
      publish() {
        if (published) return
        published = true
        prepared.publish()
        liveInstances.delete(prepared.instance.fiberId)
        observedInstanceIds.delete(prepared.instance.fiberId)
        if (!observationId) return
        tombstones.push({
          componentName,
          observationId,
          profileCommitId,
          documentCommitId,
          instance: prepared.instance,
        })
        if (tombstones.length > TOMBSTONE_LIMIT) {
          tombstones.shift()
          droppedTombstones += 1
        }
      },
    }
  }

  const prepared = prepareInstanceDescription(fiber, phase === 'mount', false, budget)
  let published = false
  return {
    instance: prepared.instance,
    publish() {
      if (published) return
      published = true
      prepared.publish()
      observedInstanceIds.add(prepared.instance.fiberId)
    },
  }
}

/** Ensure a mounted Fiber has an identity, without claiming that its mount was observed. */
export function instanceForMountedFiber(
  fiber: Fiber,
  budget?: CommitWorkBudget,
): InstanceDescriptor {
  const prepared = prepareInstanceDescription(fiber, false, false, budget)
  prepared.publish()
  return prepared.instance
}

/** Add the current nearest host selector only when a report needs it. */
export function instanceForReport(fiber: Fiber): InstanceDescriptor {
  const prepared = prepareInstanceDescription(fiber, false, false)
  prepared.publish()
  const instance = prepared.instance
  return { ...instance, hostSelector: hostSelectorFor(fiber) }
}

export function wasInstanceObserved(instanceId: number): boolean {
  return observedInstanceIds.has(instanceId)
}

export function getInstanceTombstones(): readonly InstanceTombstone[] {
  return tombstones
}

export function getInstanceIdentityCoverage(): {
  droppedTombstones: number
  excludedLifecycleFibers: number
  generationHistoryEvictions: number
} {
  return { droppedTombstones, excludedLifecycleFibers, generationHistoryEvictions }
}

/** Remove HMR-invalidated identity without claiming a user-visible unmount in the cohort. */
export function discardExcludedInstanceUnmount(fiber: Fiber): void {
  const fiberId = registerFiber(fiber) as number
  liveInstances.delete(fiberId)
  observedInstanceIds.delete(fiberId)
  excludedLifecycleFibers += 1
}

/** Invalidate identities across a refresh commit whose synthetic lifecycle cannot be reported exactly. */
export function invalidateLiveInstancesForRefresh(): void {
  excludedLifecycleFibers += liveInstances.size
  liveInstances.clear()
  observedInstanceIds.clear()
}

export function clearInstanceIdentityForTests(): void {
  mountSequence = 0
  activeObservationId = null
  liveInstances.clear()
  generationsByPath.clear()
  observedInstanceIds.clear()
  tombstones.length = 0
  droppedTombstones = 0
  excludedLifecycleFibers = 0
  generationHistoryEvictions = 0
}

function prepareInstanceDescription(
  fiber: Fiber,
  mountObserved: boolean,
  captureHostSelector: boolean,
  budget?: CommitWorkBudget,
): PreparedInstanceRender {
  const fiberId = registerFiber(fiber) as number
  const structure = structuralIdentity(fiber, budget)
  const existing = liveInstances.get(fiberId)
  if (existing) {
    const instance = captureHostSelector
      ? {
          ...existing,
          hostSelector: consumeCommitWork(budget, 'host-selector')
            ? (hostSelectorFor(fiber) ?? existing.hostSelector)
            : existing.hostSelector,
        }
      : ({
          ...existing,
          ...structure,
          mountGenerationEvidence:
            existing.mountGenerationEvidence === 'unknown'
              ? 'unknown'
              : mountObserved || existing.mountGenerationEvidence === 'exact'
                ? 'exact'
                : 'inferred',
          hostSelector: existing.hostSelector,
        } satisfies InstanceDescriptor)
    return {
      instance,
      publish: () => liveInstances.set(fiberId, instance),
    }
  }

  const previousGeneration = generationsByPath.get(structure.logicalPath)
  const mountGeneration = (previousGeneration ?? 0) + 1
  const willEvict =
    previousGeneration === undefined && generationsByPath.size >= GENERATION_HISTORY_LIMIT
  const created: InstanceDescriptor = {
    fiberId,
    mountId: `mount:${mountSequence + 1}`,
    ...structure,
    mountGeneration,
    mountGenerationEvidence:
      previousGeneration === undefined && (generationHistoryEvictions > 0 || willEvict)
        ? 'unknown'
        : mountObserved
          ? 'exact'
          : 'inferred',
    hostSelector:
      captureHostSelector && consumeCommitWork(budget, 'host-selector')
        ? hostSelectorFor(fiber)
        : null,
  }
  let published = false
  return {
    instance: created,
    publish() {
      if (published) return
      published = true
      generationsByPath.delete(structure.logicalPath)
      generationsByPath.set(structure.logicalPath, mountGeneration)
      if (generationsByPath.size > GENERATION_HISTORY_LIMIT) {
        const oldest = generationsByPath.keys().next().value
        if (typeof oldest === 'string') generationsByPath.delete(oldest)
        generationHistoryEvictions += 1
      }
      mountSequence += 1
      liveInstances.set(fiberId, created)
    },
  }
}

function structuralIdentity(
  fiber: Fiber,
  budget?: CommitWorkBudget,
): Pick<
  InstanceDescriptor,
  'key' | 'siblingIndex' | 'parent' | 'keyedParent' | 'logicalPath' | 'logicalIdentityEvidence'
> {
  const key = typeof fiber.key === 'string' ? fiber.key : null
  const siblingIndex = indexAmongSiblings(fiber, budget)
  const keyUnique = key !== null && isUniqueSiblingKey(fiber, key, budget)
  const parentFiber = nearestComposite(fiber.return, budget)
  const keyedParentFiber = nearestKeyedComposite(fiber.return, budget)

  const lineage: Fiber[] = []
  let current: Fiber | null = fiber
  while (current && lineage.length < ANCESTRY_LIMIT) {
    if (!consumeCommitWork(budget, 'instance-ancestry')) break
    if (isCompositeFiber(current) || isHostFiber(current)) lineage.push(current)
    current = current.return
  }
  lineage.reverse()

  let evidence: LogicalIdentityEvidence = keyUnique
    ? 'keyed'
    : siblingIndex === null
      ? 'unknown'
      : 'positional'
  const segments = lineage.map((node) => {
    const nodeKey = typeof node.key === 'string' ? node.key : null
    const nodeIndex = indexAmongSiblings(node, budget)
    if (nodeKey !== null && isUniqueSiblingKey(node, nodeKey, budget)) {
      return `${identityName(node)}[key=${JSON.stringify(nodeKey)}]`
    }
    if (nodeIndex === null) evidence = 'unknown'
    return `${identityName(node)}[index=${nodeIndex ?? '?'}]`
  })
  if (current) evidence = 'unknown'

  return {
    key,
    siblingIndex,
    parent: parentFiber ? parentOf(parentFiber) : null,
    keyedParent: keyedParentFiber ? parentOf(keyedParentFiber) : null,
    logicalPath: segments.join(' > '),
    logicalIdentityEvidence: evidence,
  }
}

function identityName(fiber: Fiber): string {
  return isHostFiber(fiber) && typeof fiber.type === 'string' ? `<${fiber.type}>` : nameOf(fiber)
}

function parentOf(fiber: Fiber): InstanceParent {
  return {
    fiberId: registerFiber(fiber) as number,
    name: nameOf(fiber),
    key: typeof fiber.key === 'string' ? fiber.key : null,
  }
}

function nearestComposite(fiber: Fiber | null, budget?: CommitWorkBudget): Fiber | null {
  let current = fiber
  while (current && !isCompositeFiber(current)) {
    if (!consumeCommitWork(budget, 'instance-ancestry')) return null
    current = current.return
  }
  return current
}

function nearestKeyedComposite(fiber: Fiber | null, budget?: CommitWorkBudget): Fiber | null {
  let current = fiber
  while (current) {
    if (!consumeCommitWork(budget, 'instance-ancestry')) return null
    if (isCompositeFiber(current) && typeof current.key === 'string') return current
    current = current.return
  }
  return null
}

function indexAmongSiblings(fiber: Fiber, budget?: CommitWorkBudget): number | null {
  const first = fiber.return?.child
  if (!first) return fiber.return ? null : 0
  let current: Fiber | null = first
  let index = 0
  while (current && index < SIBLING_SCAN_LIMIT) {
    if (!consumeCommitWork(budget, 'instance-siblings')) return null
    if (current === fiber || current.alternate === fiber || current === fiber.alternate)
      return index
    current = current.sibling
    index += 1
  }
  return null
}

function isUniqueSiblingKey(fiber: Fiber, key: string, budget?: CommitWorkBudget): boolean {
  const first = fiber.return?.child
  if (!first) return false
  let current: Fiber | null = first
  let matches = 0
  let scanned = 0
  while (current && scanned < SIBLING_SCAN_LIMIT) {
    if (!consumeCommitWork(budget, 'instance-siblings')) return false
    if (current.key === key) matches += 1
    if (matches > 1) return false
    current = current.sibling
    scanned += 1
  }
  return current === null && matches === 1
}

function hostSelectorFor(fiber: Fiber): string | null {
  try {
    return domForFiber(fiber, { limit: 1 }).elements[0]?.selector ?? null
  } catch {
    return null
  }
}
