// Positions for the diagram, level by level so a block's steps are laid out
// inside its box first and the box then takes its place among its siblings.
// A small level uses dagre. A large one is placed by rank: dagre's solver
// runs on the UI thread, and a few hundred steps stalls the window.
import type { Edge, Node } from '@xyflow/react'
import { layoutGraph } from './graphLayout'
import type { Diagram, DiagramNode } from '../../model/graph'
import { GROUP_HEAD, GROUP_PAD, STEP_W } from './content'
import type { Direction } from './state'

export interface Placed { x: number; y: number; w: number; h: number }

/** Above this, a level is ranked in one pass instead of solved with dagre. */
export const DAGRE_LIMIT = 40

/** Longest-path rank. A cycle keeps the nodes that never settle, after the rest. */
export function rankOf(ids: string[], edges: Array<{ source: string; target: string }>): Map<string, number> {
  const incoming = new Map(ids.map((id) => [id, 0]))
  const next = new Map<string, string[]>()
  for (const e of edges) {
    if (!incoming.has(e.source) || !incoming.has(e.target) || e.source === e.target) continue
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1)
    next.set(e.source, [...(next.get(e.source) ?? []), e.target])
  }
  const rank = new Map<string, number>()
  const pending = new Map(incoming)
  const queue = ids.filter((id) => incoming.get(id) === 0)
  for (const id of queue) rank.set(id, 0)
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    const r = rank.get(id) ?? 0
    for (const to of next.get(id) ?? []) {
      rank.set(to, Math.max(rank.get(to) ?? 0, r + 1))
      const left = (pending.get(to) ?? 1) - 1
      pending.set(to, left)
      if (left === 0) queue.push(to)
    }
  }
  let max = 0
  for (const r of rank.values()) max = Math.max(max, r)
  for (const id of ids) if (!rank.has(id)) rank.set(id, max + 1)
  return rank
}

/** One column (or row) per rank. Nodes in a rank keep their order and never overlap. */
function placeByRank(
  ids: string[],
  boxes: Map<string, { w: number; h: number }>,
  edges: Array<{ source: string; target: string }>,
  direction: Direction,
  parent: string | null,
  rankSep: number,
  nodeSep: number,
  out: Map<string, Placed>,
): { w: number; h: number } {
  const rank = rankOf(ids, edges)
  const columns = new Map<number, string[]>()
  for (const id of ids) {
    const r = rank.get(id) ?? 0
    columns.set(r, [...(columns.get(r) ?? []), id])
  }
  const ranks = [...columns.keys()].sort((a, b) => a - b)
  const ox = parent ? GROUP_PAD : 0
  const oy = parent ? GROUP_HEAD : 0
  let cursor = 0
  let crossMax = 0
  for (const r of ranks) {
    let cross = 0
    let thick = 0
    for (const id of columns.get(r) ?? []) {
      const b = boxes.get(id)!
      const along = direction === 'LR'
      out.set(id, { x: (along ? cursor : cross) + ox, y: (along ? cross : cursor) + oy, w: b.w, h: b.h })
      cross += (along ? b.h : b.w) + nodeSep
      thick = Math.max(thick, along ? b.w : b.h)
    }
    cursor += thick + rankSep
    crossMax = Math.max(crossMax, cross - nodeSep)
  }
  const span = Math.max(0, cursor - rankSep)
  return direction === 'LR' ? { w: span, h: crossMax } : { w: crossMax, h: span }
}

export function layoutDiagram(diagram: Diagram, size: (node: DiagramNode) => { w: number; h: number }, direction: Direction): Map<string, Placed> {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]))
  const children = new Map<string | null, string[]>()
  for (const n of diagram.nodes) children.set(n.parent, [...(children.get(n.parent) ?? []), n.id])
  const out = new Map<string, Placed>()

  /** The ancestor of `id` that sits directly in `parent`. */
  const at = (id: string, parent: string | null): string | null => {
    let node = byId.get(id)
    while (node && node.parent !== parent) node = node.parent ? byId.get(node.parent) : undefined
    return node?.id ?? null
  }

  const level = (parent: string | null): { w: number; h: number } => {
    const ids = children.get(parent) ?? []
    const boxes = new Map<string, { w: number; h: number }>()
    for (const id of ids) {
      if (children.get(id)?.length) {
        const inner = level(id)
        boxes.set(id, { w: Math.max(inner.w + GROUP_PAD * 2, STEP_W + GROUP_PAD * 2), h: GROUP_HEAD + inner.h + GROUP_PAD })
      } else {
        boxes.set(id, size(byId.get(id)!))
      }
    }
    if (!ids.length) return { w: 0, h: 0 }
    const seen = new Set<string>()
    const edges: Edge[] = []
    for (const e of diagram.edges) {
      const from = at(e.from, parent)
      const to = at(e.to, parent)
      if (!from || !to || from === to) continue
      const key = `${from}>${to}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ id: key, source: from, target: to })
    }
    const nodes: Node[] = ids.map((id) => ({ id, position: { x: 0, y: 0 }, data: {}, style: { width: boxes.get(id)!.w, height: boxes.get(id)!.h } }))
    const rankSep = direction === 'LR' ? 72 : 56
    const nodeSep = direction === 'LR' ? 28 : 36
    if (ids.length > DAGRE_LIMIT) return placeByRank(ids, boxes, edges, direction, parent, rankSep, nodeSep, out)
    const placed = layoutGraph(nodes, edges, { direction, rankSep, nodeSep })
    const minX = Math.min(...placed.map((n) => n.position.x))
    const minY = Math.min(...placed.map((n) => n.position.y))
    let w = 0
    let h = 0
    for (const n of placed) {
      const b = boxes.get(n.id)!
      const x = n.position.x - minX + (parent ? GROUP_PAD : 0)
      const y = n.position.y - minY + (parent ? GROUP_HEAD : 0)
      out.set(n.id, { x, y, w: b.w, h: b.h })
      w = Math.max(w, n.position.x - minX + b.w)
      h = Math.max(h, n.position.y - minY + b.h)
    }
    return { w, h }
  }
  level(null)
  return out
}

/** Absolute canvas position of a node (positions of children are relative to their box). */
export function absolute(diagram: Diagram, placed: Map<string, Placed>, id: string): Placed | null {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]))
  const p = placed.get(id)
  if (!p) return null
  let x = p.x
  let y = p.y
  let parent = byId.get(id)?.parent ?? null
  while (parent) {
    const pp = placed.get(parent)
    if (!pp) break
    x += pp.x
    y += pp.y
    parent = byId.get(parent)?.parent ?? null
  }
  return { x, y, w: p.w, h: p.h }
}
