import {
  ClassComponentTag,
  type ContextDependency,
  type Fiber,
  type FiberRoot,
  ForwardRefTag,
  FunctionComponentTag,
  getDisplayName,
  getFiberFromHostInstance,
  getFiberId,
  getLatestFiber,
  getNearestHostFibers,
  isCompositeFiber,
  isHostFiber,
  MemoComponentTag,
  type MemoizedState,
  SimpleMemoComponentTag,
  setFiberId,
} from 'bippy'
import type { z } from 'zod'
import { dehydrate } from '../../protocol'
import { type hookEntrySchema, type hookKindSchema, MAX_HOOKS, type NodeId } from './contracts'
import {
  classifyFibersWithinBudget,
  type FiberClassification,
  type ResolvedSource,
  scheduleClassificationWarmup,
  sourceLabel,
} from './source'

type HookEntry = z.infer<typeof hookEntrySchema>

export type { NodeId }

// The sole NodeId brand cast, isolated at the bippy getFiberId seam; the nominal brand erases at runtime.
const asNodeId = (n: number): NodeId => n as NodeId

export interface TreeNode {
  id: NodeId
  parentId: NodeId | null
  name: string
  key: string | null
  kind: 'component' | 'host'
  source?: ResolvedSource | null
  isLibrary?: boolean
}

export interface TreeResult {
  rootId: NodeId | null
  nodes: TreeNode[]
  total: number
  truncated: boolean
  truncatedBy: 'depth' | 'maxNodes' | null
  filteredNote?: string
}

export interface InspectResult {
  id: NodeId
  name: string
  kind: string
  props: unknown
  state: unknown
  hooks: HookEntry[]
}

// Id → fiber registry. React double-buffers fibers (current/alternate swap each commit), so the id is mirrored onto both buffers and resolved via getLatestFiber to whichever is mounted; LRU-capped (delete+set refreshes recency) so a long session can't pin unmounted fibers forever.
const REGISTRY_LIMIT = 5_000
const fiberRegistry = new Map<NodeId, Fiber>()

const TREE_SOURCE_CLASSIFY_LIMIT = 120
const TREE_SOURCE_CLASSIFY_BUDGET_MS = 500
const UNCLASSIFIED_FIBER: FiberClassification = { source: null, isLibrary: false }

export function registerFiber(fiber: Fiber): NodeId {
  // bippy treats a stored id of 0 as absent and silently reassigns on the next read; re-reading here settles the first-ever fiber on its stable id before it is handed out.
  let id = asNodeId(getFiberId(fiber))
  if (id === 0) id = asNodeId(getFiberId(fiber))
  if (fiber.alternate) setFiberId(fiber.alternate, id)
  if (!fiberRegistry.delete(id) && fiberRegistry.size >= REGISTRY_LIMIT) {
    const oldest = fiberRegistry.keys().next().value
    if (oldest !== undefined) fiberRegistry.delete(oldest)
  }
  fiberRegistry.set(id, fiber)
  return id
}

// Live committed roots in first-committed order: the DOM-free way to find the tree (React Native has no document to seed from).
const committedRoots = new Map<FiberRoot, Fiber>()
const ROOT_CANDIDATE_SCAN_LIMIT = 100
const ROOT_SCORE_LIMIT = 2_000

// DevTools semantics: a commit whose current has no child is that root unmounting, so it stops being a candidate (and stops being retained).
export function noteCommittedRoot(root: FiberRoot): void {
  const current = root.current
  if (!current || current.child === null) {
    committedRoots.delete(root)
    return
  }
  committedRoots.set(root, current)
}

/** Test-only escape hatch: drop every tracked root. */
export function forgetCommittedRoots(): void {
  committedRoots.clear()
}

// Tree generation: bumped on every observed commit. Staying at 0 means commit delivery is unproven, which keeps the walk cache disabled rather than ever serving a stale tree.
let treeGeneration = 0

export function noteCommit(): void {
  treeGeneration += 1
}

interface TreeCacheEntry {
  generation: number
  root: Fiber
  key: string
  result: TreeResult
}

