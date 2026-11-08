// Fields: a value is typed text with data chips written {Like › this}. The
// "+" button lists the data available at that point of the recipe.
import { t, msg } from './i18n'
import { Fragment, useMemo, useRef, useState } from 'react'
import { IcPlus, IcX } from './icons'
import { compatible, fieldLabel, humanize, type CatalogField, type FieldType } from '../model/catalog'
import type { ConditionOp } from '../model/definition'
import { availableData, describeRef, type ChipOption } from '../model/data'
import { sameRef, uid, uniqueName, type Condition, type Ref, type Value } from '../model/recipe'
import { fromEditText, literal, toEditText } from '../model/text'
import { useEditor } from './context'
import { Popover } from './Popover'

// ---- Chip ----

export function Chip({ refValue, onRemove }: { refValue: Ref; onRemove?: () => void }) {
  const { recipe, catalog } = useEditor()
  const d = describeRef(recipe, catalog, refValue)
  const [source, ...rest] = d.label.split(' › ')
  return (
    <span className={`wf-chip chip-${refValue.kind}${d.missing ? ' missing' : ''}`} title={d.label}>
      <span className="wf-chip-source">{source}</span>
      {rest.length ? <span className="wf-chip-field">{rest.join(' › ')}</span> : null}
      {onRemove ? <button type="button" className="wf-chip-x" aria-label={t('Remove')} onClick={(e) => { e.stopPropagation(); onRemove() }}><IcX size="xs" /></button> : null}
    </span>
  )
}

// ---- Picker ----

export function ChipPicker({ anchor, atId, want, onPick, onAsk, onClose }: {
  anchor: HTMLElement
  atId: string | null
  want?: FieldType
  onPick: (option: ChipOption) => void
  /** "Ask for this when it runs": turn the field into a Starts-with question. */
  onAsk?: () => void
  onClose: () => void
}) {
  const { recipe, catalog } = useEditor()
  const [query, setQuery] = useState('')
  const options = useMemo(() => availableData(recipe, catalog, atId), [recipe, catalog, atId])
  const q = query.trim().toLowerCase()
  const shown = options.filter((o) => !q || `${o.group} ${o.label}`.toLowerCase().includes(q))
  const groups = [...new Set(shown.map((o) => o.group))]
  return (
    <Popover anchor={anchor} onClose={onClose} width={320} className="wf-picker">
      <input className="wf-picker-search" autoFocus placeholder={t('Search data')} value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); onPick(shown[0]) } }} />
      <div className="wf-picker-list">
        {groups.length ? groups.map((g) => (
          <div key={g} className="wf-picker-group">
            <div className="wf-picker-head">{g}</div>
            {shown.filter((o) => o.group === g).map((o) => {
              const fits = !want || compatible(o.type, want)
              const [, ...field] = o.label.split(' › ')
              return (
                <button key={o.label} type="button" className={`wf-picker-item${fits ? '' : ' dim'}`} onClick={() => onPick(o)}
                  title={fits ? o.label : t('{label} — may not fit ({type})', { label: o.label, type: o.type ?? '' })}>
                  <span>{field.length ? field.join(' › ') : o.label}</span>
                  <span className="wf-picker-type">{o.list ? 'list of results' : typeWord(o.type)}</span>
                </button>
              )
            })}
          </div>
        )) : <p className="wf-picker-empty">{options.length ? 'Nothing matches' : 'No data yet. Add a question under “Starts with” or a step above this one.'}</p>}
      </div>
      {onAsk ? (
        <button type="button" className="wf-picker-ask" onClick={onAsk}>
          <IcPlus size="sm" /> Ask for this when it runs
        </button>
      ) : null}
    </Popover>
  )
}

export function typeWord(type: FieldType): string {
  return ({ string: 'text', text: t('text'), email: 'email', uuid: 'ID', integer: 'number', float: 'number', boolean: 'yes/no', datetime: 'date', list: 'list', dict: 'record', json: 'any' } as const)[type]
}

// ---- Value field ----

