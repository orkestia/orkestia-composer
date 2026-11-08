// Deterministic auto-layering, as in `@orkestia/workflows` (layering.ts): longest-path levelling over the step
// dependency graph, ties broken by authoring order (so an unchanged recipe
// compiles to the same bytes), and a group (a "Repeat" layer) kept as one layer.

export interface LayerRecord {
  name: string
  deps: Set<string>
  seq: number
  groupId?: string
}

export class CycleError extends Error {
  constructor(readonly steps: string[]) {
    super(`These steps wait on each other: ${steps.join(', ')}`)
  }
}

export interface OrderedLayer<T extends LayerRecord> {
  level: number
  groupId?: string
  steps: T[]
}

export function assignLayers<T extends LayerRecord>(records: T[]): OrderedLayer<T>[] {
  const byName = new Map(records.map((r) => [r.name, r]))
  // A dep on another member of the same group is the previous round's value
  // (the engine unrolls loops), not an ordering edge.
  const depsOf = (r: T) => [...r.deps].filter((d) => byName.has(d) && !(r.groupId && byName.get(d)?.groupId === r.groupId))

  const level = new Map<string, number>(records.map((r) => [r.name, 0]))
  const maxIters = records.length * records.length + 16
  let changed = true
  for (let iters = 0; changed; iters++) {
    if (iters > maxIters) throw new CycleError(records.map((r) => r.name))
    changed = false
    for (const r of records) {
      let base = 0
      for (const dep of depsOf(r)) base = Math.max(base, (level.get(dep) ?? 0) + 1)
      if (base > (level.get(r.name) ?? 0)) { level.set(r.name, base); changed = true }
    }
    const groups = new Set(records.map((r) => r.groupId).filter((g): g is string => !!g))
    for (const gid of groups) {
      const members = records.filter((r) => r.groupId === gid)
      const m = Math.max(...members.map((r) => level.get(r.name) ?? 0))
      for (const r of members) if ((level.get(r.name) ?? 0) < m) { level.set(r.name, m); changed = true }
    }
  }
  for (const r of records) {
    for (const dep of depsOf(r)) {
      if ((level.get(dep) ?? 0) >= (level.get(r.name) ?? 0)) throw new CycleError([dep, r.name])
    }
  }

  interface Bucket { level: number; minSeq: number; groupId?: string; steps: T[] }
  const buckets = new Map<string, Bucket>()
  for (const r of records) {
    const lvl = level.get(r.name) ?? 0
    const key = r.groupId ? `grp:${r.groupId}` : `lvl:${lvl}`
    let b = buckets.get(key)
    if (!b) { b = { level: lvl, minSeq: r.seq, groupId: r.groupId, steps: [] }; buckets.set(key, b) }
    b.steps.push(r)
    b.level = Math.max(b.level, lvl)
    b.minSeq = Math.min(b.minSeq, r.seq)
  }
  const ordered = [...buckets.values()].sort((a, b) => a.level - b.level || a.minSeq - b.minSeq)
  for (const b of ordered) b.steps.sort((x, y) => x.seq - y.seq)
  return ordered.map((b) => ({ level: b.level, groupId: b.groupId, steps: b.steps }))
}

/** One loop among the records' dependencies (names in order), or null. For saying which steps wait on each other. */
export function findCycle<T extends LayerRecord>(records: T[]): string[] | null {
  const byName = new Map(records.map((r) => [r.name, r]))
  const state = new Map<string, 1 | 2>()
  const path: string[] = []
  const visit = (name: string): string[] | null => {
    state.set(name, 1)
    path.push(name)
    const r = byName.get(name)!
    for (const dep of r.deps) {
      const d = byName.get(dep)
      if (!d || (r.groupId && d.groupId === r.groupId)) continue
      if (state.get(dep) === 1) return path.slice(path.indexOf(dep))
      if (!state.has(dep)) { const found = visit(dep); if (found) return found }
    }
    path.pop()
    state.set(name, 2)
    return null
  }
  for (const r of records) if (!state.has(r.name)) { const c = visit(r.name); if (c) return c.reverse() }
  return null
}
