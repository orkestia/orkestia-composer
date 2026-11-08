// The recipe as a graph for the diagram: one node per step and per wrapping
// block (Only if / For each / Repeat, which hold their steps), the "Starts
// with" answers and the "Returns", and wires for what runs after what (the
// compiler's dependencies) and, on request, for which result feeds which field.
// Pure: positions are the canvas's business (ui/diagram/layout.ts).
import type { Catalog } from './catalog'
import { compile, type CompileResult } from './compile'
import { whyWaits } from './edit'
import { allSteps, findBlock, refsOf, walk, conditionRefs, type Block, type Recipe, type Ref } from './recipe'

export const INPUTS = '__inputs'
export const RETURNS = '__returns'

export type NodeKind = 'inputs' | 'returns' | 'step' | 'if' | 'foreach' | 'repeat'

export interface DiagramNode {
  id: string
  kind: NodeKind
  /** The visible container this node sits in (null = the canvas). */
  parent: string | null
  /** A container drawn as one box, its steps hidden. */
  collapsed?: boolean
  /** Steps inside a container, for its summary. */
  stepCount?: number
  /** Run round (0-based) the compiler put it in. */
  round?: number
  /** Other steps run in the same round (at the same time). */
  parallel?: boolean
  /** Inside an expanded nested workflow: shown, never edited here. */
  nested?: { host: string; blockId: string }
  /** A step running another workflow, opened inline (its steps are this node's children). */
  expanded?: boolean
}

export type EdgeKind = 'order' | 'after' | 'data' | 'condition' | 'list'

export interface DiagramEdge {
  id: string
  from: string
  to: string
  kind: EdgeKind
  /** Data wires: `out:<path>` on the producer, `in:<field>` on the consumer. */
  fromPort?: string
  toPort?: string
  label?: string
  /** Only for laying out (start → first steps, last steps → returns). */
  layoutOnly?: boolean
}

export interface Diagram {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
  /** Block id → the node standing for it (itself, or a collapsed container around it). */
  rep: Map<string, string>
}

export interface DiagramOptions {
  collapsed?: Set<string>
  /** Show only what's inside this container (drilled in). */
  root?: string | null
  /** Draw data wires (output → input). */
  data?: boolean
  /** Steps running another workflow that are opened inline, with that workflow as a recipe. */
  nested?: Record<string, Recipe>
  compiled?: CompileResult
}

