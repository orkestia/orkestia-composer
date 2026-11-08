// The boxes and wires of the diagram. Boxes say what a step does in words
// (title, app, the inputs that are filled, its problems and how the last run
// went); the technical name shows on hover or with "technical names" on.
import { t, plural, msg } from '../i18n'
import { createContext, useContext, useState, type ReactNode } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import {
  IcAlertCircle, IcBraces, IcBranch, IcChevronDown, IcChevronRight, IcClock, IcDatabase, IcDone, IcEnter, IcFailed, IcGlobe, IcMail, IcMessage, IcPlus, IcRepeat, IcRepeatOnce,
  IcRunning, IcSearch, IcSwap, IcTicket, IcUserCheck, IcWorkflows, IcWrench, IcZap, ProviderMark, hasProviderMark,
} from '../icons'
import type { CatalogEntry } from '../../model/catalog'
import type { EdgeKind } from '../../model/graph'
import type { Block, Step } from '../../model/recipe'
import type { InspectorStep } from '../host'
import { HEAD_H, ROW_H, type StepContent } from './content'
import type { Direction } from './state'

/** Canvas actions the boxes and wires call. */
export interface CanvasApi {
  direction: Direction
  editable: boolean
  insertOn: (edge: { from: string; to: string }, anchor: HTMLElement) => void
  toggleCollapsed: (id: string) => void
  drill: (id: string) => void
  toggleNested: (id: string) => void
  openNested: (id: string) => void
}
export const CanvasContext = createContext<CanvasApi | null>(null)
const useCanvas = () => useContext(CanvasContext)!

const sides = (d: Direction) => (d === 'LR' ? { in: Position.Left, out: Position.Right } : { in: Position.Top, out: Position.Bottom })

// ---- Icons ----

export function StepIcon({ type, entry, size = 'md' }: { type: string; entry?: CatalogEntry; size?: 'sm' | 'md' }) {
  const ns = type.split('.')[0]
  if (type.startsWith('virtual.') || type.startsWith('orn:')) return <IcWorkflows size={size} />
  if (hasProviderMark(ns)) return <ProviderMark provider={ns} size={size} />
  if (entry?.asksPerson || /approval/.test(type)) return <IcUserCheck size={size} />
  if (/^slack\.|^chat\.|message/.test(type)) return <IcMessage size={size} />
  if (/email|ses\.|mail/.test(type)) return <IcMail size={size} />
  if (/^ticket/.test(type)) return <IcTicket size={size} />
  if (/^http\.|^net\.|webhook/.test(type)) return <IcGlobe size={size} />
  if (/^flow\.wait|time\./.test(type)) return <IcClock size={size} />
  if (/^control\.value|^control\.text/.test(type)) return <IcBraces size={size} />
  if (/^control\./.test(type)) return <IcWrench size={size} />
  if (/^data\.|^audit\.|^kv\./.test(type)) return <IcDatabase size={size} />
  if (entry?.readOnly) return <IcSearch size={size} />
  return <IcZap size={size} />
}

function RunMark({ status }: { status?: InspectorStep['status'] }) {
  if (!status) return null
  if (status === 'succeeded') return <span className="dg-run ok" title={t('Succeeded in the run shown')}><IcDone size="xs" /></span>
  if (status === 'failed' || status === 'unrecoverable') return <span className="dg-run bad" title={t('Failed in the run shown')}><IcFailed size="xs" /></span>
  if (status === 'running') return <span className="dg-run live" title={t('Running')}><IcRunning size="xs" /></span>
  return <span className="dg-run wait" title={t('Waiting to run')}><IcClock size="xs" /></span>
}

// ---- Step ----

export type StepNodeData = {
  step: Step
  entry: CatalogEntry
  known: boolean
  content: StepContent
  number?: number
  /** Others run in the same round. */
  parallel: boolean
  problems: { errors: number; warnings: number; first?: string }
  run?: InspectorStep['status']
  runNote?: string
  data: boolean
  technical: boolean
  /** Part of a nested workflow opened inline: shown, not edited. */
  readOnly: boolean
  /** Runs another workflow. */
  nested?: { title?: string; status: string; open: boolean }
  /** Ports that exist (for data wires). */
  match?: boolean
  dim?: boolean
} & Record<string, unknown>