let treeCache: TreeCacheEntry | null = null

export function findRootFiber(): Fiber | null {
  const candidates = new Set<Fiber>()
  if (typeof document !== 'undefined') {
    const explicitRoot = document.getElementById('root')
    const explicitFiber = explicitRoot ? getFiberFromHostInstance(explicitRoot) : null
    if (explicitFiber) return climbToRoot(explicitFiber)
    for (const seed of [document.body, document.documentElement]) {
      const fiber = seed ? getFiberFromHostInstance(seed) : null
      if (fiber) candidates.add(climbToRoot(fiber))
    }
    for (const element of Array.from(document.querySelectorAll('body *')).slice(
      0,
      ROOT_CANDIDATE_SCAN_LIMIT,
    )) {
      const fiber = getFiberFromHostInstance(element)
      if (fiber) candidates.add(climbToRoot(fiber))
    }
  }
  for (const root of committedRoots.values()) candidates.add(climbToRoot(root))
  let selected: Fiber | null = null
  let selectedScore = -1
  for (const candidate of candidates) {
    const score = rootScore(candidate)
    if (score > selectedScore) {
      selected = candidate
      selectedScore = score
    }
  }
  return selected
}

function rootScore(root: Fiber): number {
  let score = 0
  const stack: Fiber[] = [root]
  let visited = 0
  while (stack.length > 0 && visited < ROOT_SCORE_LIMIT) {
    const fiber = stack.pop()
    if (!fiber) continue
    visited += 1
    if (fiber !== root && (isCompositeFiber(fiber) || isHostFiber(fiber))) score += 1
    if (fiber.sibling) stack.push(fiber.sibling)
    if (fiber.child) stack.push(fiber.child)
  }
  return score
}

function climbToRoot(fiber: Fiber): Fiber {
  let current = fiber
  while (current.return) current = current.return
  // Both root buffers share the FiberRoot stateNode, whose `current` names the live one — authoritative without bippy's getLatestFiber root scan.
  const fiberRoot = current.stateNode as { current?: Fiber } | null
  return fiberRoot?.current ?? current
}

function isMounted(fiber: Fiber, root: Fiber): boolean {
  let current: Fiber | null = fiber
  while (current) {
    if (current === root) return true
    current = current.return
  }
  return false
}

// react-refresh names inline components `_c`, `_c2`, … — treat those as unnamed so a memo/forwardRef wrapper's displayName (the name users actually set) can win.
const REFRESH_PLACEHOLDER = /^_c\d*$/

function realNameOf(type: unknown): string | null {
  const name = getDisplayName(type as Parameters<typeof getDisplayName>[0])
  return name && !REFRESH_PLACEHOLDER.test(name) ? name : null
}

/** memo carries its inner component on `.type`, forwardRef on `.render`. */
function unwrapped(type: unknown): unknown {
  if (typeof type !== 'object' || type === null) return null
  const wrapper = type as { type?: unknown; render?: unknown }
  return wrapper.type ?? wrapper.render ?? null
}

export function nameOf(fiber: Fiber): string {
  if (isHostFiber(fiber)) return typeof fiber.type === 'string' ? fiber.type : 'host'
  return (
    realNameOf(fiber.type) ??
    realNameOf(fiber.elementType) ??
    realNameOf(unwrapped(fiber.elementType)) ??
    realNameOf(unwrapped(fiber.type)) ??
    getDisplayName(fiber.type) ??
    getDisplayName(fiber.elementType) ??
    'Anonymous'
  )
}

function fiberKind(fiber: Fiber): string {
  switch (fiber.tag) {
    case ClassComponentTag:
      return 'class'
    case FunctionComponentTag:
      return 'function'
    case ForwardRefTag:
      return 'forwardRef'
    case MemoComponentTag:
    case SimpleMemoComponentTag:
      return 'memo'
    default:
      return isHostFiber(fiber) ? 'host' : 'other'
  }
}