export function buildDiagram(recipe: Recipe, catalog: Catalog, options: DiagramOptions = {}): Diagram {
  const compiled = options.compiled ?? compile(recipe, catalog)
  const collapsed = options.collapsed ?? new Set<string>()
  const nodes: DiagramNode[] = []
  const rep = new Map<string, string>()
  // A block's round is its own saved step's (not the hidden text helpers that run before it).
  const round = new Map<string, number>()
  const members: Array<Set<string>> = []
  compiled.definition.layers.forEach((layer, i) => {
    members[i] = new Set()
    for (const st of layer.steps) {
      const owner = compiled.owners[st.name]
      const helper = (st.metadata?.builder as { text?: boolean } | undefined)?.text
      if (!owner || helper) continue
      round.set(owner, i)
      members[i].add(owner)
    }
  })
  const together = (id: string) => { const r = round.get(id); return r !== undefined && members[r].size > 1 }

  // Which blocks are on the canvas: everything, or only inside the drilled-in container.
  let top: Block[] = recipe.blocks
  if (options.root) {
    const found = findBlock(recipe.blocks, options.root)
    if (found && found.block.kind !== 'step') top = found.block.blocks
  }

  const visibleInputs = recipe.inputs.filter((i) => !i.hidden)
  if (visibleInputs.length) nodes.push({ id: INPUTS, kind: 'inputs', parent: null })

  const place = (blocks: Block[], parent: string | null, hiddenUnder: string | null) => {
    for (const b of blocks) {
      if (hiddenUnder) { rep.set(b.id, hiddenUnder); if (b.kind !== 'step') place(b.blocks, null, hiddenUnder); continue }
      rep.set(b.id, b.id)
      if (b.kind === 'step') {
        const inner = options.nested?.[b.id]
        nodes.push({ id: b.id, kind: 'step', parent, round: round.get(b.id), parallel: together(b.id), ...(inner ? { expanded: true, stepCount: allSteps(inner.blocks).length } : {}) })
        if (inner) placeNested(b.id, inner)
        continue
      }
      const isCollapsed = collapsed.has(b.id)
      nodes.push({ id: b.id, kind: b.kind, parent, round: round.get(b.id), stepCount: allSteps(b.blocks).length, ...(isCollapsed ? { collapsed: true } : {}) })
      place(b.blocks, b.id, isCollapsed ? b.id : null)
    }
  }

  const edges: DiagramEdge[] = []
  const placeNested = (host: string, inner: Recipe) => {
    const id = (blockId: string) => `${host}::${blockId}`
    const visit = (blocks: Block[], parent: string) => {
      for (const b of blocks) {
        nodes.push({ id: id(b.id), kind: b.kind, parent, nested: { host, blockId: b.id }, ...(b.kind !== 'step' ? { stepCount: allSteps(b.blocks).length } : {}) })
        if (b.kind !== 'step') visit(b.blocks, id(b.id))
      }
    }
    visit(inner.blocks, host)
    for (const d of compile(inner, catalog).deps) edges.push({ id: `n:${host}:${d.from}>${d.to}`, from: id(d.from), to: id(d.to), kind: 'order' })
  }
  place(top, null, null)

  if (recipe.returns.length && !options.root) nodes.push({ id: RETURNS, kind: 'returns', parent: null })

  // ---- What runs after what ----
  const seen = new Set<string>()
  const order: DiagramEdge[] = []
  for (const d of compiled.deps) {
    const from = rep.get(d.from)
    const to = rep.get(d.to)
    if (!from || !to || from === to) continue
    const key = `${from}>${to}`
    if (seen.has(key)) continue
    seen.add(key)
    const why = whyWaits(recipe, catalog, d.from, d.to)
    order.push({ id: `o:${key}`, from, to, kind: why === 'after' ? 'after' : why === 'data' ? 'data' : why === 'list' ? 'list' : why === 'condition' ? 'condition' : 'order' })
  }
  edges.push(...reduce(order))

  // ---- Data wires ----
  if (options.data) {
    const stepPort = (ref: Ref): { from: string; port?: string } | null => {
      if (ref.kind === 'input') return nodes.some((n) => n.id === INPUTS) ? { from: INPUTS, port: `out:${ref.name}` } : null
      if (ref.kind === 'step') {
        const r = rep.get(ref.step)
        return r ? { from: r, ...(r === ref.step ? { port: `out:${ref.path || '*'}` } : {}) } : null
      }
      const r = rep.get(ref.loop)
      return r ? { from: r, ...(r === ref.loop ? { port: 'item' } : {}) } : null
    }
    const add = (src: { from: string; port?: string }, to: string, toPort: string | undefined, label: string) => {
      if (src.from === to) return
      edges.push({ id: `d:${src.from}:${src.port ?? ''}>${to}:${toPort ?? ''}`, from: src.from, to, kind: 'data', fromPort: src.port, toPort, label })
    }
    const consumers = new Set(nodes.map((n) => n.id))
    walk(top, (b) => {
      const to = rep.get(b.id)
      if (!to || !consumers.has(to)) return
      const own = to === b.id
      if (b.kind === 'step') {
        for (const [field, value] of Object.entries(b.fields)) {
          for (const ref of refsOf(value)) {
            const src = stepPort(ref)
            if (src) add(src, to, own ? `in:${field}` : undefined, field)
          }
        }
      } else if (b.kind === 'foreach' && b.list) {
        const src = stepPort(b.list)
        if (src) add(src, to, own ? 'list' : undefined, 'list')
      } else if (b.kind === 'if' || b.kind === 'repeat') {
        const cond = b.kind === 'if' ? b.condition : b.until
        for (const ref of conditionRefs(cond)) {
          const src = stepPort(ref)
          if (src) add(src, to, own ? 'cond' : undefined, b.kind === 'if' ? 'decides' : 'stops')
        }
      }
    })
    if (nodes.some((n) => n.id === RETURNS)) {
      for (const ret of recipe.returns) for (const ref of refsOf(ret.value)) {
        const src = stepPort(ref)
        if (src) add(src, RETURNS, `in:${ret.name}`, ret.name)
      }
    }
  }

  // ---- Layout hints: answers first, returns last ----
  const level = nodes.filter((n) => n.parent === null && n.kind !== 'inputs' && n.kind !== 'returns').map((n) => n.id)
  const incoming = new Set(edges.filter((e) => !e.layoutOnly).map((e) => topOf(nodes, e.to)))
  const outgoing = new Set(edges.filter((e) => !e.layoutOnly).map((e) => topOf(nodes, e.from)))
  if (nodes.some((n) => n.id === INPUTS)) for (const id of level) if (!incoming.has(id)) edges.push({ id: `l:${INPUTS}>${id}`, from: INPUTS, to: id, kind: 'order', layoutOnly: true })
  if (nodes.some((n) => n.id === RETURNS)) for (const id of level) if (!outgoing.has(id)) edges.push({ id: `l:${id}>${RETURNS}`, from: id, to: RETURNS, kind: 'order', layoutOnly: true })

  return { nodes, edges, rep }
}

/** A block in a few words: a step's title, or what a wrapping block does. */
export function blockTitle(block: Block): string {
  if (block.kind === 'step') return block.title
  if (block.kind === 'foreach') return `For each ${block.as || 'item'}`
  if (block.kind === 'if') return 'Only if'
  return `Repeat up to ${block.max}×`
}

/** The canvas-level node a node sits under. */
export function topOf(nodes: DiagramNode[], id: string): string {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  let at = byId.get(id)
  while (at?.parent) at = byId.get(at.parent)
  return at?.id ?? id
}

/**
 * Wires to paint. The hints that only push "Starts with" to the front and
 * "Returns" to the end stay in the layout, but a large diagram does not draw
 * them: one wire per loose step becomes a fan the window cannot paint.
 */
export function paintedEdges(edges: DiagramEdge[], nodeCount: number): DiagramEdge[] {
  if (nodeCount <= 40) return edges
  return edges.filter((e) => !e.layoutOnly)
}

/** Drop wires implied by others (A→C when A→B→C), except ones the person drew. */
function reduce(edges: DiagramEdge[]): DiagramEdge[] {
  const next = new Map<string, string[]>()
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to])
  const reachableAvoiding = (from: string, to: string): boolean => {
    const stack = (next.get(from) ?? []).filter((n) => n !== to)
    const seen = new Set(stack)
    while (stack.length) {
      const at = stack.pop()!
      for (const n of next.get(at) ?? []) {
        if (n === to) return true
        if (!seen.has(n)) { seen.add(n); stack.push(n) }
      }
    }
    return false
  }
  return edges.filter((e) => e.kind === 'after' || !reachableAvoiding(e.from, e.to))
}
