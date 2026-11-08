// "Add a step": search by what you want to do, grouped by app.
import { t, msg } from './i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IcSearch } from './icons'
import type { Catalog, CatalogEntry } from '../model/catalog'

const COMMON = [
  'slack.message.send', 'slack.approval.request', 'aws.ses.send_email', 'ticket.open', 'ticket.comment', 'http.request',
  'control.value.format', 'control.value.build', 'control.predicate.compare', 'control.time.now', 'control.collection.slice', 'flow.wait',
]

/** Where a palette row's drag carries the step type. */
export const STEP_DRAG_TYPE = 'application/x-orkestia-step'

/**
 * Search the catalog by what should happen, grouped by app, with keyboard
 * choice. Shared by the "Add a step" sheet and the diagram's palette (where
 * rows can also be dragged onto the canvas).
 */
export function StepSearch({ catalog, onPick, onClose, filter, draggable = false, autoFocus = true, compact = false }: {
  catalog: Catalog
  onPick: (entry: CatalogEntry) => void
  onClose?: () => void
  filter?: (entry: CatalogEntry) => boolean
  /** Rows can be dragged (carry the type as STEP_DRAG_TYPE). */
  draggable?: boolean
  autoFocus?: boolean
  /** Narrow pane: no descriptions under the titles. */
  compact?: boolean
}) {
  const [query, setQuery] = useState('')
  const [app, setApp] = useState('')
  const [kind, setKind] = useState<'all' | 'reads' | 'changes'>('all')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const options = useMemo(() => ({ ...(app ? { app } : {}), ...(kind === 'all' ? {} : { readOnly: kind === 'reads' }) }), [app, kind])
  const narrowed = !!app || kind !== 'all'
  const results = useMemo(() => catalog.search(query, options).filter((e) => !filter || filter(e)), [catalog, query, options, filter])
  // With no search: the everyday steps first, then everything by app.
  const common = useMemo(() => (query.trim() || narrowed ? [] : COMMON.flatMap((t) => catalog.search(t).filter((e) => e.type === t && (!filter || filter(e))).slice(0, 1))), [catalog, query, narrowed, filter])
  const rest = results.filter((e) => !common.some((c) => c.type === e.type))
  const apps = query.trim() || app ? null : [...(common.length ? ['Common steps'] : []), ...new Set(rest.map((e) => e.app))]
  const appList = useMemo(() => catalog.apps?.() ?? [], [catalog])
  const inApp = (app: string) => (app === 'Common steps' ? common : rest.filter((e) => e.app === app))
  const ordered = apps ? apps.flatMap(inApp) : results

  useEffect(() => setActive(0), [query, app, kind])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(ordered.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter' && ordered[active]) { e.preventDefault(); onPick(ordered[active]) }
    else if (e.key === 'Escape' && onClose) { e.preventDefault(); e.stopPropagation(); onClose() }
  }

  let index = -1
  const row = (entry: CatalogEntry) => {
    index += 1
    const i = index
    return (
      <button key={entry.type} type="button" data-index={i} className={`wf-step-option${i === active ? ' active' : ''}`} title={entry.type}
        draggable={draggable || undefined}
        onDragStart={draggable ? (e) => { e.dataTransfer.setData(STEP_DRAG_TYPE, JSON.stringify({ type: entry.type, title: entry.title })); e.dataTransfer.effectAllowed = 'copy' } : undefined}
        onMouseEnter={() => setActive(i)} onClick={() => onPick(entry)}>
        <span className="wf-step-option-title">{entry.title}{entry.readOnly ? <span className="tag">{t('reads only')}</span> : null}{entry.asksPerson ? <span className="tag tag-accent">{t('waits for a person')}</span> : null}</span>
        {entry.description && !compact ? <span className="wf-step-option-desc">{entry.description}</span> : null}
        {apps || app ? null : <span className="wf-step-option-app">{entry.app}</span>}
      </button>
    )
  }

  return (
    <div className={`wf-step-search${compact ? ' compact' : ''}`} onKeyDown={onKey}>
      <label className="wf-search">
        <IcSearch size="sm" />
        <input autoFocus={autoFocus} placeholder={compact ? t('Search steps') : t('What should happen? e.g. send email, find customer')} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t('Search steps')} />
      </label>
      <div className="wf-picker-filters">
        {appList.length ? (
          <select className="wf-app-select" aria-label={t('App')} value={app} onChange={(e) => setApp(e.target.value)}>
            <option value="">{t('All apps')}</option>
            {appList.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        ) : null}
        <div className="segmented" role="radiogroup" aria-label={t('Kind of step')}>
          {([['all', msg('All')], ['reads', compact ? msg('Reads') : msg('Reads only')], ['changes', compact ? msg('Changes') : msg('Changes things')]] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'selected' : ''} onClick={() => setKind(k)}>{t(label)}</button>
          ))}
        </div>
      </div>
      <div className="wf-step-options" ref={list}>
        {ordered.length === 0 ? <p className="wf-picker-empty">{query ? (narrowed ? t('Nothing matches “{query}” with these filters.', { query }) : t('Nothing matches “{query}”.', { query })) : narrowed ? t('No steps here with these filters.') : t('No steps here.')}</p> : apps ? apps.map((app) => (
          <div key={app}>
            <div className="wf-picker-head">{app === 'Common steps' ? t('Common steps') : app}</div>
            {inApp(app).map(row)}
          </div>
        )) : ordered.map(row)}
      </div>
    </div>
  )
}

export function StepPicker({ catalog, onPick, onClose, filter, title = t('Add a step') }: {
  catalog: Catalog
  onPick: (entry: CatalogEntry) => void
  onClose: () => void
  filter?: (entry: CatalogEntry) => boolean
  title?: string
}) {
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet wf-step-picker" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        <StepSearch catalog={catalog} onPick={onPick} onClose={onClose} filter={filter} />
        <div className="sheet-actions">
          <span className="muted small spacer-left">{t('↑↓ to choose, ↩ to add')}</span>
          <button type="button" onClick={onClose}>{t('Cancel')}</button>
        </div>
      </div>
    </div>
  )
}