export function StepNode({ data, id, selected }: NodeProps<Node<StepNodeData>>) {
  const canvas = useCanvas()
  const s = sides(canvas.direction)
  const { step, entry, content, problems } = data
  const tech = `${step.name} · ${step.workflowType}`
  const cls = ['dg-node', 'dg-step', selected ? 'selected' : '', data.run ? `run-${data.run}` : '', problems.errors ? 'has-errors' : problems.warnings ? 'has-warnings' : '', data.readOnly ? 'readonly' : '', data.match ? 'match' : '', data.dim ? 'dim' : '', data.nested?.open ? 'expanded' : ''].filter(Boolean).join(' ')
  return (
    <div className={cls} data-id={id} title={data.technical ? undefined : tech}>
      <Handle type="target" position={s.in} id="run" className="dg-handle" isConnectable={canvas.editable && !data.readOnly} />
      <div className="dg-head" style={{ height: HEAD_H + (data.technical ? 16 : 0) }}>
        <span className={`dg-icon${entry.readOnly ? ' reads' : ''}`}><StepIcon type={step.workflowType} entry={entry} /></span>
        <div className="dg-titles">
          <div className="dg-title-row">
            {data.number ? <span className="dg-num">{data.number}</span> : null}
            <span className="dg-title">{step.title || entry.title}</span>
            <RunMark status={data.run} />
          </div>
          <div className="dg-meta">
            <span>{entry.app}</span>
            {entry.readOnly ? <span className="dg-tag">{t('reads')}</span> : null}
            {entry.asksPerson ? <span className="dg-tag accent">{t('waits for a person')}</span> : null}
            {data.parallel && !entry.readOnly ? <span className="dg-tag" title={t('Runs at the same time as other steps')}><IcSwap size="xs" /> {t('together')}</span> : null}
            {step.stopOnFail ? <span className="dg-tag warn">{t('stops all if it fails')}</span> : null}
          </div>
          {data.technical ? <div className="dg-tech mono">{tech}</div> : null}
        </div>
        {data.nested ? (
          <button type="button" className="dg-mini nodrag" title={data.nested.open ? t('Fold the workflow it runs') : t('Show the workflow it runs, here')} aria-label={data.nested.open ? t('Fold') : t('Unfold')} onClick={(e) => { e.stopPropagation(); canvas.toggleNested(id) }}>
            {data.nested.open ? <IcChevronDown size="xs" /> : <IcChevronRight size="xs" />}
          </button>
        ) : null}
      </div>
      {data.nested?.open ? null : data.data ? (
        <>
          <div className="dg-section">{t('Uses')}</div>
          {content.inPorts.length ? content.inPorts.map((p) => (
            <div key={p.field} className={`dg-port in${p.filled ? ' filled' : ''}${p.required && !p.filled ? ' missing' : ''}`}>
              <Handle type="target" position={Position.Left} id={`in:${p.field}`} className="dg-port-handle" isConnectable={canvas.editable && !data.readOnly} />
              <span className="dg-port-label">{p.label}{p.required ? <span className="dg-req">•</span> : null}</span>
            </div>
          )) : <div className="dg-port in none"><span className="dg-port-label">{t('Nothing to fill in')}</span></div>}
          {content.morePorts.in ? <div className="dg-port more">{t('+{n} more in the inspector', { n: content.morePorts.in })}</div> : null}
          <div className="dg-section">{t('Gives')}</div>
          {content.outPorts.map((p) => (
            <div key={p.path} className="dg-port out">
              <span className="dg-port-label">{p.label}</span>
              <Handle type="source" position={Position.Right} id={`out:${p.path}`} className="dg-port-handle" isConnectable={canvas.editable && !data.readOnly} />
            </div>
          ))}
          {content.morePorts.out ? <div className="dg-port more">{t('+{n} more', { n: content.morePorts.out })}</div> : null}
        </>
      ) : (
        <div className="dg-fields">
          {content.fields.map((f) => (
            <div key={f.name} className="dg-field" title={`${f.label}: ${f.text}`}>
              <span className="dg-field-label">{f.label}</span>
              <span className={`dg-field-value${f.ref ? ' ref' : ''}${f.missing ? ' missing' : ''}`}>{f.text}</span>
            </div>
          ))}
          {content.empty && content.fields.length < 3 ? <div className="dg-field todo"><span className="dg-field-label">{t('{n} to fill in', { n: content.empty })}</span></div> : null}
        </div>
      )}
      {problems.first ? <div className={`dg-problem ${problems.errors ? 'error' : 'warning'}`} title={problems.first}><IcAlertCircle size="xs" /> {problems.errors + problems.warnings > 1 ? `${problems.errors + problems.warnings} · ` : ''}{problems.first}</div> : null}
      {data.runNote ? <div className="dg-runnote" title={data.runNote}>{data.runNote}</div> : null}
      <Handle type="source" position={s.out} id="run" className="dg-handle" isConnectable={canvas.editable && !data.readOnly} />
    </div>
  )
}