/** Walk `return` links to the nearest composite (component) fiber; null when the chain is host/root-only. */
export function nearestCompositeFiber(fiber: Fiber): Fiber | null {
  let current: Fiber | null = fiber
  while (current && !isCompositeFiber(current)) current = current.return
  return current
}

export interface OwningComponent {
  fiber: Fiber
  id: NodeId
  name: string
  kind: string
  props: unknown
}

/** The component owning a DOM element (via its host fiber), or null when the element belongs to no React tree. */
export function owningComponentFor(element: Element, propsDepth: number): OwningComponent | null {
  const host = getFiberFromHostInstance(element)
  if (!host) return null
  const fiber = nearestCompositeFiber(getLatestFiber(host))
  if (!fiber) return null
  return {
    fiber,
    id: registerFiber(fiber),
    name: nameOf(fiber),
    kind: fiberKind(fiber),
    props: dehydrate(fiber.memoizedProps, { depth: propsDepth }),
  }
}

/** The one appOnly disclosure grammar every filtered read shares, so an empty result is never mistaken for "none exist"; undefined when nothing was hidden. */
export function appOnlyFilteredNote(
  shown: number,
  hidden: number,
  subject: 'components' | 'effects',
): string | undefined {
  if (hidden <= 0) return undefined
  const label = subject === 'effects' ? 'app effects' : 'components shown'
  return `${shown} ${label} (${hidden} library ${subject} hidden — set appOnly:false to include)`
}

export async function buildTree(
  root: Fiber,
  options: {
    depth: number
    includeHost: boolean
    maxNodes: number
    appOnly?: boolean
    includeRoot?: boolean
  },
): Promise<TreeResult> {
  const cacheKey = `${options.depth}|${options.maxNodes}|${options.includeHost}|${options.appOnly ?? false}|${options.includeRoot ?? false}`
  if (
    treeCache &&
    treeCache.generation === treeGeneration &&
    treeGeneration > 0 &&
    treeCache.root === root &&
    treeCache.key === cacheKey
  ) {
    return treeCache.result
  }

  const entries: { node: TreeNode; fiber: Fiber }[] = []
  let total = 0
  let depthClipped = false
  let nodeCapped = false

  // Past the depth/node caps the walk hands off to this tight counter, so one pass serves both the capped collection and the full-tree `total`.
  const countOnly = (fiber: Fiber): number => {
    let counted = 0
    let child: Fiber | null = fiber.child
    while (child) {
      if (isCompositeFiber(child) || (options.includeHost && isHostFiber(child))) {
        total += 1
        counted += 1
      }
      counted += countOnly(child)
      child = child.sibling
    }
    return counted
  }

  const visit = (fiber: Fiber, parentId: NodeId | null, depth: number): void => {
    let child: Fiber | null = fiber.child
    while (child) {
      const composite = isCompositeFiber(child)
      const keep = composite || (options.includeHost && isHostFiber(child))
      if (keep) {
        total += 1
        if (entries.length >= options.maxNodes) {
          nodeCapped = true
          countOnly(child)
        } else {
          const id = registerFiber(child)
          entries.push({
            node: {
              id,
              parentId,
              name: nameOf(child),
              key: child.key,
              kind: composite ? 'component' : 'host',
            },
            fiber: child,
          })
          if (depth > 0) visit(child, id, depth - 1)
          else {
            if (countOnly(child) > 0) depthClipped = true
          }
        }
      } else {
        visit(child, parentId, depth)
      }
      child = child.sibling
    }
  }

  if (options.includeRoot) {
    const id = registerFiber(root)
    const composite = isCompositeFiber(root)
    total += 1
    entries.push({
      node: {
        id,
        parentId: null,
        name: nameOf(root),
        key: root.key,
        kind: composite ? 'component' : 'host',
      },
      fiber: root,
    })
    if (options.depth > 0) visit(root, id, options.depth - 1)
    else if (countOnly(root) > 0) depthClipped = true
  } else {
    visit(root, null, options.depth)
  }
  let nodes = entries.map((entry) => entry.node)
  let filteredNote: string | undefined
  let classificationPartial = false

  if (options.appOnly) {
    const folded = await foldLibrarySubtrees(entries)
    nodes = folded.nodes
    classificationPartial = folded.partial
    filteredNote = appOnlyFilteredNote(nodes.length, folded.hidden, 'components')
    if (folded.partial) {
      const partialNote =
        'source classification budget reached; some library components may be shown'
      filteredNote = filteredNote ? `${filteredNote}; ${partialNote}` : partialNote
    }
  }

  const truncatedBy = nodeCapped ? 'maxNodes' : depthClipped ? 'depth' : null
  const result: TreeResult = {
    rootId: nodes[0]?.id ?? null,
    nodes,
    total,
    truncated: truncatedBy !== null,
    truncatedBy,
    ...(filteredNote ? { filteredNote } : {}),
  }
  // A partial classification can improve as source caches warm, so only complete results are worth pinning until the next commit.
  if (treeGeneration > 0 && !classificationPartial) {
    treeCache = { generation: treeGeneration, root, key: cacheKey, result }
  }
  return result
}