export function ValueField({ atId, field, value, onChange, onAskField }: {
  atId: string | null
  field: CatalogField | undefined
  value: Value | undefined
  onChange: (value: Value) => void
  /** Defaults to adding a Starts-with question named after the field. */
  onAskField?: boolean
}) {
  const { recipe, catalog, readOnly, update } = useEditor()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [picker, setPicker] = useState<HTMLElement | null>(null)
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const selection = useRef<[number, number]>([0, 0])
  const options = useMemo(() => (editing || picker ? availableData(recipe, catalog, atId) : []), [editing, picker, recipe, catalog, atId])
  const labelOf = (ref: Ref) => options.find((o) => sameRef(o.ref, ref))?.label ?? describeRef(recipe, catalog, ref).label
  const type = field?.type
  const long = type === 'text'

  const startEditing = () => {
    if (readOnly || value?.kind === 'object' || value?.kind === 'list') return
    const opts = availableData(recipe, catalog, atId)
    setText(toEditText(value, (r) => opts.find((o) => sameRef(o.ref, r))?.label ?? describeRef(recipe, catalog, r).label))
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  const commit = (next = text) => {
    const labels = [...options, ...refsIn(value).map((ref) => ({ ref, label: labelOf(ref) }))]
    onChange(fromEditText(next, labels, type))
    setEditing(false)
  }
  const openPicker = (anchor: HTMLElement) => {
    const el = inputRef.current
    if (el) selection.current = [el.selectionStart ?? text.length, el.selectionEnd ?? text.length]
    setPicker(anchor)
  }
  const pick = (option: ChipOption) => {
    setPicker(null)
    if (editing) {
      const [s, e] = selection.current
      const next = `${text.slice(0, s)}{${option.label}}${text.slice(e)}`
      setText(next)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        const at = s + option.label.length + 2
        el.setSelectionRange(at, at)
      })
      return
    }
    if (!value || value.kind === 'empty' || (value.kind === 'literal' && (value.value === '' || value.value == null))) {
      onChange({ kind: 'ref', ref: option.ref })
    } else if (value.kind === 'text') {
      onChange({ kind: 'text', parts: [...value.parts, ' ', option.ref] })
    } else if (value.kind === 'literal' && typeof value.value === 'string') {
      onChange({ kind: 'text', parts: [value.value, ' ', option.ref] })
    } else {
      onChange({ kind: 'ref', ref: option.ref })
    }
  }
  const ask = field && onAskField !== false ? () => {
    setPicker(null)
    setEditing(false)
    let name = field.name
    update((r) => {
      name = uniqueName(field.name, new Set(r.inputs.map((i) => i.name)))
      return { ...r, inputs: [...r.inputs, { id: uid('i'), name, label: fieldLabel(field.name), type: field.type, required: !!field.required, autoName: true, ...(field.description ? { description: field.description } : {}) }] }
    })
    onChange({ kind: 'ref', ref: { kind: 'input', name } })
  } : undefined

  // Fixed choices and yes/no read better as controls than as typed text.
  const choice = !editing && field?.options?.length && (!value || value.kind === 'empty' || value.kind === 'literal')
  const yesNo = !editing && type === 'boolean' && (!value || value.kind === 'empty' || value.kind === 'literal')

  return (
    <div className={`wf-value${editing ? ' editing' : ''}${readOnly ? ' readonly' : ''}`}>
      {editing ? (
        long ? (
          <textarea ref={inputRef} className="wf-input" rows={2} value={text} onChange={(e) => setText(e.target.value)}
            onBlur={() => { if (!picker) commit() }} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit() }} />
        ) : (
          <input ref={inputRef} className="wf-input" value={text} onChange={(e) => setText(e.target.value)}
            onBlur={() => { if (!picker) commit() }} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); if (e.key === 'Enter') commit() }} />
        )
      ) : choice ? (
        <select className="wf-select" disabled={readOnly} value={value?.kind === 'literal' ? String(value.value ?? '') : ''}
          onChange={(e) => onChange(e.target.value ? { kind: 'literal', value: e.target.value } : { kind: 'empty' })}>
          <option value="">{t('Choose…')}</option>
          {field!.options!.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
        </select>
      ) : yesNo ? (
        <div className="segmented wf-yesno">
          {[[t('Yes'), true], [t('No'), false]].map(([label, v]) => (
            <button key={String(label)} type="button" disabled={readOnly} className={value?.kind === 'literal' && value.value === v ? 'selected' : ''}
              onClick={() => onChange(value?.kind === 'literal' && value.value === v ? { kind: 'empty' } : { kind: 'literal', value: v })}>{label as string}</button>
          ))}
        </div>
      ) : (
        <div className="wf-value-display" role="textbox" tabIndex={readOnly ? -1 : 0} onClick={startEditing} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEditing() } }}>
          <ValueView value={value} placeholder={readOnly ? '—' : placeholderFor(type)} onClear={readOnly ? undefined : () => onChange({ kind: 'empty' })} />
        </div>
      )}
      {readOnly ? null : (
        <button type="button" className="wf-add-data" title={t('Use data from earlier')} aria-label={t('Use data from earlier')}
          onMouseDown={(e) => e.preventDefault()} onClick={(e) => openPicker(e.currentTarget)}>
          <IcPlus size="sm" />
        </button>
      )}
      {picker ? <ChipPicker anchor={picker} atId={atId} want={type} onPick={pick} onAsk={ask} onClose={() => { setPicker(null); if (editing) requestAnimationFrame(() => inputRef.current?.focus()) }} /> : null}
    </div>
  )
}