// ---- Wrapping blocks ----

export type GroupNodeData = {
  block: Block | null
  /** A step running another workflow, opened inline. */
  host?: { step: Step; entry: CatalogEntry; title?: string; status: string; entryKey?: string }
  sentence: ReactNode
  collapsed: boolean
  stepCount: number
  problems: { errors: number; warnings: number; first?: string }
  run?: InspectorStep['status']
  readOnly: boolean
  data: boolean
  match?: boolean
  dim?: boolean
} & Record<string, unknown>

export function GroupNode({ data, id, selected }: NodeProps<Node<GroupNodeData>>) {
  const canvas = useCanvas()
  const s = sides(canvas.direction)
  const kind = data.host ? 'nested' : data.block?.kind ?? 'if'
  const icon = data.host ? <StepIcon type={data.host.step.workflowType} entry={data.host.entry} /> : kind === 'if' ? <IcBranch size="sm" /> : kind === 'foreach' ? <IcRepeatOnce size="sm" /> : <IcRepeat size="sm" />
  const cls = ['dg-node', 'dg-group', `kind-${kind}`, data.collapsed ? 'collapsed' : '', selected ? 'selected' : '', data.run ? `run-${data.run}` : '', data.problems.errors ? 'has-errors' : '', data.readOnly ? 'readonly' : '', data.match ? 'match' : '', data.dim ? 'dim' : ''].filter(Boolean).join(' ')
  return (
    <div className={cls} data-id={id}>
      <Handle type="target" position={s.in} id="run" className="dg-handle" isConnectable={canvas.editable && !data.readOnly} />
      {kind === 'foreach' && data.data ? <Handle type="target" position={Position.Left} id="list" className="dg-port-handle dg-list-handle" isConnectable={false} /> : null}
      {(kind === 'if' || kind === 'repeat') && data.data ? <Handle type="target" position={Position.Left} id="cond" className="dg-port-handle dg-list-handle" isConnectable={false} /> : null}
      <div className="dg-group-head">
        <button type="button" className="dg-mini nodrag" aria-label={data.collapsed ? t('Unfold') : t('Fold')} title={data.collapsed ? t('Show the steps inside') : t('Fold into one box')}
          onClick={(e) => { e.stopPropagation(); if (data.host) canvas.toggleNested(id); else canvas.toggleCollapsed(id) }}>
          {data.collapsed ? <IcChevronRight size="xs" /> : <IcChevronDown size="xs" />}
        </button>
        <span className="dg-group-icon">{icon}</span>
        <span className="dg-group-sentence">{data.sentence}</span>
        <RunMark status={data.run} />
        {data.host ? (
          data.host.entryKey ? <button type="button" className="dg-mini nodrag" title={t('Open this workflow (breadcrumbs bring you back)')} aria-label={t('Open definition')} onClick={(e) => { e.stopPropagation(); canvas.openNested(id) }}><IcEnter size="xs" /></button> : null
        ) : !data.readOnly && !data.collapsed ? (
          <button type="button" className="dg-mini nodrag" title={t('Go into this block')} aria-label={t('Go into this block')} onClick={(e) => { e.stopPropagation(); canvas.drill(id) }}><IcEnter size="xs" /></button>
        ) : null}
      </div>
      {data.collapsed ? <div className="dg-group-summary">{plural(data.stepCount ?? 0, '{n} step inside', '{n} steps inside')}{data.problems.errors ? t(' · {n} to fix', { n: data.problems.errors }) : ''}</div> : null}
      {!data.collapsed && data.host?.status === 'loading' ? <div className="dg-group-summary">{t('Reading the workflow it runs…')}</div> : null}
      {!data.collapsed && data.host?.status === 'error' ? <div className="dg-group-summary warn">{t('Couldn’t read the workflow it runs.')}</div> : null}
      {!data.collapsed && !data.stepCount && !data.host ? <div className="dg-group-summary">{t('Drop steps here')}</div> : null}
      {kind === 'foreach' && data.data && !data.collapsed ? <Handle type="source" position={Position.Right} id="item" className="dg-port-handle dg-item-handle" isConnectable={false} /> : null}
      <Handle type="source" position={s.out} id="run" className="dg-handle" isConnectable={canvas.editable && !data.readOnly} />
    </div>
  )
}

