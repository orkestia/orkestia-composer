/**
 * Layered graph layout via dagre. Pure function: given (nodes, edges, dims)
 * it returns the same nodes with x/y positions filled in.
 */
import dagre from 'dagre'
import { Position, type Edge, type Node } from '@xyflow/react'

export type LayoutDirection = 'TB' | 'LR'

export function layoutGraph<T extends Record<string, unknown>>(
  nodes: Node<T>[],
  edges: Edge[],
  opts: {
    direction?: LayoutDirection
    nodeWidth?: number
    nodeHeight?: number
    rankSep?: number
    nodeSep?: number
  } = {},
  /** Per-node manual position overrides (top-left coords). When a node id is
   *  present, dagre's computed position is ignored — lets the user drag nodes
   *  and have that arrangement survive a re-layout / live step addition. */
  manualPositions?: Record<string, { x: number; y: number }>,
): Node<T>[] {
  const direction = opts.direction ?? 'TB'
  const nodeWidth = opts.nodeWidth ?? 200
  const nodeHeight = opts.nodeHeight ?? 56
  const rankSep = opts.rankSep ?? 54
  const nodeSep = opts.nodeSep ?? 24

  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: direction, nodesep: nodeSep, ranksep: rankSep })

  for (const n of nodes) {
    const w = (n.style?.width as number | undefined) ?? nodeWidth
    const h = (n.style?.height as number | undefined) ?? nodeHeight
    g.setNode(n.id, { width: w, height: h })
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target)
  }

  dagre.layout(g)

  return nodes.map((n) => {
    const pos = g.node(n.id)
    const w = (n.style?.width as number | undefined) ?? nodeWidth
    const h = (n.style?.height as number | undefined) ?? nodeHeight
    const manual = manualPositions?.[n.id]
    return {
      ...n,
      // dagre returns center coordinates; React Flow uses top-left. A saved
      // manual position (already top-left) wins over the computed one.
      position: manual ?? { x: pos.x - w / 2, y: pos.y - h / 2 },
      sourcePosition: direction === 'LR' ? Position.Right : Position.Bottom,
      targetPosition: direction === 'LR' ? Position.Left : Position.Top,
    }
  })
}