// Classifies each node, labels anonymous nodes by source (`cmdk.js:1998`), and folds each library subtree into its top node instead of a wall of "Anonymous"; hidden counts the folded-away library nodes.
async function foldLibrarySubtrees(
  entries: { node: TreeNode; fiber: Fiber }[],
): Promise<{ nodes: TreeNode[]; hidden: number; partial: boolean }> {
  const { classes, partial } = await classifyTreeEntries(entries)
  if (partial) scheduleClassificationWarmup(entries.map((entry) => entry.fiber))
  entries.forEach((entry, index) => {
    const { source, isLibrary } = classes[index] ?? UNCLASSIFIED_FIBER
    entry.node.source = source
    entry.node.isLibrary = isLibrary
    if (entry.node.name === 'Anonymous') {
      const label = sourceLabel(source)
      if (label) entry.node.name = label
    }
  })

  // Drop a library node whose nearest kept parent is also library: subtrees collapse to their top node while app components composed under library providers are kept.
  const byId = new Map(entries.map((entry) => [entry.node.id, entry.node]))
  const isLibraryInternal = (node: TreeNode): boolean => {
    if (!node.isLibrary) return false
    const parent = node.parentId != null ? byId.get(node.parentId) : undefined
    return parent?.isLibrary === true
  }
  const nodes = entries.map((entry) => entry.node).filter((node) => !isLibraryInternal(node))
  return { nodes, hidden: entries.length - nodes.length, partial }
}

async function classifyTreeEntries(
  entries: { node: TreeNode; fiber: Fiber }[],
): Promise<{ classes: FiberClassification[]; partial: boolean }> {
  return classifyFibersWithinBudget(
    entries.map((entry) => entry.fiber),
    { limit: TREE_SOURCE_CLASSIFY_LIMIT, budgetMs: TREE_SOURCE_CLASSIFY_BUDGET_MS },
  )
}

export interface FindMatch {
  id: NodeId
  name: string
  path: string
  fiber: Fiber
}

export function findByName(root: Fiber, query: string, exact: boolean, limit: number): FindMatch[] {
  const matches: FindMatch[] = []
  const needle = query.toLowerCase()

  // Paths are derived per hit from return links (≤limit hits), so the walk itself carries no per-node ancestor copies.
  const pathTo = (fiber: Fiber, name: string): string => {
    const names = [name]
    let current = fiber.return
    while (current && current !== root) {
      if (isCompositeFiber(current)) names.push(nameOf(current))
      current = current.return
    }
    return names.reverse().join(' > ')
  }

  const visit = (fiber: Fiber): void => {
    let child: Fiber | null = fiber.child
    while (child) {
      if (matches.length >= limit) return
      if (isCompositeFiber(child)) {
        const name = nameOf(child)
        const hit = exact ? name === query : name.toLowerCase().includes(needle)
        if (hit)
          matches.push({
            id: registerFiber(child),
            name,
            path: pathTo(child, name),
            fiber: child,
          })
      }
      visit(child)
      child = child.sibling
    }
  }

  visit(root)
  return matches
}

