import { describe, expect, it } from 'vitest'
import type { Diagram, DiagramNode } from '../../model/graph'
import { DAGRE_LIMIT, layoutDiagram, rankOf } from './layout'

const step = (id: string, parent: string | null = null): DiagramNode => ({ id, kind: 'step', parent })

function chain(n: number): Diagram {
  const nodes = Array.from({ length: n }, (_, i) => step(`s${i}`))
  const edges = Array.from({ length: n - 1 }, (_, i) => ({ id: `e${i}`, from: `s${i}`, to: `s${i + 1}`, kind: 'order' as const }))
  return { nodes, edges, rep: new Map() }
}

describe('diagram layout', () => {
  it('ranks a chain in order and parks a cycle after it', () => {
    expect(rankOf(['a', 'b', 'c'], [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }]).get('c')).toBe(2)
    const parked = rankOf(['a', 'b', 'c', 'd'], [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'd' },
      { source: 'd', target: 'c' },
    ])
    expect(parked.get('b')).toBe(1)
    expect(parked.get('c')).toBe(2)
    expect(parked.get('d')).toBe(2)
  })

  it('places a large workflow in columns without stacking the steps', () => {
    const n = DAGRE_LIMIT + 10
    const placed = layoutDiagram(chain(n), () => ({ w: 100, h: 40 }), 'LR')
    expect(placed.size).toBe(n)
    const first = placed.get('s0')!
    const next = placed.get('s1')!
    const last = placed.get(`s${n - 1}`)!
    expect(next.x).toBeGreaterThanOrEqual(first.x + first.w)
    expect(last.x).toBeGreaterThan(next.x)
    expect(last.y).toBe(first.y)
  })

  it('stacks steps that run together instead of drawing them on top of each other', () => {
    const n = DAGRE_LIMIT + 5
    const nodes = Array.from({ length: n }, (_, i) => step(`s${i}`))
    const placed = layoutDiagram({ nodes, edges: [], rep: new Map() }, () => ({ w: 80, h: 30 }), 'LR')
    const ys = new Set([...placed.values()].map((p) => p.y))
    expect(ys.size).toBe(n)
    for (const p of placed.values()) expect(p.x).toBe(0)
  })
})
