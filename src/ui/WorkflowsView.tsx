// The Workflows section: the organization's workflows on the left
// (Mail-style), the open one on the right.
import { t, plural, msg } from './i18n'
import { Problem, Skeleton } from './primitives'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ResizeHandle } from './primitives'
import {
  IcAlertCircle, IcClock, IcFilter, IcPause, IcPlus, IcRefresh, IcSearch, IcWorkflows, IcX,
} from './icons'
import { confirmDialog, popupMenu } from './runtime'
import { Ago, Empty, Spinner } from './primitives'
import { ToolbarTitle } from './primitives'
import { currentHost } from './runtime'
import { activeFilters, allTags, emptyFilter, facetCounts, isFiltering, matches, sortSubjects, type FilterSubject, type HealthFacet, type RunsFacet, type SortOrder, type StatusFacet } from '../model/filters'
import { api, builder, catalog, isDirty, subjectOf, useBuilder, type Entry } from './store'
import { Popover } from './Popover'
import { RecipeEditor } from './RecipeEditor'
import { StepPicker } from './StepPicker'

export function WorkflowsView() {
  const { entries, selected, listLoading, listError, filter, facts, validation, usingStep, fullPage } = useBuilder()
  const org = currentHost().scopeKey ?? 'default'
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null)
  const filterButton = useRef<HTMLButtonElement>(null)

  useEffect(() => { void builder.load(org) }, [org])
  // Pick up saves made elsewhere (the web, the assistant) when the window comes back.
  useEffect(() => {
    const onFocus = () => { if (org) void builder.load(org) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [org])

  const open = entries.find((e) => e.key === selected) ?? null
  // Full page belongs to an open workflow, and to this section.
  useEffect(() => { if (!open && fullPage) builder.setFullPage(false) }, [open, fullPage])
  useEffect(() => () => builder.setFullPage(false), [])
  const subjects = useMemo(() => entries.map((e) => ({ entry: e, ...subjectOf(e, facts, validation[e.key]) })), [entries, facts, validation])
  const using = filter.usesStep && usingStep?.type === filter.usesStep ? usingStep.names : null
  const shown = sortSubjects(subjects.filter((s) => matches(s, filter, using)), filter.sort)
  const unsaved = shown.filter((s) => s.status === 'new')
  const saved = shown.filter((s) => s.status !== 'new')
  const total = entries.filter((e) => e.status !== 'new').length
  const filtering = isFiltering(filter)
  const chips = activeFilters(filter, (t) => catalog.get(t)?.title ?? t)
  const subtitle = listLoading ? t('Loading…') : filtering ? t('{shown} of {total} workflows', { shown: saved.length, total }) : plural(total, '{n} workflow', '{n} workflows')
  return (
    <div className={`wf-split${fullPage && open ? ' full' : ''}`}>
      <ResizeHandle id="builder.list" cssVar="--w-wf-list" defaultPx={280} min={200} max={520} className="at-list" label={t('Workflows list')} />
      <div className="column list-column">
        <header className="toolbar">
          <ToolbarTitle title={t('Workflows')} subtitle={subtitle} />
          <div className="toolbar-actions">
            <button type="button" className="toolbar-button" title={t('Reload')} aria-label={t('Reload')} onClick={() => void builder.load(org)}><IcRefresh size="md" /></button>
            {api.capabilities.draft !== false ? <button type="button" className="toolbar-button" title={t('New Workflow')} aria-label={t('New Workflow')} onClick={() => builder.create()}><IcPlus size="md" /></button> : null}
          </div>
        </header>
        <div className="wf-list-find">
          <label className="sidebar-search wf-list-search">
            <IcSearch size="sm" />
            <input placeholder={t('Search name, description, tag or id')} value={filter.text} onChange={(e) => builder.setFilter({ text: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape') builder.setFilter({ text: '' }) }} />
            {filter.text ? <button type="button" className="wf-search-clear" aria-label={t('Clear search')} onClick={() => builder.setFilter({ text: '' })}><IcX size="xs" /></button> : null}
          </label>
          <button ref={filterButton} type="button" className={`toolbar-button wf-filter-button${chips.length || filter.sort !== 'recent' ? ' on' : ''}`} title={t('Filter and sort')} aria-label={t('Filter and sort')}
            onClick={() => setFilterAnchor(filterAnchor ? null : filterButton.current)}>
            <IcFilter size="md" />{chips.length ? <span className="wf-filter-count">{chips.length}</span> : null}
          </button>
        </div>
        {chips.length ? (
          <div className="wf-filter-pills">
            {chips.map((c) => (
              <button key={c.id} type="button" className="wf-pill" title={t('Remove this filter')} onClick={() => builder.setFilter(c.clear(filter))}>{c.label}<IcX size="xs" /></button>
            ))}
            <button type="button" className="link small" onClick={() => builder.setFilter({ ...emptyFilter, text: filter.text, sort: filter.sort })}>{t('Clear')}</button>
          </div>
        ) : null}
        <ul className="list" role="listbox" aria-label={t('Workflows')}>
          {listError ? <li className="list-note"><Problem title={t('Couldn’t load the workflows.')} raw={listError} /></li> : null}
          {listLoading && !entries.length ? <li className="list-note"><Spinner /> {t('Loading workflows…')}</li> : null}
          {filter.usesStep && using === null ? <li className="list-note">{usingStep?.error ? <Problem title={t('Couldn’t search by that step.')} raw={usingStep.error} /> : <><Spinner /> {t('Finding workflows that use this step…')}</>}</li> : null}
          {unsaved.length ? <li className="list-heading">{t('Not saved yet')}</li> : null}
          {unsaved.map((s) => <Row key={s.key} entry={s.entry} subject={s} selected={s.key === selected} />)}
          {saved.length && unsaved.length ? <li className="list-heading">{t('Saved')}</li> : null}
          {saved.map((s) => <Row key={s.key} entry={s.entry} subject={s} selected={s.key === selected} />)}
          {!listLoading && !listError && !shown.length ? (
            <li className="list-note">{filtering ? <>{t('Nothing matches.')} <button type="button" className="link small" onClick={() => builder.setFilter({ ...emptyFilter, sort: filter.sort })}>{t('Show all')}</button></> : t('No workflows yet.')}</li>
          ) : null}
          {total >= 190 && !filtering ? <li className="list-note">{t('Showing the 200 most recent of each status.')}</li> : null}
        </ul>
        {filterAnchor ? <FilterPopover anchor={filterAnchor} subjects={subjects} onClose={() => setFilterAnchor(null)} /> : null}
      </div>
      <div className="column detail-column">
        {open?.recipe ? <RecipeEditor key={open.key} entry={open as Entry & { recipe: NonNullable<Entry['recipe']> }} /> : open ? (
          <>
            <header className="toolbar"><ToolbarTitle title={open.title} subtitle={open.error ? t('Couldn’t open') : t('Opening…')} /></header>
            {open.error ? <Problem title={t('Couldn’t open this workflow.')} raw={open.error} /> : <div className="pad"><Skeleton kind="card" /></div>}
          </>
        ) : (
          <>
            <header className="toolbar" />
            <Empty icon={<IcWorkflows size={28} />} title={t('Build a workflow')} detail="Describe what should happen, step by step. Pick a workflow on the left, or start a new one." />
            <div className="center" style={{ paddingBottom: 60 }}>
              {api.capabilities.draft !== false ? <button type="button" className="primary large" onClick={() => builder.create()}><IcPlus size="md" /> {t('New Workflow')}</button> : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function FilterPopover({ anchor, subjects, onClose }: { anchor: HTMLElement; subjects: FilterSubject[]; onClose: () => void }) {
  const { filter, facts, canFilterByStep, usingStep } = useBuilder()
  const [picking, setPicking] = useState(false)
  const using = filter.usesStep && usingStep?.type === filter.usesStep ? usingStep.names : null
  const counts = facetCounts(subjects, filter, using)
  // Tags that would show nothing with the other filters are left out (unless already chosen).
  const tags = allTags(subjects).filter((t) => filter.tags.includes(t) || (counts.tags[t] ?? 0) > 0)
  const toggleStatus = (s: StatusFacet) => builder.setFilter({ status: filter.status.includes(s) ? filter.status.filter((x) => x !== s) : [...filter.status, s] })
  const toggleTag = (t: string) => builder.setFilter({ tags: filter.tags.includes(t) ? filter.tags.filter((x) => x !== t) : [...filter.tags, t] })
  const option = (id: string, label: string, on: boolean, count: number | null, act: () => void, kind: 'check' | 'radio') => (
    <button key={id} type="button" role={kind === 'check' ? 'menuitemcheckbox' : 'menuitemradio'} aria-checked={on} data-filter={id}
      className={`wf-filter-option${on ? ' on' : ''}`} onClick={act}>
      <span className={`wf-filter-mark ${kind}`} aria-hidden>{on ? (kind === 'check' ? '✓' : '●') : ''}</span>
      <span className="wf-filter-label">{label}</span>
      {count !== null ? <span className="badge">{count}</span> : null}
    </button>
  )
  if (picking) {
    return <StepPicker catalog={catalog} title={t('Show workflows that use…')} onClose={() => setPicking(false)}
      onPick={(e) => { builder.setFilter({ usesStep: e.type }); setPicking(false) }} />
  }
  return (
    <Popover anchor={anchor} onClose={onClose} width={268} className="wf-filter-popover">
      <div className="wf-filter-body">
        <div className="wf-filter-head">{t('Status')}</div>
        {(['live', 'draft', 'new', 'edited'] as StatusFacet[]).map((s) =>
          option(`status:${s}`, t({ live: msg('Live'), draft: msg('Draft (not live yet)'), new: msg('Not saved'), edited: msg('Unsaved changes') }[s]), filter.status.includes(s), counts.status[s], () => toggleStatus(s), 'check'))}

        <div className="wf-filter-head">{t('Runs')}{facts ? null : <Spinner />}</div>
        {(['any', 'scheduled', 'paused', 'manual'] as RunsFacet[]).map((r) =>
          option(`runs:${r}`, t({ any: msg('Any'), scheduled: msg('On a schedule'), paused: msg('Schedule paused'), manual: msg('Not scheduled') }[r]), filter.runs === r, r === 'any' ? null : counts.runs[r], () => builder.setFilter({ runs: r }), 'radio'))}

        <div className="wf-filter-head">{t('Problems')}</div>
        {(['any', 'check', 'run'] as HealthFacet[]).map((h) =>
          option(`health:${h}`, t({ any: msg('Any'), check: msg('Check finds problems'), run: msg('Last run failed (7 days)') }[h]), filter.health === h, h === 'any' ? null : counts.health[h], () => builder.setFilter({ health: h }), 'radio'))}

        {tags.length ? (
          <>
            <div className="wf-filter-head">{t('Tags')}</div>
            {tags.map((t) => option(`tag:${t}`, `#${t}`, filter.tags.includes(t), counts.tags[t] ?? 0, () => toggleTag(t), 'check'))}
          </>
        ) : null}

        <div className="wf-filter-head">{t('Uses a step')}</div>
        {filter.usesStep ? (
          option('uses', catalog.get(filter.usesStep)?.title ?? filter.usesStep, true, using ? subjects.filter((s) => using.has(s.key)).length : null, () => builder.setFilter({ usesStep: null }), 'check')
        ) : (
          <button type="button" className="wf-filter-option" data-filter="uses:pick" disabled={!canFilterByStep} onClick={() => setPicking(true)}>
            <span className="wf-filter-mark check" aria-hidden />
            <span className="wf-filter-label">{canFilterByStep ? 'Choose a step…' : 'Choose a step… (coming soon)'}</span>
          </button>
        )}
        {!canFilterByStep ? <p className="wf-filter-hint">{t('Searching by step needs a platform update that is on its way.')}</p> : null}
      </div>
      <div className="wf-filter-foot">
        <span className="wf-filter-head inline">{t('Sort')}</span>
        <div className="segmented">
          {(['recent', 'name', 'steps'] as SortOrder[]).map((o) => (
            <button key={o} type="button" data-filter={`sort:${o}`} className={filter.sort === o ? 'selected' : ''} onClick={() => builder.setFilter({ sort: o })}>{t({ recent: msg('Recent'), name: msg('Name'), steps: msg('Steps') }[o])}</button>
          ))}
        </div>
      </div>
    </Popover>
  )
}

function Row({ entry, subject, selected }: { entry: Entry; subject: FilterSubject; selected: boolean }) {
  const dirty = isDirty(entry)
  // Live is the normal case: no color. Only what needs a look gets one (a draft to publish, never saved).
  const status = entry.status === 'live' ? (entry.unexposed ? ['dot-warning', t('Live · v{version} · not available to run', { version: entry.version })] : ['dot-none', t('Live · v{version}', { version: entry.version })]) : entry.status === 'draft' ? ['dot-warning', entry.live ? t('Draft v{version} · live v{live}', { version: entry.version, live: entry.live.version }) : t('Draft · v{version}', { version: entry.version })] : ['dot-muted', t('Not saved')]
  const menu = () => popupMenu([
    { label: t('Duplicate'), enabled: !!entry.recipe, action: () => builder.duplicate(entry.key) },
    ...(entry.status === 'new' ? ['separator' as const, { label: t('Delete Unsaved Workflow…'), action: () => void confirmDialog(t('Delete “{title}”? It was never saved.', { title: entry.title }), { title: t('Delete Workflow'), okLabel: t('Delete'), destructive: true }).then((ok) => { if (ok) builder.discard(entry.key) }) }]
      : dirty ? ['separator' as const, { label: t('Discard Unsaved Changes…'), action: () => void confirmDialog(t('Throw away your changes and go back to the saved version?'), { title: t('Discard Changes'), okLabel: t('Discard'), destructive: true }).then((ok) => { if (ok) builder.discard(entry.key) }) }] : []),
  ])
  return (
    <li>
      <button type="button" className={`row wf-row${selected ? ' selected' : ''}`} onClick={() => void builder.select(entry.key)} onContextMenu={(e) => { e.preventDefault(); void menu() }}>
        <span className={`dot ${status[0]}`} title={status[1]} />
        <span className="row-body">
          <span className="row-line">
            <span className="row-title">{entry.title || 'Untitled workflow'}</span>
            {dirty && entry.status !== 'new' ? <span className="row-meta" title={t('Unsaved changes')}>{t('Edited')}</span> : entry.updatedAt ? <span className="row-meta"><Ago iso={entry.updatedAt} /></span> : null}
          </span>
          <span className="row-sub">
            {entry.status === 'live' && !entry.unexposed ? `v${entry.version}` : status[1]} · {plural(entry.stepCount, '{n} step', '{n} steps')}
            <span className="wf-row-flags">
              {subject.schedule === 'active' ? <span title={t('Runs on a schedule')}><IcClock size="xs" /></span> : subject.schedule === 'paused' ? <span title={t('Schedule paused')}><IcPause size="xs" /></span> : null}
              {subject.lastRun === 'failed' ? <span className="danger" title={t('Its last run failed')}><IcAlertCircle size="xs" /></span> : null}
            </span>
          </span>
        </span>
      </button>
    </li>
  )
}