// ---- Starts with / Returns ----

export type IoNodeData = { title: string; rows: Array<{ name: string; label: string; detail?: string }>; more?: number; data: boolean; side: 'in' | 'out'; dim?: boolean } & Record<string, unknown>

export function IoNode({ data, selected }: NodeProps<Node<IoNodeData>>) {
  const canvas = useCanvas()
  const s = sides(canvas.direction)
  return (
    <div className={`dg-node dg-io ${data.side}${selected ? ' selected' : ''}${data.dim ? ' dim' : ''}`}>
      {data.side === 'out' ? <Handle type="target" position={s.in} id="run" className="dg-handle" isConnectable={false} /> : null}
      <div className="dg-io-title">{data.title}</div>
      {data.rows.length ? data.rows.map((r) => (
        <div key={r.name} className="dg-port" title={r.detail}>
          {data.side === 'out' && data.data ? <Handle type="target" position={Position.Left} id={`in:${r.name}`} className="dg-port-handle" isConnectable={false} /> : null}
          <span className="dg-port-label">{r.label}</span>
          {data.side === 'in' && data.data ? <Handle type="source" position={Position.Right} id={`out:${r.name}`} className="dg-port-handle" isConnectable={canvas.editable} /> : null}
        </div>
      )) : <div className="dg-port"><span className="dg-port-label muted">{t('Nothing')}</span></div>}
      {data.more ? <div className="dg-port more">{t('+{n} more — select to see all', { n: data.more })}</div> : null}
      {data.side === 'in' ? <Handle type="source" position={s.out} id="run" className="dg-handle" isConnectable={false} /> : null}
    </div>
  )
}

// ---- Wires ----

export type WireData = { kind: EdgeKind; label?: string; from: string; to: string; insertable: boolean; showLabel: boolean; real: boolean } & Record<string, unknown>

const WORDS: Record<EdgeKind, string> = {
  order: msg('runs after (actions keep their order)'),
  after: msg('runs after (drawn by hand)'),
  data: msg('uses its result'),
  condition: msg('decides whether it runs'),
  list: msg('goes through its list'),
}

export function WireEdge(props: EdgeProps & { data?: WireData }) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data } = props
  const canvas = useCanvas()
  const [hover, setHover] = useState(false)
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const kind = data?.kind ?? 'order'
  const text = data?.showLabel && data.label ? data.label : ''
  // A label node per wire is what freezes a large diagram: mount one only while it says something or the pointer is on it.
  const chrome = !!text || !!selected || (hover && !!data?.insertable && canvas.editable)
  return (
    <>
      <g className={`dg-wire kind-${kind}${selected ? ' selected' : ''}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={18} />
      </g>
      {chrome ? (
        <EdgeLabelRenderer>
          <div className={`dg-wire-label nodrag nopan kind-${kind}${hover || selected ? ' show' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
            {text ? <span className="dg-wire-text" title={t(WORDS[kind])}>{text}</span> : null}
            {data?.insertable && canvas.editable ? (
              <button type="button" className="dg-insert" title={t('Add a step here')} aria-label={t('Add a step here')}
                onClick={(e) => { e.stopPropagation(); canvas.insertOn({ from: data.from, to: data.to }, e.currentTarget) }}>
                <IcPlus size="xs" />
              </button>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export const NODE_TYPES = { step: StepNode, block: GroupNode, io: IoNode }
export const EDGE_TYPES = { wire: WireEdge }
export { ROW_H }
