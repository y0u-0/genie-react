import {
  ClassComponentTag,
  type ContextDependency,
  type Fiber,
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
import { dehydrate } from '../../protocol'
import { MAX_HOOKS, type NodeId } from './contracts'
import { classifyFiber, type ResolvedSource, sourceLabel } from './source'

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
}

export interface InspectResult {
  id: NodeId
  name: string
  kind: string
  props: unknown
  state: unknown
  hooks: unknown[]
}

// Id → fiber registry. React double-buffers fibers (current/alternate swap each commit), so the id is mirrored onto both buffers and resolved via getLatestFiber to whichever is mounted; capped so a long session can't pin unmounted fibers forever.
const REGISTRY_LIMIT = 5_000
const fiberRegistry = new Map<NodeId, Fiber>()

export function registerFiber(fiber: Fiber): NodeId {
  const id = asNodeId(getFiberId(fiber))
  if (fiber.alternate) setFiberId(fiber.alternate, id)
  if (fiberRegistry.size >= REGISTRY_LIMIT && !fiberRegistry.has(id)) fiberRegistry.clear()
  fiberRegistry.set(id, fiber)
  return id
}

// Last committed FiberRoot's current fiber: the DOM-free way to find the tree (React Native has no document to seed from).
let committedRootFiber: Fiber | null = null

export function noteCommittedRoot(rootCurrent: Fiber): void {
  committedRootFiber = rootCurrent
}

export function findRootFiber(): Fiber | null {
  if (typeof document !== 'undefined') {
    const seeds: Array<Element | null> = [
      document.getElementById('root'),
      document.body,
      document.documentElement,
    ]
    for (const seed of seeds) {
      const fiber = seed ? getFiberFromHostInstance(seed) : null
      if (fiber) return climbToRoot(fiber)
    }
    for (const element of Array.from(document.querySelectorAll('body *')).slice(0, 50)) {
      const fiber = getFiberFromHostInstance(element)
      if (fiber) return climbToRoot(fiber)
    }
  }
  return committedRootFiber ? climbToRoot(committedRootFiber) : null
}

function climbToRoot(fiber: Fiber): Fiber {
  let current = getLatestFiber(fiber)
  while (current.return) current = current.return
  return current
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

function countNodes(root: Fiber, includeHost: boolean): number {
  let count = 0
  const visit = (fiber: Fiber): void => {
    let child: Fiber | null = fiber.child
    while (child) {
      if (isCompositeFiber(child) || (includeHost && isHostFiber(child))) count += 1
      visit(child)
      child = child.sibling
    }
  }
  visit(root)
  return count
}

export async function buildTree(
  root: Fiber,
  options: { depth: number; includeHost: boolean; maxNodes: number; appOnly?: boolean },
): Promise<TreeResult> {
  const entries: { node: TreeNode; fiber: Fiber }[] = []
  let depthClipped = false
  let nodeCapped = false

  const visit = (fiber: Fiber, parentId: NodeId | null, depth: number): void => {
    let child: Fiber | null = fiber.child
    while (child) {
      const composite = isCompositeFiber(child)
      const keep = composite || (options.includeHost && isHostFiber(child))
      if (keep) {
        if (entries.length >= options.maxNodes) {
          nodeCapped = true
          return
        }
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
        else if (child.child) depthClipped = true
      } else {
        visit(child, parentId, depth)
      }
      child = child.sibling
    }
  }

  visit(root, null, options.depth)
  const total = countNodes(root, options.includeHost)
  let nodes = entries.map((entry) => entry.node)

  if (options.appOnly) {
    nodes = await foldLibrarySubtrees(entries)
  }

  const truncatedBy = nodeCapped ? 'maxNodes' : depthClipped ? 'depth' : null
  return {
    rootId: nodes[0]?.id ?? null,
    nodes,
    total,
    truncated: truncatedBy !== null,
    truncatedBy,
  }
}

// Classifies each node, labels anonymous nodes by source (`cmdk.js:1998`), and folds each library subtree into its top node instead of a wall of "Anonymous".
async function foldLibrarySubtrees(
  entries: { node: TreeNode; fiber: Fiber }[],
): Promise<TreeNode[]> {
  const classes = await Promise.all(entries.map((entry) => classifyFiber(entry.fiber)))
  const libraryIds = new Set<NodeId>()
  entries.forEach((entry, index) => {
    const { source, isLibrary } = classes[index] ?? { source: null, isLibrary: false }
    entry.node.source = source
    entry.node.isLibrary = isLibrary
    if (isLibrary) libraryIds.add(entry.node.id)
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
  return entries.map((entry) => entry.node).filter((node) => !isLibraryInternal(node))
}

export function findByName(
  root: Fiber,
  query: string,
  exact: boolean,
  limit: number,
): Array<{ id: NodeId; name: string; path: string }> {
  const matches: Array<{ id: NodeId; name: string; path: string }> = []
  const needle = query.toLowerCase()

  const visit = (fiber: Fiber, ancestors: string[]): void => {
    let child: Fiber | null = fiber.child
    while (child) {
      if (matches.length >= limit) return
      if (isCompositeFiber(child)) {
        const name = nameOf(child)
        const hit = exact ? name === query : name.toLowerCase().includes(needle)
        if (hit)
          matches.push({ id: registerFiber(child), name, path: [...ancestors, name].join(' > ') })
        visit(child, [...ancestors, name])
      } else {
        visit(child, ancestors)
      }
      child = child.sibling
    }
  }

  visit(root, [])
  return matches
}

export function findFiberById(root: Fiber, id: NodeId): Fiber | null {
  const cached = fiberRegistry.get(id)
  if (cached) {
    const latest = getLatestFiber(cached)
    if (isMounted(latest, root)) return latest
    fiberRegistry.delete(id)
  }

  let found: Fiber | null = null
  const visit = (fiber: Fiber): void => {
    let child: Fiber | null = fiber.child
    while (child && !found) {
      if (registerFiber(child) === id) {
        found = child
        return
      }
      visit(child)
      child = child.sibling
    }
  }
  visit(root)
  return found ? getLatestFiber(found) : null
}

/** An effect hook's memoizedState carries its machinery (create/destroy/inst/tag); this identifies one. */
function isEffectHookState(
  v: object,
): v is { create: (...args: unknown[]) => unknown; deps: unknown } {
  return 'create' in v && typeof v.create === 'function' && 'deps' in v
}

/** Effect hooks store machinery (create/destroy/inst/tag); surface only their deps, not the internals. */
function describeHook(index: number, memoizedState: unknown, depth: number): unknown {
  if (memoizedState && typeof memoizedState === 'object' && isEffectHookState(memoizedState)) {
    return { index, kind: 'effect', deps: dehydrate(memoizedState.deps, { depth }) }
  }
  return { index, value: dehydrate(memoizedState, { depth }) }
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
  let hooks: unknown[] = []

  if (kind === 'class') {
    const instance = fiber.stateNode as { state?: unknown } | null
    state = dehydrate(instance?.state ?? fiber.memoizedState, { depth: options.depth })
  } else if (kind === 'function' || kind === 'memo' || kind === 'forwardRef') {
    hooks = hookChain(fiber).map((hook, index) =>
      describeHook(index, hook.memoizedState, options.depth),
    )
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

const attrOf = (el: Element, name: string): string | null => {
  const value = el.getAttribute?.(name)?.trim()
  return value ? value : null
}

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
  const rawText = strProp(props.children) ?? strProp(props.text)
  return {
    tag,
    selector: testId ? `[testID=${JSON.stringify(testId)}]` : tag,
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
  if (testId) return `[data-testid="${testId}"]`
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