function refsIn(value: Value | undefined): Ref[] {
  if (!value) return []
  if (value.kind === 'ref') return [value.ref]
  if (value.kind === 'text') return value.parts.filter((p): p is Ref => typeof p !== 'string')
  return []
}

function placeholderFor(type: FieldType | undefined): string {
  if (type === 'integer' || type === 'float') return t('Type a number or add data')
  if (type === 'email') return t('Type an email or add data')
  return t('Type a value or add data')
}

export function ValueView({ value, placeholder, onClear }: { value: Value | undefined; placeholder?: string; onClear?: () => void }) {
  if (!value || value.kind === 'empty') return <span className="wf-placeholder">{placeholder ?? ''}</span>
  switch (value.kind) {
    case 'literal':
      return <span className="wf-literal">{value.value === true ? 'Yes' : value.value === false ? 'No' : typeof value.value === 'string' ? (value.value || <span className="wf-placeholder">{placeholder}</span>) : JSON.stringify(value.value)}</span>
    case 'ref':
      return <Chip refValue={value.ref} onRemove={onClear} />
    case 'text':
      return <span className="wf-text">{value.parts.map((p, i) => (typeof p === 'string' ? <Fragment key={i}>{p}</Fragment> : <Chip key={i} refValue={p} />))}</span>
    case 'object':
      return (
        <span className="wf-group">
          {Object.entries(value.fields).map(([k, v]) => <span key={k} className="wf-group-item"><span className="wf-group-key">{humanize(k)}</span> <ValueView value={v} /></span>)}
        </span>
      )
    case 'list':
      return <span className="wf-group">{value.items.map((v, i) => <span key={i} className="wf-group-item"><ValueView value={v} /></span>)}</span>
  }
}

// ---- Choosing one piece of data (condition subject, For each list) ----

export function RefButton({ atId, refValue, want, onChange, placeholder }: {
  atId: string | null
  refValue: Ref | null
  want?: FieldType
  onChange: (ref: Ref) => void
  placeholder: string
}) {
  const { readOnly } = useEditor()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <button type="button" className={`wf-ref-button${refValue ? '' : ' empty'}`} disabled={readOnly} onClick={(e) => setAnchor(e.currentTarget)}>
        {refValue ? <Chip refValue={refValue} /> : <span>{placeholder}</span>}
      </button>
      {anchor ? <ChipPicker anchor={anchor} atId={atId} want={want} onPick={(o) => { setAnchor(null); onChange(o.ref) }} onClose={() => setAnchor(null)} /> : null}
    </>
  )
}

// ---- Conditions, as sentences ----

