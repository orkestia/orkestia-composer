// The workflow as a diagram: see it, move around it and edit it. Every edit
// goes through the same recipe as the step list (builder.update), so the two
// views are one model with one undo history; checks run on each change and
// problems show on the boxes instead of blocking anything.
import { t, plural } from '../i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange,
} from '@xyflow/react'
import {
  IcArrowLeft, IcArrowRight, IcBraces, IcChevronRight, IcCode, IcHistory, IcLock, IcPlus, IcRotateCcw, IcRotateCw, IcSearch, IcSidebarExpand, IcSidebarCollapse, IcTrash, IcX, IcChevronsUpDown,
} from '../icons'
import { popupMenu } from '../runtime'
import { toastStore } from '../runtime'
import { fieldLabel, humanize, unknownEntry, type CatalogEntry } from '../../model/catalog'
import type { Problem } from '../../model/check'
import type { CompileResult } from '../../model/compile'
import { describeRef } from '../../model/data'
import {
  addStep, connect, deleteBlocks, disconnect, duplicateBlock, insertBetween, mapData, moveInto, parallelize, placeAfter, rewire, sequence, unmapData, whyWaits,
} from '../../model/edit'
import { blockTitle, buildDiagram, paintedEdges, INPUTS, RETURNS, type DiagramEdge, type DiagramNode } from '../../model/graph'
import { allSteps, findBlock, locate, type Block, type Condition, type Recipe, type Ref, type Step } from '../../model/recipe'
import { OPS } from '../fields'
import { api, builder, type Entry } from '../store'
import { useEditor } from '../context'
import { STEP_DRAG_TYPE, StepSearch } from '../StepPicker'
import { COLLAPSED, GROUP_HEAD, GROUP_PAD, IO_W, ioHeight, STEP_W, stepContent, stepHeight } from './content'
import { Inspector, type InspectorActions } from './Inspector'
import { absolute, DAGRE_LIMIT, layoutDiagram } from './layout'
import { entryFor, nestedFor, runsWorkflow, useNestedVersion } from './nested'
import { CanvasContext, EDGE_TYPES, NODE_TYPES, type CanvasApi, type GroupNodeData, type IoNodeData, type StepNodeData, type WireData } from './nodes'
import { diagramUi, useDiagramUi } from './state'
import { ResizeHandle } from '../primitives'

export interface DiagramProps {
  entry: Entry & { recipe: Recipe }
  compiled: CompileResult
  /** Why it opened read-only (empty = editable). */
  readOnlyReasons: string[]
  /** Absent: the caller may not edit, so no "edit anyway". */
  onUnlock?: () => void
  /** Absent: the host has no assistant. */
  onDiscuss?: (ids: string[]) => void
}

export function DiagramCanvas(props: DiagramProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}

/** Rows a "Starts with" / "Returns" box shows before "+N more". */
const MAX_IO_ROWS = 12

/** Below this the boxes' words are too small to read. */
const READABLE_ZOOM = 0.66

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function condText(recipe: Recipe, catalog: ReturnType<typeof useEditor>['catalog'], c: Condition | undefined): string {
  if (!c) return ''
  if (c.kind === 'compare') {
    const op = OPS.find((o) => o.op === c.op)
    const left = c.left ? describeRef(recipe, catalog, c.left).label : '…'
    return `${left} ${op ? t(op.label) : c.op}${op?.unary ? '' : ` ${typeof c.value === 'string' ? `“${c.value}”` : JSON.stringify(c.value ?? '')}`}`
  }
  if (c.kind === 'not') return t('not ({condition})', { condition: condText(recipe, catalog, c.item) })
  return c.items.map((i) => condText(recipe, catalog, i)).join(c.kind === 'all' ? ` ${t('and')} ` : ` ${t('or')} `)
}