/** A find match's kind + shallow props preview, resolved synchronously from the fiber (source/library are classified async by the caller). */
export function matchDetail(fiber: Fiber, propsDepth: number): { kind: string; props: unknown } {
  return { kind: fiberKind(fiber), props: dehydrate(fiber.memoizedProps, { depth: propsDepth }) }
}

export function findFiberById(root: Fiber, id: NodeId): Fiber | null {
  const cached = fiberRegistry.get(id)
  if (cached) {
    // Resolving the mounted buffer via return-link climbs stays O(depth); bippy's getLatestFiber falls back to a full-root scan when profiler timings are absent. Stale entries fall through to the walk below.
    if (isMounted(cached, root)) return cached
    if (cached.alternate && isMounted(cached.alternate, root)) return cached.alternate
    fiberRegistry.delete(id)
  }

  let found: Fiber | null = null
  const visit = (fiber: Fiber): void => {
    let child: Fiber | null = fiber.child
    while (child && !found) {
      if (getFiberId(child) === id) {
        found = child
        return
      }
      visit(child)
      child = child.sibling
    }
  }
  visit(root)
  if (!found) return null
  registerFiber(found)
  return getLatestFiber(found)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** An effect hook's memoizedState carries its machinery (create/destroy/inst/tag); this identifies one and narrows `deps`/`tag`. */
function isEffectHookState(v: unknown): v is { create: unknown; deps: unknown; tag?: unknown } {
  return isObject(v) && typeof v.create === 'function' && 'deps' in v
}

// useState/useReducer are the only hooks whose sibling `queue` holds a dispatch fn; this narrows it (queue itself is typed unknown via MemoizedState's index signature).
function hasDispatchQueue(
  hook: MemoizedState,
): hook is MemoizedState & { queue: { dispatch: unknown; lastRenderedReducer?: unknown } } {
  const queue = hook.queue
  return isObject(queue) && typeof queue.dispatch === 'function'
}

// useState wires queue.lastRenderedReducer to React's internal basicStateReducer; useReducer wires the user's reducer — the only structural tell between them.
const isBasicStateReducer = (queue: { lastRenderedReducer?: unknown }): boolean => {
  const reducer = queue.lastRenderedReducer
  return typeof reducer === 'function' && reducer.name === 'basicStateReducer'
}

// A single-key { current } object is the useRef signature; useMemo/useCallback store [value, deps] arrays, checked before this so they don't fall through to ref.
const isRefState = (v: unknown): boolean =>
  isObject(v) && !Array.isArray(v) && 'current' in v && Object.keys(v).length === 1

// useMemo/useCallback both memoize as [value, depsArray]; callback when the value is a function. Best-effort: useMemo returning a function reads as callback.
const isMemoOrCallbackState = (v: unknown): v is [unknown, unknown[]] =>
  Array.isArray(v) && v.length === 2 && Array.isArray(v[1])

export type HookKind = z.infer<typeof hookKindSchema>

// React's ReactHookEffectTags (stable 16.8+/18/19): the layout bit on an effect hook's memoizedState.tag marks useLayoutEffect; a passive-only effect is useEffect.
const HOOK_LAYOUT = 0b0100

/** True for useState/useReducer hooks — the ones whose value can be driven by react_override_hook_state. Never throws. */
export function isStatefulHook(hook: MemoizedState): boolean {
  return hasDispatchQueue(hook)
}

/** Structurally classify a hook from its runtime shape (React 18/19). Never throws — unknown shapes fall to 'other'. */
export function classifyHook(hook: MemoizedState): HookKind {
  if (hasDispatchQueue(hook)) return isBasicStateReducer(hook.queue) ? 'state' : 'reducer'
  const ms = hook.memoizedState
  if (isEffectHookState(ms)) {
    return typeof ms.tag === 'number' && (ms.tag & HOOK_LAYOUT) !== 0 ? 'layout-effect' : 'effect'
  }
  if (isMemoOrCallbackState(ms)) return typeof ms[0] === 'function' ? 'callback' : 'memo'
  if (isRefState(ms)) return 'ref'
  return 'other'
}

/** One hook entry for react_inspect_component: its kind, whether it is stateful, its stateful ordinal, and its value/deps (never throws on classification). */
function describeHook(
  hook: MemoizedState,
  index: number,
  stateIndex: number | null,
  depth: number,
): HookEntry {
  const kind = classifyHook(hook)
  const ms = hook.memoizedState
  const valueOrDeps = isEffectHookState(ms)
    ? { deps: dehydrate(ms.deps, { depth }) }
    : { value: dehydrate(ms, { depth }) }
  return {
    index,
    kind,
    stateful: stateIndex !== null,
    ...(stateIndex !== null ? { stateIndex } : {}),
    ...valueOrDeps,
  }
}

/** The fiber's hook list (its memoizedState chain), capped at {@link MAX_HOOKS}. */
export function hookChain(fiber: Fiber): MemoizedState[] {
  const hooks: MemoizedState[] = []
  let hook: MemoizedState | null = fiber.memoizedState
  while (hook && hooks.length < MAX_HOOKS) {
    hooks.push(hook)
    hook = hook.next
  }
  return hooks
}

export function inspectFiber(
  fiber: Fiber,
  options: { path?: Array<string | number>; depth: number },
): InspectResult {
  const kind = fiberKind(fiber)
  const props = dehydrate(fiber.memoizedProps, { depth: options.depth, path: options.path })
  let state: unknown
  let hooks: HookEntry[] = []

  if (kind === 'class') {
    const instance = fiber.stateNode as { state?: unknown } | null
    state = dehydrate(instance?.state ?? fiber.memoizedState, { depth: options.depth })
  } else if (kind === 'function' || kind === 'memo' || kind === 'forwardRef') {
    let statefulOrdinal = 0
    hooks = hookChain(fiber).map((hook, index) => {
      const stateIndex = isStatefulHook(hook) ? statefulOrdinal++ : null
      return describeHook(hook, index, stateIndex, options.depth)
    })
  }

  return { id: asNodeId(getFiberId(fiber)), name: nameOf(fiber), kind, props, state, hooks }
}

// ── Component ↔ DOM bridge ───────────────────────────────────────────────────

export interface HostElementInfo {
  tag: string
  selector: string
  domId: string | null
  testId: string | null
  role: string | null
  ariaLabel: string | null
  name: string | null
  classes: string[]
  text: string | null
}

export interface DomForResult {
  id: NodeId
  name: string
  elements: HostElementInfo[]
  total: number
}

const isElement = (node: unknown): node is Element =>
  typeof node === 'object' && node !== null && (node as { nodeType?: number }).nodeType === 1

/** The host node(s) a component renders: DOM elements get a CSS selector, React Native views a testID/accessibility locator. */
export function domForFiber(fiber: Fiber, options: { limit: number }): DomForResult {
  const elements: HostElementInfo[] = []
  let total = 0
  const push = (info: HostElementInfo): void => {
    total += 1
    if (elements.length < options.limit) elements.push(info)
  }
  for (const host of getNearestHostFibers(fiber)) {
    if (isElement(host.stateNode)) push(describeHostElement(host.stateNode))
    else if (isNativeHostFiber(host)) push(describeNativeHostFiber(host))
  }
  return { id: asNodeId(getFiberId(fiber)), name: nameOf(fiber), elements, total }
}

const isNativeHostFiber = (fiber: Fiber): boolean =>
  typeof fiber.type === 'string' && typeof fiber.stateNode === 'object' && fiber.stateNode !== null

const strProp = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

// RN Text children are a string, a number, or an interpolation array (`Score: {count}` → ['Score: ', 42]).
const textOf = (value: unknown): string | null => {
  if (typeof value === 'string' || typeof value === 'number') return strProp(String(value))
  if (Array.isArray(value)) {
    const parts = value.filter(
      (part) => typeof part === 'string' || typeof part === 'number',
    ) as Array<string | number>
    return strProp(parts.join(''))
  }
  return null
}

const attrOf = (el: Element, name: string): string | null => strProp(el.getAttribute?.(name))

const attrSelector = (name: string, value: string): string => `[${name}=${JSON.stringify(value)}]`

const MAX_ELEMENT_TEXT = 80

/** Structural identity + a best-effort selector for one host element. Exported for tests. */
export function describeHostElement(el: Element): HostElementInfo {
  const tag = el.tagName.toLowerCase()
  const domId = attrOf(el, 'id')
  const testId = attrOf(el, 'data-testid')
  const classes = el.classList ? Array.from(el.classList) : []
  const rawText = el.textContent?.trim() ?? ''
  return {
    tag,
    selector: hostSelector(tag, domId, testId, classes),
    domId,
    testId,
    role: attrOf(el, 'role'),
    ariaLabel: attrOf(el, 'aria-label'),
    name: attrOf(el, 'name'),
    classes,
    text: rawText ? truncateText(rawText) : null,
  }
}

const truncateText = (text: string): string =>
  text.length > MAX_ELEMENT_TEXT ? `${text.slice(0, MAX_ELEMENT_TEXT)}…` : text

/** RN analog of describeHostElement. Exported for tests. */
export function describeNativeHostFiber(fiber: Fiber): HostElementInfo {
  const tag = typeof fiber.type === 'string' ? fiber.type : 'host'
  const props = (fiber.memoizedProps ?? {}) as Record<string, unknown>
  const testId = strProp(props.testID)
  const rawText = textOf(props.children) ?? textOf(props.text)
  return {
    tag,
    selector: testId ? attrSelector('testID', testId) : tag,
    domId: null,
    testId,
    role: strProp(props.accessibilityRole) ?? strProp(props.role),
    ariaLabel: strProp(props.accessibilityLabel) ?? strProp(props['aria-label']),
    name: strProp(props.nativeID),
    classes: [],
    text: rawText ? truncateText(rawText) : null,
  }
}

// Utility-framework classes (`hover:bg-x`, `md:flex`) are not valid bare selectors, so only simple tokens follow the dot; role/testId/text ride alongside for semantic locators.
const SIMPLE_CLASS = /^[a-zA-Z_][\w-]*$/

function hostSelector(
  tag: string,
  domId: string | null,
  testId: string | null,
  classes: string[],
): string {
  if (domId) return `#${domId}`
  if (testId) return attrSelector('data-testid', testId)
  const simple = classes.filter((token) => SIMPLE_CLASS.test(token)).slice(0, 3)
  return simple.length ? `${tag}.${simple.join('.')}` : tag
}

// ── Consumed React contexts ──────────────────────────────────────────────────

export interface ContextInfo {
  name: string
  value: unknown
}

export interface ContextResult {
  id: NodeId
  name: string
  contexts: ContextInfo[]
}

export interface ContextDependencyInfo {
  context: unknown
  name: string
  value: unknown
}

/** The raw consumed contexts, walking `dependencies.firstContext` directly — bippy's `traverseContexts` diffs against the alternate and reads nothing on first mount. */
export function contextDependencies(fiber: Fiber): ContextDependencyInfo[] {
  const dependencies: ContextDependencyInfo[] = []
  // StrictMode double-reads can chain the same context twice; one entry per context object keeps `override_context` unambiguous.
  const seen = new Set<unknown>()
  let node: ContextDependency<unknown> | null = fiber.dependencies?.firstContext ?? null
  while (node && typeof node === 'object' && 'memoizedValue' in node) {
    if (!seen.has(node.context)) {
      seen.add(node.context)
      dependencies.push({
        context: node.context,
        name: node.context?.displayName || 'Context',
        value: node.memoizedValue,
      })
    }
    node = node.next ?? null
  }
  return dependencies
}

export function contextsForFiber(fiber: Fiber, options: { depth: number }): ContextResult {
  const contexts = contextDependencies(fiber).map(({ name, value }) => ({
    name,
    value: dehydrate(value, { depth: options.depth }),
  }))
  return { id: asNodeId(getFiberId(fiber)), name: nameOf(fiber), contexts }
}