export const OPS: Array<{ op: ConditionOp; label: string; unary?: boolean }> = [
  { op: 'eq', label: msg('is') },
  { op: 'ne', label: msg('is not') },
  { op: 'gt', label: msg('is more than') },
  { op: 'gte', label: msg('is at least') },
  { op: 'lt', label: msg('is less than') },
  { op: 'lte', label: msg('is at most') },
  { op: 'contains', label: msg('contains') },
  { op: 'not_contains', label: msg('doesn’t contain') },
  { op: 'in', label: msg('is one of') },
  { op: 'not_in', label: msg('is none of') },
  { op: 'truthy', label: msg('is filled in'), unary: true },
  { op: 'falsy', label: msg('is empty'), unary: true },
  { op: 'regex', label: msg('matches pattern') },
]

type Compare = Extract<Condition, { kind: 'compare' }>

export function ConditionEditor({ atId, condition, onChange }: { atId: string; condition: Condition; onChange: (c: Condition) => void }) {
  const { readOnly } = useEditor()
  const flat = flatten(condition)
  if (!flat) return <span className="wf-cond-complex">{describeCondition(condition)}</span>
  const { join, clauses } = flat
  const emit = (next: Compare[], j = join) => onChange(next.length === 1 ? next[0] : { kind: j, items: next })
  return (
    <div className="wf-cond">
      {clauses.map((clause, i) => (
        <div key={i} className="wf-cond-row">
          {i > 0 ? (
            <select className="wf-select wf-cond-join" disabled={readOnly} value={join} onChange={(e) => emit(clauses, e.target.value as 'all' | 'any')}>
              <option value="all">{t('and')}</option>
              <option value="any">{t('or')}</option>
            </select>
          ) : null}
          <RefButton atId={atId} refValue={clause.left} placeholder={t('Choose data…')} onChange={(left) => emit(clauses.map((c, j) => (j === i ? { ...c, left } : c)))} />
          <select className="wf-select" disabled={readOnly} value={clause.op} onChange={(e) => {
            const op = e.target.value as ConditionOp
            const unary = OPS.find((o) => o.op === op)?.unary
            emit(clauses.map((c, j) => (j === i ? { kind: 'compare', left: c.left, op, ...(unary ? {} : { value: c.value ?? '' }) } : c)))
          }}>
            {OPS.map((o) => <option key={o.op} value={o.op}>{t(o.label)}</option>)}
          </select>
          {OPS.find((o) => o.op === clause.op)?.unary ? null : (
            <CompareValue value={clause.value} disabled={readOnly} onChange={(value) => emit(clauses.map((c, j) => (j === i ? { ...c, value } : c)))} />
          )}
          {clauses.length > 1 && !readOnly ? (
            <button type="button" className="icon-button" aria-label={t('Remove condition')} onClick={() => emit(clauses.filter((_, j) => j !== i))}><IcX size="sm" /></button>
          ) : null}
        </div>
      ))}
      {readOnly ? null : (
        <button type="button" className="link wf-cond-add" onClick={() => emit([...clauses, { kind: 'compare', left: null, op: 'eq', value: '' }])}>
          + {join === 'any' ? 'or' : 'and'}…
        </button>
      )}
    </div>
  )
}

function CompareValue({ value, disabled, onChange }: { value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value))
  return (
    <input className="wf-input wf-cond-value" disabled={disabled} value={text} placeholder={t('value')}
      onChange={(e) => {
        setText(e.target.value)
        const v = literal(e.target.value, 'json')
        onChange(v.kind === 'literal' ? v.value : '')
      }} />
  )
}

function flatten(c: Condition): { join: 'all' | 'any'; clauses: Compare[] } | null {
  if (c.kind === 'compare') return { join: 'all', clauses: [c] }
  if ((c.kind === 'all' || c.kind === 'any') && c.items.every((i) => i.kind === 'compare')) return { join: c.kind, clauses: c.items as Compare[] }
  return null
}

export function describeCondition(c: Condition): string {
  if (c.kind === 'compare') { const op = OPS.find((o) => o.op === c.op); return `${c.left ? t('data') : '…'} ${op ? t(op.label) : c.op}${op?.unary ? '' : ` ${JSON.stringify(c.value)}`}` }
  if (c.kind === 'not') return t('not ({condition})', { condition: describeCondition(c.item) })
  return c.items.map(describeCondition).join(c.kind === 'all' ? ` ${t('and')} ` : ` ${t('or')} `)
}