function Canvas({ entry, compiled, readOnlyReasons, onUnlock, onDiscuss }: DiagramProps) {
  const { recipe, catalog, problems, readOnly, numbers, runSteps, runFailures, update, pickStep } = useEditor()
  const ui = useDiagramUi()
  const nestedVersion = useNestedVersion()
  const rf = useReactFlow()
  const key = entry.key
  const wrap = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const [edgeSel, setEdgeSel] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const editable = !readOnly
  // A narrow window: the step list opens over the canvas instead of beside it.
  const workspace = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [paletteOver, setPaletteOver] = useState(false)
  useEffect(() => {
    const el = workspace.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setNarrow(el.clientWidth < 760))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const paletteShown = editable && (narrow ? paletteOver : ui.palette)
  const togglePalette = (open: boolean) => (narrow ? setPaletteOver(open) : diagramUi.setOption({ palette: open }))

  useEffect(() => { diagramUi.arrive(key) }, [key])
  // A big workflow first opens with its big blocks folded, so its shape shows; one click opens each.
  useEffect(() => {
    if (diagramUi.state.collapsed[key] || allSteps(recipe.blocks).length <= 60) return
    const big: string[] = []
    const visit = (bs: Block[]) => bs.forEach((b) => { if (b.kind !== 'step') { if (allSteps(b.blocks).length > 8) big.push(b.id); visit(b.blocks) } })
    visit(recipe.blocks)
    diagramUi.setCollapsed(key, big)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const loc = ui.stack.at(-1)
  const root = loc && loc.key === key && loc.root && findBlock(recipe.blocks, loc.root) ? loc.root : null
  const collapsedIds = ui.collapsed[key]
  const collapsed = useMemo(() => new Set(collapsedIds ?? []), [collapsedIds])
  const openNestedIds = ui.nestedOpen[key]

  // Steps running another workflow, opened inline.
  const nested = useMemo(() => {
    const out: Record<string, Recipe> = {}
    for (const id of openNestedIds ?? []) {
      const s = findBlock(recipe.blocks, id)?.block
      if (s?.kind !== 'step' || !runsWorkflow(s.workflowType)) continue
      const n = nestedFor(s.workflowType)
      if (n.status === 'ready' && n.recipe) out[id] = n.recipe
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNestedIds, recipe, nestedVersion])

  const diagram = useMemo(() => buildDiagram(recipe, catalog, { collapsed, root, data: ui.dataWires, nested, compiled }), [recipe, catalog, collapsed, root, ui.dataWires, nested, compiled])

  // Forget breadcrumbs into blocks that are gone (deleted, undone).
  useEffect(() => { diagramUi.prune(key, (id) => !!findBlock(recipe.blocks, id)) }, [key, recipe])

  const problemsAt = useMemo(() => {
    const out = new Map<string, Problem[]>()
    for (const p of problems) if (p.at) out.set(p.at, [...(out.get(p.at) ?? []), p])
    return out
  }, [problems])
  const summary = useCallback((ids: string[]) => {
    const ps = ids.flatMap((i) => problemsAt.get(i) ?? []).filter((p) => p.severity !== 'note')
    const errors = ps.filter((p) => p.severity === 'error')
    const first = errors[0] ?? ps[0]
    return { errors: errors.length, warnings: ps.length - errors.length, first: first ? (first.field ? `${fieldLabel(first.field)}: ${first.message}` : first.message) : undefined }
  }, [problemsAt])

  const nodeById = useMemo(() => new Map(diagram.nodes.map((n) => [n.id, n])), [diagram])

  /** The recipe block (or nested block) a node shows. */
  const blockOf = useCallback((n: DiagramNode): { block: Block; recipe: Recipe } | null => {
    if (n.nested) {
      const inner = nested[n.nested.host]
      const b = inner ? findBlock(inner.blocks, n.nested.blockId)?.block : null
      return b && inner ? { block: b, recipe: inner } : null
    }
    const b = findBlock(recipe.blocks, n.id)?.block
    return b ? { block: b, recipe } : null
  }, [nested, recipe])

  const q = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!ui.search || !q) return [] as string[]
    return diagram.nodes.filter((n) => {
      const b = blockOf(n)?.block
      if (!b) return false
      const text = b.kind === 'step' ? `${b.title} ${b.name} ${b.workflowType} ${(catalog.get(b.workflowType) ?? unknownEntry(b.workflowType)).app}` : blockTitle(b)
      return text.toLowerCase().includes(q)
    }).map((n) => n.id)
  }, [ui.search, q, diagram, blockOf, catalog])

  // ---- Boxes: content, size, position ----
  const built = useMemo(() => {
    const data = new Map<string, StepNodeData | GroupNodeData | IoNodeData>()
    const sizes = new Map<string, { w: number; h: number }>()
    for (const n of diagram.nodes) {
      if (n.kind === 'inputs' || n.kind === 'returns') {
        const rows = n.kind === 'inputs'
          ? recipe.inputs.filter((i) => !i.hidden).map((i) => ({ name: i.name, label: i.label || humanize(i.name), detail: `${i.name} · ${i.type}${i.required ? ` · ${t('required')}` : ''}` }))
          : recipe.returns.map((r) => ({ name: r.name, label: r.name ? humanize(r.name) : t('Unnamed'), detail: r.name }))
        // A long list of answers stays a readable box; the inspector lists them all.
        const shown = rows.slice(0, MAX_IO_ROWS)
        const more = rows.length - shown.length
        data.set(n.id, { title: n.kind === 'inputs' ? t('Starts with') : t('Returns'), rows: shown, more, data: ui.dataWires, side: n.kind === 'inputs' ? 'in' : 'out' })
        sizes.set(n.id, { w: IO_W, h: ioHeight(shown.length + (more ? 1 : 0)) })
        continue
      }
      const found = blockOf(n)
      if (!found) continue
      const { block, recipe: owner } = found
      const isNested = !!n.nested
      if (block.kind === 'step' && !n.expanded) {
        const entryOf = catalog.get(block.workflowType)
        const spec = entryOf ?? unknownEntry(block.workflowType)
        const content = stepContent(owner, catalog, block)
        const probs: { errors: number; warnings: number; first?: string } = isNested ? { errors: 0, warnings: 0 } : summary([block.id])
        const run = isNested ? undefined : runSteps[block.id]
        const runNote = isNested ? undefined : runFailures[block.id]
        const nestedInfo = runsWorkflow(block.workflowType) && !isNested ? nestedFor(block.workflowType) : null
        // A step running another workflow reads as that workflow's name when its own title says nothing.
        const vague = block.title === humanize(block.name) || block.title === spec.title || /[0-9a-f]{12,}/i.test(block.title)
        const title = nestedInfo?.title && vague ? nestedInfo.title : block.title
        data.set(n.id, {
          step: { ...block, title }, entry: spec, known: !!entryOf, content, number: isNested ? undefined : numbers.get(block.id),
          parallel: !!n.parallel, problems: probs, run, runNote,
          data: ui.dataWires, technical: ui.technical, readOnly: isNested || !editable,
          ...(nestedInfo ? { nested: { title: nestedInfo.title, status: nestedInfo.status, open: false } } : {}),
        } satisfies StepNodeData)
        sizes.set(n.id, { w: STEP_W, h: stepHeight(content, { data: ui.dataWires, technical: ui.technical, hasProblem: !!probs.first, hasRunNote: !!runNote }) })
        continue
      }
      // Wrapping blocks and opened nested workflows.
      const inner = block.kind === 'step' ? null : block
      const host = block.kind === 'step' ? block : null
      const hostInfo = host ? nestedFor(host.workflowType) : null
      const sentence = host ? <>{t('Runs')} <strong>{hostInfo?.title ?? host.title}</strong></>
        : inner!.kind === 'if' ? <><span className="dg-kw">{t('Only if')}</span> {condText(owner, catalog, inner!.condition) || t('no condition yet')}</>
        : inner!.kind === 'foreach' ? <><span className="dg-kw">{t('For each')}</span> {inner!.as || t('item')} <span className="dg-kw-soft">{t('in')}</span> {inner!.list ? describeRef(owner, catalog, inner!.list).label : t('a list (choose one)')}</>
        : <><span className="dg-kw">{t('Repeat')}</span> {t('up to {n}×', { n: inner!.max })}{inner!.until ? <> <span className="dg-kw-soft">{t('until')}</span> {condText(owner, catalog, inner!.until)}</> : null}</>
      const ids = inner ? [inner.id, ...allSteps(inner.blocks).map((s) => s.id)] : [host!.id]
      data.set(n.id, {
        block: inner, sentence, collapsed: !!n.collapsed, stepCount: n.stepCount ?? 0,
        ...(host ? { host: { step: host, entry: catalog.get(host.workflowType) ?? unknownEntry(host.workflowType), title: hostInfo?.title, status: hostInfo?.status ?? 'loading', entryKey: hostInfo?.entryKey } } : {}),
        problems: isNested ? { errors: 0, warnings: 0 } : summary(ids), run: isNested ? undefined : runSteps[n.id], readOnly: isNested || !editable, data: ui.dataWires,
      } satisfies GroupNodeData)
      sizes.set(n.id, n.collapsed ? COLLAPSED : { w: STEP_W + GROUP_PAD * 2, h: GROUP_HEAD + 56 })
    }
    const placed = layoutDiagram(diagram, (n) => sizes.get(n.id) ?? { w: STEP_W, h: 80 }, ui.direction)
    return { data, placed }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram, recipe, catalog, ui.dataWires, ui.technical, ui.direction, summary, runSteps, runFailures, numbers, editable, nestedVersion, blockOf])

  const selection = ui.selection
  const nodes = useMemo<Node[]>(() => {
    const matchSet = new Set(matches)
    const searching = !!q && ui.search
    return diagram.nodes.filter((n) => built.data.has(n.id) && built.placed.has(n.id)).map((n) => {
    const p = built.placed.get(n.id)!
    const d = built.data.get(n.id)!
    const type = n.kind === 'inputs' || n.kind === 'returns' ? 'io' : n.kind === 'step' && !n.expanded ? 'step' : 'block'
    const pos = drag?.id === n.id ? { x: drag.x, y: drag.y } : { x: p.x, y: p.y }
    const movable = editable && !n.nested && type !== 'io'
    const match = dropTarget === n.id || matchSet.has(n.id)
    return {
      id: n.id, type, position: pos, data: { ...d, ...(match ? { match: true } : {}), ...(searching && !match ? { dim: true } : {}) },
      ...(n.parent ? { parentId: n.parent } : {}),
      width: p.w, height: p.h, style: { width: p.w, height: p.h },
      selected: selection.includes(n.id),
      draggable: movable, connectable: movable || n.kind === 'inputs',
      zIndex: type === 'block' ? 0 : 1,
      ariaLabel: type === 'io' ? (d as IoNodeData).title : type === 'step' ? t('Step {title}', { title: (d as StepNodeData).step.title }) : t('Block'),
    } satisfies Node
  })
  }, [diagram, built, drag, selection, editable, dropTarget, matches, q, ui.search])

  // ---- Wires ----
  const ports = useMemo(() => {
    const outs = new Map<string, Set<string>>()
    const ins = new Map<string, Set<string>>()
    for (const [id, d] of built.data) {
      if ('content' in d) {
        outs.set(id, new Set((d as StepNodeData).content.outPorts.map((p) => `out:${p.path}`)))
        ins.set(id, new Set((d as StepNodeData).content.inPorts.map((p) => `in:${p.field}`)))
      } else if ('rows' in d) {
        const io = d as IoNodeData
        if (io.side === 'in') outs.set(id, new Set(io.rows.map((r) => `out:${r.name}`)))
        else ins.set(id, new Set(io.rows.map((r) => `in:${r.name}`)))
      } else if ('block' in d) {
        const g = d as GroupNodeData
        if (g.block?.kind === 'foreach' && !g.collapsed) outs.set(id, new Set(['item']))
        if (g.block?.kind === 'foreach') ins.set(id, new Set(['list']))
        if (g.block?.kind === 'if' || g.block?.kind === 'repeat') ins.set(id, new Set(['cond']))
      }
    }
    return { outs, ins }
  }, [built])

  const edges = useMemo<Edge[]>(() => paintedEdges(diagram.edges, diagram.nodes.length).filter((e) => (!e.layoutOnly || (!ui.dataWires && (e.from === INPUTS || e.to === RETURNS))) && built.data.has(e.from) && built.data.has(e.to)).map((e: DiagramEdge) => {
    if (e.layoutOnly) {
      // Start → first steps, last steps → returns: quiet, just to read the flow.
      return { id: e.id, source: e.from, target: e.to, sourceHandle: 'run', targetHandle: 'run', type: 'wire', selectable: false, focusable: false, reconnectable: false, className: 'dg-edge-quiet',
        data: { kind: 'order', from: e.from, to: e.to, insertable: false, showLabel: false, real: false } satisfies WireData, zIndex: 0 }
    }
    const sourceHandle = e.fromPort && ports.outs.get(e.from)?.has(e.fromPort) ? e.fromPort : 'run'
    const targetHandle = e.toPort && ports.ins.get(e.to)?.has(e.toPort) ? e.toPort : 'run'
    const fromNode = nodeById.get(e.from)
    const toNode = nodeById.get(e.to)
    const real = !fromNode?.nested && !toNode?.nested
    // Any run-order wire takes a step between its ends; port-to-port data wires don't.
    const insertable = real && !e.fromPort && !e.toPort
    const data: WireData = { kind: e.kind, label: e.kind === 'data' && ui.dataWires ? (e.label ? fieldLabel(e.label) : undefined) : undefined, from: e.from, to: e.to, insertable, showLabel: e.kind === 'data', real }
    return {
      id: e.id, source: e.from, target: e.to, sourceHandle, targetHandle, type: 'wire', data,
      selected: edgeSel === e.id,
      reconnectable: editable && real && (e.kind === 'after' || e.kind === 'order'),
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: e.kind === 'data' ? 'var(--dg-data)' : e.kind === 'after' ? 'var(--fg)' : e.kind === 'condition' ? 'var(--warning)' : e.kind === 'list' ? 'var(--dg-data)' : 'var(--dg-wire)' },
      zIndex: 2,
      ariaLabel: `${e.kind} wire`,
    }
  }), [diagram, built, ports, nodeById, edgeSel, editable, ui.dataWires])

  // ---- Fitting the view ----
  const shape = `${key}|${root ?? ''}|${ui.direction}|${ui.dataWires}|${diagram.nodes.length}|${[...collapsed].join(',')}|${Object.keys(nested).join(',')}`
  const lastShape = useRef('')
  useEffect(() => {
    if (lastShape.current === shape) return
    const first = !lastShape.current.startsWith(`${key}|`)
    // The canvas may not have its boxes yet on the first frames: try until it does.
    let t = 0
    let tries = 0
    const attempt = () => {
      if (fitReadable(first || reduceMotion() ? 0 : 200)) lastShape.current = shape
      else if (tries++ < 30) t = window.setTimeout(attempt, 30)
    }
    t = window.setTimeout(attempt, 0)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, key, rf])

  /**
   * Fit the workflow, but never so small its words can't be read: a big one
   * opens at its start, readable, and pans (the map shows where you are).
   * The fit button in the corner still shows all of it.
   */
  function fitReadable(duration: number): boolean {
    const el = wrap.current
    const all = rf.getNodes()
    if (!el || !all.length || !el.clientWidth) return false
    const b = rf.getNodesBounds(all)
    const W = el.clientWidth
    const H = el.clientHeight
    const fits = Math.min(1, W / (b.width * 1.14), H / (b.height * 1.14))
    if (fits >= READABLE_ZOOM) { void rf.fitView({ padding: 0.12, maxZoom: 1, duration }); return true }
    const zoom = READABLE_ZOOM
    // Open at the start of the flow: the "Starts with" box, else the first box in the flow's direction.
    const tops = all.filter((n) => !n.parentId)
    const anchor = tops.find((n) => n.id === INPUTS)
      ?? tops.reduce((best, n) => ((ui.direction === 'LR' ? n.position.x < best.position.x : n.position.y < best.position.y) ? n : best), tops[0])
    const ax = anchor.position.x + (anchor.width ?? 0) / 2
    const ay = anchor.position.y + Math.min(anchor.height ?? 0, H / zoom) / 2
    const x = ui.direction === 'LR' ? 32 - anchor.position.x * zoom : W / 2 - ax * zoom
    const y = ui.direction === 'TB' ? 32 - anchor.position.y * zoom : H / 2 - ay * zoom
    void rf.setViewport({ x, y, zoom }, { duration })
    return true
  }

  const focusNode = useCallback((id: string) => {
    const at = absolute(diagram, built.placed, id)
    if (!at) return
    void rf.setCenter(at.x + at.w / 2, at.y + Math.min(at.h, 160) / 2, { zoom: Math.max(rf.getZoom(), 0.75), duration: reduceMotion() ? 0 : 220 })
  }, [diagram, built, rf])

  // ---- Edits ----
  const edit = useCallback((change: (r: Recipe) => Recipe) => { builder.sealHistory(key); update(change); builder.sealHistory(key) }, [key, update])
  const select = useCallback((ids: string[]) => { diagramUi.select(ids); setEdgeSel(null) }, [])
  const blockId = (id: string): string | null => (id === INPUTS || id === RETURNS || nodeById.get(id)?.nested ? null : id)

  const remove = useCallback((ids: string[]) => {
    const real = ids.filter((id) => findBlock(recipe.blocks, id))
    if (!real.length || !editable) return
    const names = real.map((id) => blockTitle(findBlock(recipe.blocks, id)!.block))
    edit((r) => deleteBlocks(r, real))
    select([])
    toastStore.push({ text: real.length === 1 ? t('Deleted “{title}”', { title: names[0] }) : t('Deleted {n} blocks', { n: real.length }), action: { label: t('Undo'), run: () => { builder.undo(key) } } })
  }, [recipe, editable, edit, select, key])

  const duplicate = useCallback((id: string) => {
    let made: string | null = null
    edit((r) => { const out = duplicateBlock(r, id); made = out?.id ?? null; return out?.recipe ?? r })
    if (made) select([made])
  }, [edit, select])

  const runTogether = useCallback((ids: string[]) => {
    let blocked: string[] = []
    edit((r) => { const out = parallelize(r, catalog, ids); blocked = out.blocked; return out.recipe })
    if (blocked.length) toastStore.push({ kind: 'info', text: plural(blocked.length, '{titles} still waits: it uses another selected step’s data.', '{titles} still wait: they use another selected step’s data.', { titles: blocked.map((id) => findBlock(recipe.blocks, id)?.block).filter(Boolean).map((b) => `“${blockTitle(b!)}”`).join(', ') }) })
  }, [edit, catalog, recipe])

  const oneAfterAnother = useCallback((ids: string[]) => edit((r) => sequence(r, catalog, ids)), [edit, catalog])

  const insertAfterSelection = useCallback((picked: Pick<CatalogEntry, 'type' | 'title'>) => {
    const anchor = selection.map((id) => blockId(id)).find((id): id is string => !!id && !!findBlock(recipe.blocks, id))
    let made = ''
    edit((r) => {
      const at = anchor ? locate(r.blocks, anchor) : null
      const target = anchor ? findBlock(r.blocks, anchor)?.block : null
      const where = target && target.kind !== 'step' && !collapsed.has(target.id) ? { parent: target.id, index: target.blocks.length }
        : at ? { parent: at.parent, index: at.index + 1 }
        : root ? { parent: root, index: (findBlock(r.blocks, root)?.block as Exclude<Block, Step>).blocks.length } : { parent: null, index: r.blocks.length }
      const out = addStep(r, picked, where)
      made = out.id
      return out.recipe
    })
    if (made) { select([made]); requestAnimationFrame(() => focusNode(made)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, recipe, edit, collapsed, root, select, focusNode])

  const canvasApi: CanvasApi = useMemo(() => ({
    direction: ui.direction, editable,
    insertOn: (e, anchor) => pickStep(anchor, (picked) => {
      let made = ''
      edit((r) => { const out = insertBetween(r, catalog, picked, blockId(e.from), blockId(e.to)); made = out.id; return out.recipe })
      if (made) select([made])
    }),
    toggleCollapsed: (id) => diagramUi.toggleCollapsed(key, id),
    drill: (id) => diagramUi.drill({ key, root: id }),
    toggleNested: (id) => diagramUi.toggleNested(key, id),
    openNested: (id) => openNested(id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [ui.direction, editable, pickStep, edit, catalog, key, select, nodeById])

  /** Open the workflow a step runs: the organization's own opens here (breadcrumbs back), others unfold read-only. */
  function openNested(id: string) {
    const s = findBlock(recipe.blocks, id)?.block
    if (s?.kind !== 'step') return
    const target = entryFor(s.workflowType)
    if (target && target !== key) {
      diagramUi.drill({ key: target, root: null })
      void builder.select(target)
      return
    }
    if (!(ui.nestedOpen[key] ?? []).includes(id)) diagramUi.toggleNested(key, id)
  }

  const inspectorActions: InspectorActions = {
    close: () => select([]),
    remove, duplicate, parallelize: runTogether, sequence: oneAfterAnother,
    discuss: onDiscuss ?? null,
    unwait: (step, from) => edit((r) => disconnect(r, catalog, from, step).recipe),
    openNested, drill: (id) => diagramUi.drill({ key, root: id }),
    select: (id) => { select([id]); focusNode(diagram.rep.get(id) ?? id) },
    waitsFor: (id) => compiled.deps.filter((d) => d.to === id).map((d) => {
      const why = whyWaits(recipe, catalog, d.from, d.to)
      return { id: d.from, why: why === 'after' ? t('drawn by hand') : why === 'data' ? t('uses its data') : why === 'list' ? t('goes through its list') : why === 'condition' ? t('its condition reads it') : t('actions keep their order') }
    }),
    nested: (step) => nestedFor(step.workflowType),
  }

  // ---- Canvas events ----
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    let sel: Set<string> | null = null
    for (const c of changes) {
      if (c.type === 'position' && c.position && c.dragging) setDrag({ id: c.id, x: c.position.x, y: c.position.y })
      if (c.type === 'select') {
        sel ??= new Set(diagramUi.state.selection)
        if (c.selected) sel.add(c.id); else sel.delete(c.id)
      }
    }
    if (sel) { diagramUi.select([...sel]); if (sel.size) setEdgeSel(null) }
  }, [])
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) if (c.type === 'select') setEdgeSel((cur) => (c.selected ? c.id : cur === c.id ? null : cur))
  }, [])

  const deepestAt = useCallback((rect: { x: number; y: number; width: number; height: number }, except?: string) => {
    const hits = rf.getIntersectingNodes(rect, true).filter((n) => n.id !== except && n.type !== 'io' && !nodeById.get(n.id)?.nested)
    // Not into itself or anything inside it.
    const inside = (id: string) => { let at = nodeById.get(id); while (at) { if (at.id === except) return true; at = at.parent ? nodeById.get(at.parent) : undefined } return false }
    const ok = hits.filter((n) => !inside(n.id))
    return ok.sort((a, b) => ((a.width ?? 0) * (a.height ?? 0)) - ((b.width ?? 0) * (b.height ?? 0)))[0] ?? null
  }, [rf, nodeById])

  /** Where the pointer is, on the canvas: what a dragged box lands on. */
  const pointer = (event: MouseEvent | TouchEvent) => {
    const p = 'touches' in event ? event.changedTouches[0] : event
    return rf.screenToFlowPosition({ x: p.clientX, y: p.clientY })
  }

  const onNodeDrag = useCallback((event: MouseEvent | TouchEvent, node: Node) => {
    const p = pointer(event)
    setDropTarget(deepestAt({ x: p.x, y: p.y, width: 1, height: 1 }, node.id)?.id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf, deepestAt])

  /** Where a drag started: a box that didn't really move was clicked, not dropped. */
  const dragStart = useRef<{ id: string; x: number; y: number } | null>(null)
  const onNodeDragStart = useCallback((_: unknown, node: Node) => { dragStart.current = { id: node.id, x: node.position.x, y: node.position.y } }, [])

  const onNodeDragStop = useCallback((event: MouseEvent | TouchEvent, node: Node) => {
    setDrag(null)
    setDropTarget(null)
    const id = node.id
    const start = dragStart.current
    dragStart.current = null
    if (!start || start.id !== id || Math.hypot(node.position.x - start.x, node.position.y - start.y) < 6) return
    if (!findBlock(recipe.blocks, id)) return
    const p = pointer(event)
    const target = deepestAt({ x: p.x, y: p.y, width: 1, height: 1 }, id)
    const parent = nodeById.get(id)?.parent ?? null
    if (target?.type === 'block' && !collapsed.has(target.id) && findBlock(recipe.blocks, target.id)?.block.kind !== 'step') {
      if (target.id !== parent) edit((r) => moveInto(r, id, target.id))
      return
    }
    if (target?.type === 'step' || (target?.type === 'block' && collapsed.has(target.id))) {
      edit((r) => placeAfter(r, id, target.id))
      return
    }
    if (!target && parent) edit((r) => moveInto(r, id, root))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, rf, deepestAt, nodeById, collapsed, edit, root])

  const onConnect = useCallback((c: Connection) => {
    if (!editable || !c.source || !c.target || c.source === c.target) return
    const dataFrom = c.sourceHandle?.startsWith('out:')
    if (dataFrom) {
      const path = c.sourceHandle!.slice(4)
      const ref: Ref = c.source === INPUTS ? { kind: 'input', name: path } : { kind: 'step', step: c.source, path: path === '*' ? '' : path }
      const target = findBlock(recipe.blocks, c.target)?.block
      if (target?.kind !== 'step') return
      if (c.targetHandle?.startsWith('in:')) { edit((r) => mapData(r, ref, { step: c.target!, field: c.targetHandle!.slice(3) })); return }
      const spec = catalog.get(target.workflowType) ?? unknownEntry(target.workflowType)
      const fields = spec.inputs.filter((f) => !f.automatic).map((f) => f.name)
      void popupMenu(fields.length ? fields.map((f) => ({ label: t('Use for {field}', { field: fieldLabel(f) }), action: () => edit((r) => mapData(r, ref, { step: c.target!, field: f })) })) : [{ label: t('It has no inputs to fill'), enabled: false }])
      return
    }
    if (c.source === INPUTS || c.target === RETURNS || c.target === INPUTS) return
    edit((r) => connect(r, catalog, c.source!, c.target!))
  }, [editable, recipe, catalog, edit])

  const onReconnect = useCallback((old: Edge, c: Connection) => {
    const d = old.data as WireData | undefined
    if (!d || !c.source || !c.target || c.source === c.target) return
    let kept: string | null = null
    edit((r) => { const out = rewire(r, catalog, { from: d.from, to: d.to }, { from: c.source!, to: c.target! }); kept = out.kept; return out.recipe })
    if (kept === 'data') toastStore.push({ text: t('The old wire stays too: that step uses its data.') })
  }, [edit, catalog])

  const cutEdge = useCallback((id: string) => {
    const e = diagram.edges.find((x) => x.id === id)
    if (!e || !editable) return
    if (e.kind === 'data') {
      if (e.toPort?.startsWith('in:') && findBlock(recipe.blocks, e.to)?.block.kind === 'step') edit((r) => unmapData(r, { step: e.to, field: e.toPort!.slice(3) }))
      return
    }
    let kept: string | null = null
    edit((r) => { const out = disconnect(r, catalog, e.from, e.to); kept = out.kept; return out.recipe })
    if (kept) toastStore.push({ text: kept === 'data' ? t('It still waits: it uses that step’s data. Clear the field (or turn on Data wires and cut it) to change that.') : kept === 'condition' ? t('It still waits: its “Only if” reads that step.') : kept === 'list' ? t('It still waits: it goes through that step’s list.') : t('It still waits for that step.') })
    setEdgeSel(null)
  }, [diagram, editable, recipe, edit, catalog])

  // ---- Keyboard ----
  const visibleIds = useCallback(() => diagram.nodes.filter((n) => built.placed.has(n.id)).map((n) => n.id), [diagram, built])
  const move = useCallback((dx: number, dy: number) => {
    const ids = visibleIds()
    const current = selection[0] && ids.includes(selection[0]) ? selection[0] : null
    if (!current) { const first = ids.find((id) => id !== INPUTS) ?? ids[0]; if (first) { select([first]); focusNode(first) } return }
    const from = absolute(diagram, built.placed, current)!
    const cx = from.x + from.w / 2
    const cy = from.y + Math.min(from.h, 80) / 2
    let best: { id: string; score: number } | null = null
    for (const id of ids) {
      if (id === current) continue
      const to = absolute(diagram, built.placed, id)!
      const x = to.x + to.w / 2 - cx
      const y = to.y + Math.min(to.h, 80) / 2 - cy
      const along = x * dx + y * dy
      if (along <= 4) continue
      const across = Math.abs(x * dy - y * dx)
      const score = along + across * 2.2
      if (!best || score < best.score) best = { id, score }
    }
    if (best) { select([best.id]); focusNode(best.id) }
  }, [visibleIds, selection, diagram, built, select, focusNode])

  const openSearch = useCallback(() => {
    diagramUi.setOption({ search: true })
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.dg-search input')?.select())
  }, [])
  useEffect(() => {
    const onFind = () => openSearch()
    window.addEventListener('orkestia:diagram-find', onFind)
    return () => window.removeEventListener('orkestia:diagram-find', onFind)
  }, [openSearch])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, [contenteditable], .dg-inspector, .dg-palette, .dg-search')) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'f' && !e.shiftKey) { e.preventDefault(); openSearch(); return }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); if (selection[0] && editable) duplicate(selection[0]); return }
    if (mod || e.altKey) return
    const step = ui.direction === 'LR' ? 1 : 1
    if (e.key === 'ArrowRight') { e.preventDefault(); move(step, 0) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-step, 0) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(0, step) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(0, -step) }
    else if (e.key === 'Enter' && selection.length) {
      e.preventDefault()
      const g = nodeById.get(selection[0])
      if (g && (g.kind === 'if' || g.kind === 'foreach' || g.kind === 'repeat') && e.shiftKey) { diagramUi.drill({ key, root: g.id }); return }
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.dg-inspector input:not([disabled]), .dg-inspector [role="textbox"], .dg-inspector select, .dg-inspector button')?.focus())
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && editable) {
      e.preventDefault()
      if (edgeSel) cutEdge(edgeSel)
      else remove(selection)
    } else if (e.key === 'Escape') {
      // Handled here: the editor's own Esc (leave full page) only when nothing else was to close.
      if (ui.search) { e.preventDefault(); diagramUi.setOption({ search: false }); setQuery(''); return }
      if (selection.length || edgeSel) { e.preventDefault(); select([]); return }
    }
  }

  // ---- Palette drops ----
  const onDragOver = (e: React.DragEvent) => {
    if (!editable || !e.dataTransfer.types.includes(STEP_DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    setDropTarget(deepestAt({ x: p.x, y: p.y, width: 1, height: 1 })?.id ?? null)
  }
  const onDrop = (e: React.DragEvent) => {
    setDropTarget(null)
    const raw = e.dataTransfer.getData(STEP_DRAG_TYPE)
    if (!raw || !editable) return
    e.preventDefault()
    const picked = JSON.parse(raw) as Pick<CatalogEntry, 'type' | 'title'>
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const target = deepestAt({ x: p.x, y: p.y, width: 1, height: 1 })
    let made = ''
    edit((r) => {
      const t = target ? findBlock(r.blocks, target.id)?.block : null
      const at = t ? locate(r.blocks, t.id) : null
      const where = t && t.kind !== 'step' && !collapsed.has(t.id) ? { parent: t.id, index: t.blocks.length }
        : at ? { parent: at.parent, index: at.index + 1 }
        : root ? { parent: root, index: (findBlock(r.blocks, root)?.block as Exclude<Block, Step>).blocks.length } : { parent: null, index: r.blocks.length }
      const out = addStep(r, picked, where)
      made = out.id
      return out.recipe
    })
    if (made) select([made])
  }

  // ---- Context menu ----
  const nodeMenu = (id: string) => {
    const n = nodeById.get(id)
    if (!n || n.nested) return
    if (!selection.includes(id)) select([id])
    const ids = selection.includes(id) ? selection : [id]
    const b = findBlock(recipe.blocks, id)?.block
    void popupMenu([
      ...(b && b.kind !== 'step' ? [{ label: t('Go Inside'), action: () => diagramUi.drill({ key, root: id }) }, { label: collapsed.has(id) ? t('Unfold') : t('Fold'), action: () => diagramUi.toggleCollapsed(key, id) }] : []),
      ...(b?.kind === 'step' && runsWorkflow(b.workflowType) ? [{ label: entryFor(b.workflowType) ? t('Open Definition') : t('Show Its Steps'), action: () => openNested(id) }] : []),
      ...(editable && b ? [
        'separator' as const,
        ...(ids.length > 1 ? [{ label: t('Run Together'), action: () => runTogether(ids) }, { label: t('One After Another'), action: () => oneAfterAnother(ids) }] : []),
        { label: t('Duplicate'), action: () => duplicate(id) },
        { label: ids.length > 1 ? t('Delete {n} Blocks', { n: ids.length }) : t('Delete'), action: () => remove(ids) },
      ] : []),
      ...(onDiscuss ? ['separator' as const, { label: t('Discuss With the Assistant'), action: () => onDiscuss(ids) }] : []),
    ])
  }

  // ---- Toolbar state ----
  const canUndo = builder.canUndo(key)
  const canRedo = builder.canRedo(key)
  const containers: string[] = []
  const walkContainers = (bs: Block[]) => bs.forEach((b) => { if (b.kind !== 'step') { containers.push(b.id); walkContainers(b.blocks) } })
  walkContainers(recipe.blocks)
  const allFolded = containers.length > 0 && containers.every((id) => collapsed.has(id))
  const run = builder.state.runs[key]

  const showLastRun = async () => {
    const types = [entry.live?.workflow_type, entry.head?.workflow_type].filter((t): t is string => !!t)
    if (!types.length) { toastStore.push({ text: t('It hasn’t been saved yet, so it has no runs.') }); return }
    try {
      const rows = await api.runs(types, 1)
      if (!rows[0]) { toastStore.push({ text: t('No runs yet.') }); return }
      void builder.follow(key, rows[0].workflow_uuid, rows[0].workflow_type)
    } catch {
      toastStore.push({ kind: 'error', text: t('Couldn’t read the runs.') })
    }
  }

  const crumbs = ui.stack.length ? ui.stack : [{ key, root: null }]
  const crumbLabel = (l: { key: string; root: string | null }) => {
    const e = builder.state.entries.find((x) => x.key === l.key)
    const r = e?.recipe
    if (!l.root) return e?.title ?? humanize(l.key)
    const b = r ? findBlock(r.blocks, l.root)?.block : null
    return b ? blockTitle(b) : t('Block')
  }
  const goCrumb = (i: number) => {
    const target = crumbs[i]
    diagramUi.crumb(i)
    if (target.key !== key) void builder.select(target.key)
  }
  const go = (way: 'back' | 'forward') => {
    const to = way === 'back' ? diagramUi.back() : diagramUi.forward()
    if (to && to.key !== key) void builder.select(to.key)
  }

  const inspectorIds = selection.filter((id) => id === INPUTS || id === RETURNS || findBlock(recipe.blocks, id))
  const empty = !(root ? (findBlock(recipe.blocks, root)?.block as Exclude<Block, Step> | undefined)?.blocks.length : recipe.blocks.length)

  return (
    <CanvasContext.Provider value={canvasApi}>
      <div ref={workspace} className={`dg-workspace${paletteShown && !narrow ? ' with-palette' : ''}${inspectorIds.length ? ' with-inspector' : ''}${narrow ? ' narrow' : ''}`}>
        {paletteShown ? (
          <aside className={`dg-palette${narrow ? ' over' : ''}`} aria-label={t('Steps you can add')}>
            <div className="dg-palette-head">
              <span className="dg-palette-title">{t('Add a step')}</span>
              <button type="button" className="icon-button" aria-label={t('Hide steps')} title={t('Hide the step list')} onClick={() => togglePalette(false)}><IcSidebarCollapse size="sm" /></button>
            </div>
            <p className="dg-hint">{t('Drag onto the canvas, onto a step to add after it, or into a block. Click to add after the selection.')}</p>
            <StepSearch catalog={catalog} draggable compact autoFocus={false} onPick={insertAfterSelection} />
          </aside>
        ) : null}
        {paletteShown && !narrow ? <ResizeHandle id="builder.palette" cssVar="--w-dg-palette" defaultPx={236} min={180} max={420} className="at-palette" label={t('Steps width')} /> : null}
        <div className="dg-main">
          <div className="dg-bar" role="toolbar" aria-label={t('Diagram')}>
            <div className="dg-bar-nav">
              {paletteShown || !editable ? null : <button type="button" className="toolbar-button" title={t('Show the step list')} aria-label={t('Show the step list')} onClick={() => togglePalette(true)}><IcSidebarExpand size="md" /></button>}
              {ui.past.length || ui.future.length ? <button type="button" className="toolbar-button" title={t('Back')} aria-label={t('Back')} disabled={!ui.past.length} onClick={() => go('back')}><IcArrowLeft size="md" /></button> : null}
              {ui.past.length || ui.future.length ? <button type="button" className="toolbar-button" title={t('Forward')} aria-label={t('Forward')} disabled={!ui.future.length} onClick={() => go('forward')}><IcArrowRight size="md" /></button> : null}
              {crumbs.length > 1 ? <nav className="dg-crumbs" aria-label={t('Where you are')}>
                {crumbs.map((c, i) => (
                  <span key={`${c.key}:${c.root ?? ''}:${i}`} className="dg-crumb">
                    {i ? <IcChevronRight size="xs" /> : null}
                    {i === crumbs.length - 1 ? <span aria-current="location">{crumbLabel(c)}</span> : <button type="button" className="link" onClick={() => goCrumb(i)}>{crumbLabel(c)}</button>}
                  </span>
                ))}
              </nav> : null}
            </div>
            <div className="dg-bar-tools">
              <button type="button" className="toolbar-button" title={t('Undo (⌘Z)')} aria-label={t('Undo')} disabled={!canUndo} onClick={() => builder.undo(key)}><IcRotateCcw size="md" /></button>
              <button type="button" className="toolbar-button" title={t('Redo (⇧⌘Z)')} aria-label={t('Redo')} disabled={!canRedo} onClick={() => builder.redo(key)}><IcRotateCw size="md" /></button>
              <span className="dg-sep" />
              <span className="dg-cap">{t('Wires')}</span>
              <div className="segmented dg-seg" role="radiogroup" aria-label={t('Wires')}>
                <button type="button" role="radio" aria-checked={!ui.dataWires} className={ui.dataWires ? '' : 'selected'} title={t('Wires show what runs after what')} onClick={() => diagramUi.setOption({ dataWires: false })}>{t('Order')}</button>
                <button type="button" role="radio" aria-checked={ui.dataWires} className={ui.dataWires ? 'selected' : ''} title={t('Wires show which result feeds which input; drag between them to map data')} onClick={() => diagramUi.setOption({ dataWires: true })}>{t('Data')}</button>
              </div>
              <span className="dg-cap">{t('Layout')}</span>
              <div className="segmented dg-seg" role="radiogroup" aria-label={t('Direction')}>
                <button type="button" role="radio" aria-checked={ui.direction === 'LR'} className={ui.direction === 'LR' ? 'selected' : ''} title={t('Left to right')} onClick={() => diagramUi.setOption({ direction: 'LR' })}>→</button>
                <button type="button" role="radio" aria-checked={ui.direction === 'TB'} className={ui.direction === 'TB' ? 'selected' : ''} title={t('Top to bottom')} onClick={() => diagramUi.setOption({ direction: 'TB' })}>↓</button>
              </div>
              <button type="button" className="toolbar-button" title={allFolded ? t('Unfold every block') : t('Fold every block')} aria-label={allFolded ? t('Unfold all') : t('Fold all')} disabled={!containers.length} onClick={() => diagramUi.setCollapsed(key, allFolded ? [] : containers)}><IcChevronsUpDown size="md" /></button>
              <button type="button" className={`toolbar-button${ui.technical ? ' on' : ''}`} title={t('Show technical names')} aria-label={t('Technical names')} aria-pressed={ui.technical} onClick={() => diagramUi.setOption({ technical: !ui.technical })}><IcCode size="md" /><span className="wf-tb-label">{t('Names')}</span></button>
              <button type="button" className={`toolbar-button${run ? ' on' : ''}`} title={run ? t('Hide the run shown on the boxes') : t('Show how the last run went, on the boxes')} aria-label={t('Last run')} disabled={!entry.head} onClick={() => (run ? builder.clearRun(key) : void showLastRun())}><IcHistory size="md" /></button>
              <button type="button" className={`toolbar-button${ui.search ? ' on' : ''}`} title={t('Find a step (⌘F)')} aria-label={t('Find a step')} onClick={() => (ui.search ? diagramUi.setOption({ search: false }) : openSearch())}><IcSearch size="md" /></button>
            </div>
          </div>
          <div className={`dg-canvas${dropTarget ? ' dropping' : ''}${ui.dataWires ? ' data-mode' : ''}`} ref={wrap} tabIndex={0} onKeyDown={onKeyDown} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => setDropTarget(null)} aria-label={t('Workflow diagram')}>
            {readOnlyReasons.length && readOnly ? (
              <div className="dg-banner">
                <IcLock size="sm" />
                <span><strong>{t('Read-only.')}</strong> {readOnlyReasons.join('; ')}. {t('Everything is shown; nothing is dropped.')}</span>
                {onUnlock ? <button type="button" onClick={() => builder.duplicate(key)}>{t('Edit a Copy')}</button> : null}
                {onUnlock ? <button type="button" className="link" onClick={onUnlock}>{t('Edit anyway')}</button> : null}
              </div>
            ) : null}
            {ui.search ? (
              <div className="dg-search" role="search">
                <IcSearch size="sm" />
                <input autoFocus placeholder={t('Find a step')} value={query} aria-label={t('Find a step')}
                  onChange={(e) => { setQuery(e.target.value); setHit(0) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { e.preventDefault(); diagramUi.setOption({ search: false }); setQuery(''); wrap.current?.focus() }
                    if (e.key === 'Enter' && matches.length) {
                      e.preventDefault()
                      const i = e.shiftKey ? (hit - 1 + matches.length) % matches.length : hit % matches.length
                      select([matches[i]]); focusNode(matches[i]); setHit(i + 1)
                    }
                  }} />
                <span className="dg-hint">{q ? `${matches.length} found` : ''}</span>
                <button type="button" className="icon-button" aria-label={t('Close search')} onClick={() => { diagramUi.setOption({ search: false }); setQuery('') }}><IcX size="xs" /></button>
              </div>
            ) : null}
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              elementsSelectable={false}
              onNodeClick={(e, n) => {
                const multi = e.shiftKey || e.metaKey || e.ctrlKey
                const now = diagramUi.state.selection
                select(multi ? (now.includes(n.id) ? now.filter((x) => x !== n.id) : [...now, n.id]) : [n.id])
              }}
              onEdgeClick={(e, edge) => { e.stopPropagation(); if ((edge.data as WireData | undefined)?.real === false) return; diagramUi.select([]); setEdgeSel(edge.id) }}
              onNodeDoubleClick={(_, n) => {
                const d = nodeById.get(n.id)
                if (d && (d.kind === 'if' || d.kind === 'foreach' || d.kind === 'repeat') && !d.nested) diagramUi.drill({ key, root: n.id })
              }}
              onNodeContextMenu={(e, n) => { e.preventDefault(); nodeMenu(n.id) }}
              onPaneClick={() => select([])}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onConnect={onConnect}
              onReconnect={onReconnect}
              isValidConnection={(c) => c.source !== c.target && !nodeById.get(c.source)?.nested && !nodeById.get(c.target)?.nested && c.target !== INPUTS}
              nodesConnectable={editable}
              edgesReconnectable={editable}
              nodesFocusable
              disableKeyboardA11y
              deleteKeyCode={null}
              minZoom={diagram.nodes.length > DAGRE_LIMIT ? READABLE_ZOOM : 0.08}
              maxZoom={1.75}
              fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
              proOptions={{ hideAttribution: true }}
              onlyRenderVisibleElements={diagram.nodes.length > DAGRE_LIMIT}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap pannable zoomable position="bottom-right" ariaLabel="Overview" nodeClassName={(n) => `dg-mm ${n.type ?? ''} ${(n.data as { run?: string }).run ? `run-${(n.data as { run?: string }).run}` : ''}`} style={{ width: 160, height: 104 }} />
            </ReactFlow>
            {empty ? (
              <div className="dg-empty">
                <p>{root ? t('Nothing inside this block yet.') : t('No steps yet.')}</p>
                {editable ? <button type="button" className="primary" onClick={(e) => pickStep(e.currentTarget, insertAfterSelection)}><IcPlus size="sm" /> {t('Add the First Step')}</button> : null}
                {editable ? <p className="dg-hint">{t('…or drag one from the list on the left.')}</p> : null}
              </div>
            ) : null}
            {/* The inspector beside the canvas already carries these actions, so no second bar floats over it. */}
            {edgeSel && editable ? (
              <div className="dg-selbar" role="toolbar" aria-label={t('Selected wire')}>
                <span className="dg-hint">{t('Wire selected · drag an end to rewire')}</span>
                <button type="button" className="danger" onClick={() => cutEdge(edgeSel)}><IcTrash size="sm" /> {t('Remove Wire')}</button>
              </div>
            ) : null}
            {selection.length || edgeSel ? null : <Legend data={ui.dataWires} />}
          </div>
        </div>
        {inspectorIds.length ? (
          <>
            <ResizeHandle id="builder.inspector" cssVar="--w-dg-inspector" defaultPx={360} min={280} max={620} sizes="right" className="dg-inspector-resize" label={t('Inspector width')} />
            <Inspector ids={inspectorIds} actions={inspectorActions} />
          </>
        ) : null}
      </div>
    </CanvasContext.Provider>
  )
}

function Legend({ data }: { data: boolean }) {
  return (
    <div className="dg-legend" aria-hidden>
      {data ? <span className="kind-data">{t('result → input')}</span> : <><span className="kind-order">{t('runs after')}</span><span className="kind-data">{t('uses its data')}</span><span className="kind-after">{t('drawn by hand')}</span><span className="kind-condition">{t('decides')}</span></>}
      <span className="dg-legend-tip"><IcBraces size="xs" /> {t('drag from a box’s edge to wire it')}</span>
    </div>
  )
}
