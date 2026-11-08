// What the diagram remembers apart from the recipe: what's selected, which
// blocks are folded, which nested workflows are opened inline, where you are
// (breadcrumbs, back and forward) and the view options. Kept outside the
// canvas so switching Steps ↔ Diagram or going full page loses none of it.
import { useSyncExternalStore } from 'react'

export interface Loc {
  /** The workflow (builder entry key). */
  key: string
  /** Drilled into this block (null = the whole workflow). */
  root: string | null
}

export type Direction = 'LR' | 'TB'

export interface DiagramUiState {
  selection: string[]
  /** Per workflow: folded blocks. */
  collapsed: Record<string, string[]>
  /** Per workflow: steps running another workflow, opened inline. */
  nestedOpen: Record<string, string[]>
  /** Breadcrumbs, outermost first; the last is where the canvas is. */
  stack: Loc[]
  past: Loc[][]
  future: Loc[][]
  direction: Direction
  dataWires: boolean
  technical: boolean
  palette: boolean
  search: boolean
}

const PREFS = 'builder.diagram.prefs'
type Prefs = Pick<DiagramUiState, 'direction' | 'dataWires' | 'technical' | 'palette'>

function readPrefs(): Prefs {
  const base: Prefs = { direction: 'LR', dataWires: false, technical: false, palette: true }
  try { return { ...base, ...(JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>) } } catch { return base }
}

let state: DiagramUiState = { selection: [], collapsed: {}, nestedOpen: {}, stack: [], past: [], future: [], search: false, ...readPrefs() }
const listeners = new Set<() => void>()
function set(patch: Partial<DiagramUiState>) {
  state = { ...state, ...patch }
  if ('direction' in patch || 'dataWires' in patch || 'technical' in patch || 'palette' in patch) {
    try { localStorage.setItem(PREFS, JSON.stringify({ direction: state.direction, dataWires: state.dataWires, technical: state.technical, palette: state.palette })) } catch { /* not remembered */ }
  }
  for (const l of listeners) l()
}

const same = (a: Loc[], b: Loc[]) => a.length === b.length && a.every((l, i) => l.key === b[i].key && l.root === b[i].root)

export const diagramUi = {
  get state() { return state },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },

  select(ids: string[]) { if (ids.join() !== state.selection.join()) set({ selection: ids }) },
  setOption(patch: Partial<Prefs & { search: boolean }>) { set(patch) },

  toggleCollapsed(key: string, id: string, collapsed?: boolean) {
    const now = new Set(state.collapsed[key] ?? [])
    const fold = collapsed ?? !now.has(id)
    if (fold) now.add(id); else now.delete(id)
    set({ collapsed: { ...state.collapsed, [key]: [...now] } })
  },
  setCollapsed(key: string, ids: string[]) { set({ collapsed: { ...state.collapsed, [key]: ids } }) },
  toggleNested(key: string, stepId: string) {
    const now = new Set(state.nestedOpen[key] ?? [])
    if (now.has(stepId)) now.delete(stepId); else now.add(stepId)
    set({ nestedOpen: { ...state.nestedOpen, [key]: [...now] } })
  },

  /** The workflow shown changed outside the diagram (picked from the list): start a new trail there. */
  arrive(key: string) {
    const top = state.stack.at(-1)
    if (top?.key === key) return
    // Arriving at a workflow already on the trail (a breadcrumb) keeps the trail up to it.
    const at = state.stack.findIndex((l) => l.key === key)
    set({ stack: at >= 0 ? state.stack.slice(0, at + 1) : [{ key, root: null }], selection: [] })
  },
  /** Go one level in: into a block, or into another workflow. */
  drill(loc: Loc) {
    const next = [...state.stack, loc]
    set({ past: [...state.past, state.stack], future: [], stack: next, selection: [] })
  },
  /** Jump to breadcrumb `index`. */
  crumb(index: number) {
    if (index >= state.stack.length - 1) return
    set({ past: [...state.past, state.stack], future: [], stack: state.stack.slice(0, index + 1), selection: [] })
  },
  back(): Loc | null {
    const prev = state.past.at(-1)
    if (!prev) return null
    set({ past: state.past.slice(0, -1), future: [...state.future, state.stack], stack: prev, selection: [] })
    return prev.at(-1) ?? null
  },
  forward(): Loc | null {
    const next = state.future.at(-1)
    if (!next) return null
    set({ future: state.future.slice(0, -1), past: [...state.past, state.stack], stack: next, selection: [] })
    return next.at(-1) ?? null
  },
  /** Forget a block that no longer exists (deleted, undone). */
  prune(key: string, exists: (id: string) => boolean) {
    const stack = state.stack.filter((l) => l.key !== key || !l.root || exists(l.root))
    if (!same(stack, state.stack)) set({ stack })
  },
}

export function useDiagramUi(): DiagramUiState {
  return useSyncExternalStore(diagramUi.subscribe, () => state)
}
