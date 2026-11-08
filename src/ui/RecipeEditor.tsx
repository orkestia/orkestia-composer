// One workflow, read top to bottom: what it starts with, how it runs, its
// steps, and what it returns. Problems show on the step they belong to — ours
// at once, the platform's a moment later.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  IcAlertCircle, IcBraces, IcCheck, IcHistory, IcListOrdered, IcLock, IcMessageText, IcPause, IcPlay, IcPlus, IcSidebarCollapse, IcSidebarExpand, IcTrash, IcX,
} from './icons'
import { confirmDialog } from './runtime'
import { Spinner } from './primitives'
import { ToolbarTitle } from './primitives'
import type { CatalogEntry, FieldType } from '../model/catalog'
import { check, type Fix } from '../model/check'
import type { compile } from '../model/compile'
import { numbered } from '../model/data'
import { renameInput, uid, uniqueName, slug, updateBlock, type Recipe, type RecipeInput, type RunMode } from '../model/recipe'
import type { Dependents, SaveResult, Schedule } from './host'
import { api, builder, catalog, CHECK_INPUT_LIMIT, compileFor, isDirty, useBuilder, type Entry } from './store'
import { AssistantPanel, useHasAssistant } from './AssistantPanel'
import { BlockList } from './blocks'
import { EditorContext, useEditor as useEditorCtx, type EditorApi } from './context'
import { ValueField } from './fields'
import { RunSheet, RunsPanel, RunStatusBar } from './runs'
import { SaveSheet } from './SaveSheet'
import { StepPicker } from './StepPicker'
import { DiagramCanvas } from './diagram/DiagramCanvas'
import { blockTitle } from '../model/graph'
import { findBlock } from '../model/recipe'
import { isMac } from './runtime'
import { intlLocale, t, plural, msg } from './i18n'
import { CadenceFields, PlannedRuns } from './schedule'
import { runsCadence } from '../model/schedule'

/** Typing in a field: its own undo, Esc and arrows belong to it. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

const TYPES: Array<[FieldType, string]> = [
  ['string', msg('Text')], ['text', msg('Long text')], ['integer', msg('Number')], ['boolean', msg('Yes / no')], ['email', msg('Email')],
  ['datetime', msg('Date')], ['uuid', msg('ID')], ['list', msg('List')], ['dict', msg('Record')], ['json', msg('Anything')],
]

export function RecipeEditor({ entry }: { entry: Entry & { recipe: Recipe } }) {
  const { panel, validation, runs, saving, schedules, lastSave, view, fullPage } = useBuilder()
  const catalogVersion = useSyncExternalStore(catalog.subscribe, () => catalog.version)
  const recipe = entry.recipe
  const key = entry.key
  const [unlocked, setUnlocked] = useState(false)
  // A caller who may neither draft nor publish sees the workflow and can't change it;
  // one who may draft but not publish edits and saves drafts that someone else publishes.
  const canPublish = api.capabilities.publish !== false
  const canEdit = api.capabilities.draft !== false
  const canRunAtAll = api.capabilities.run !== false
  const hasAssistant = useHasAssistant()
  const readOnlyReasons = canEdit ? recipe.readOnly : [t('You can view this workflow but not change it')]
  const readOnly = readOnlyReasons.length > 0 && (!unlocked || !canEdit)
  const [picking, setPicking] = useState<{ onPick: (e: CatalogEntry) => void; filter?: (e: CatalogEntry) => boolean } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string; detail?: string[]; action?: { label: string; run: () => void } } | null>(null)
  /** The newer version the person chose to save over ("Save Anyway"), for the save that follows. */
  const overVersion = useRef<number | undefined>(undefined)
  /** The summary shown before saving: who uses this workflow, and questions found in it that the save declares. */
  const [confirmSave, setConfirmSave] = useState<{ deps: Dependents | { error: string } | null; found: RecipeInput[] } | null>(null)
  const [runSheet, setRunSheet] = useState(false)
  const [conflict, setConflict] = useState<{ base: number; theirs: number } | null>(null)
  /** What the assistant is asked about, picked on the diagram. */
  const [focus, setFocus] = useState<string[]>([])
  const dirty = isDirty(entry)
  const isSaving = !!saving[key]
  const run = runs[key] ?? null
  const v = validation[key]

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const compiled = useMemo(() => compileFor(recipe), [recipe, catalogVersion])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const local = useMemo(() => check(recipe, catalog), [recipe, catalogVersion])
  const problems = useMemo(() => {
    const server = (v?.problems ?? []).filter((p) => !local.some((q) => q.at === p.at && q.field === p.field))
    return [...local, ...server]
  }, [local, v])
  const errors = problems.filter((p) => p.severity === 'error')

  // Ask the platform once edits settle.
  useEffect(() => {
    if (readOnly || !recipe.blocks.length) return
    const t = window.setTimeout(() => void builder.validate(key), 900)
    return () => window.clearTimeout(t)
  }, [key, compiled, readOnly, recipe.blocks.length])

  useEffect(() => { setUnlocked(false); setNotice(null) }, [key])
  const saved = lastSave[key]
  useEffect(() => { if (saved && Date.now() - saved.at < 60_000) setNotice(describeSave(saved.result, saved.children)) }, [saved])

  const update = useCallback((change: (r: Recipe) => Recipe) => builder.update(key, change), [key])
  const applyFix = useCallback((fix: Fix) => update((r) => ({
    ...r,
    blocks: updateBlock(r.blocks, fix.at, (b) => (b.kind === 'step' ? { ...b, fields: { ...b.fields, [fix.field]: { kind: 'ref', ref: { kind: 'step', step: fix.producer, path: fix.path } } } } : b)),
  })), [update])
  const ctx: EditorApi = useMemo(() => ({
    recipe, catalog, problems, readOnly,
    numbers: numbered(recipe.blocks),
    runSteps: run?.steps ?? {},
    runFailures: run?.failures ?? {},
    runOutput: run?.output ?? null,
    applyFix,
    fieldOptions: (type, partial) => api.fieldOptions(type, partial),
    update,
    pickStep: (_anchor, onPick, filter) => setPicking({ onPick, filter }),
  }), [recipe, problems, readOnly, run, update, applyFix])

  const doSave = useCallback(async (declareFound = true) => {
    setConfirmSave(null)
    const out = await builder.save(key, { declareFound, overVersion: overVersion.current })
    overVersion.current = undefined
    if (!('error' in out)) return
    // Someone published a newer version meanwhile: the same "warn, then save" as before saving.
    if (out.conflict) { setConflict(out.conflict); return }
    setNotice({
      tone: 'error', text: t('Couldn’t save: {error}', { error: out.error }),
      // The same attempt again: it can't publish twice.
      ...(out.retry ? { action: { label: t('Retry'), run: () => { setNotice(null); void doSaveRef.current(declareFound) } } } : {}),
    })
  }, [key])
  const doSaveRef = useRef(doSave)
  doSaveRef.current = doSave

  const save = useCallback(async (over?: number) => {
    if (readOnly || isSaving) return
    overVersion.current = over
    if (entry.head && over === undefined) {
      // Someone saved a newer version meanwhile: warn, then save (theirs isn't merged in).
      const base = entry.conflict?.base ?? entry.version
      const remote = await builder.remoteVersion(key)
      const theirs = Math.max(entry.conflict?.theirs ?? 0, remote ?? 0)
      if (theirs > base) { setConflict({ base, theirs }); return }
    }
    setConflict(null)
    // Then one sheet for what the save touches: who uses it, and questions found in it.
    const found = recipe.inputs.filter((i) => i.found && !i.hidden)
    const deps = entry.head ? await builder.dependents(key) : null
    const shown = deps && ('error' in deps || deps.dependent_count > 0) ? deps : null
    if (shown || found.length) { setConfirmSave({ deps: shown, found }); return }
    await doSave()
  }, [readOnly, isSaving, recipe.inputs, entry.head, entry.conflict, entry.version, key, doSave])

  // ⌘S saves, ⌘Z / ⇧⌘Z undo and redo (both views share them), ⇧⌘F full page, Esc leaves it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); builder.setFullPage(!builder.state.fullPage); return }
      if (typing(e.target) || document.querySelector('.sheet-backdrop, .k-sheet-layer')) return
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) builder.redo(key); else builder.undo(key); return }
      if (mod && e.key.toLowerCase() === 'y' && !isMac) { e.preventDefault(); builder.redo(key); return }
      if (e.key === 'Escape' && !e.defaultPrevented && builder.state.fullPage) { e.preventDefault(); builder.setFullPage(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, key])

  const discuss = useCallback((ids: string[]) => {
    setFocus(ids)
    builder.openPanel('assistant')
  }, [])
  const focusBlocks = focus.map((id) => findBlock(recipe.blocks, id)?.block).filter((b): b is NonNullable<typeof b> => !!b)

  const canRun = !!entry.live && !dirty && entry.status === 'live' && !entry.unexposed
  const runTitle = !entry.live ? t('Save it live first') : entry.unexposed ? t('Not available to run here: publish it again') : dirty || entry.status !== 'live' ? t('Save your changes first: runs use the live version') : t('Run the live version')

  return (
    <EditorContext.Provider value={ctx}>
      <div className="wf-editor">
        <header className="toolbar">
          <ToolbarTitle title={recipe.title || t('Untitled workflow')} subtitle={statusLine(entry, dirty, v?.pending)} />
          <div className="toolbar-actions">
            <div className="segmented wf-view-toggle" role="radiogroup" aria-label={t('Show as')}>
              <button type="button" role="radio" aria-checked={view === 'steps'} className={view === 'steps' ? 'selected' : ''} title={t('The steps, read top to bottom')} onClick={() => builder.setView('steps')}>{t('Steps')}</button>
              <button type="button" role="radio" aria-checked={view === 'diagram'} className={view === 'diagram' ? 'selected' : ''} title={t('The workflow as a diagram you can edit')} onClick={() => builder.setView('diagram')}>{t('Diagram')}</button>
            </div>
            <button type="button" className={`toolbar-button${fullPage ? ' on' : ''}`} title={fullPage ? t('Leave full page (Esc)') : t('Open full page: the diagram takes the whole window (⇧⌘F)')} aria-label={fullPage ? t('Leave full page') : t('Open full page')} aria-pressed={fullPage}
              onClick={() => builder.setFullPage(!fullPage)}>{fullPage ? <IcSidebarExpand size="md" /> : <IcSidebarCollapse size="md" />}</button>
            <span className="wf-toolbar-sep" />
            <button type="button" className={`toolbar-button${panel === 'order' ? ' on' : ''}`} title={t('Run order')} aria-label={t('Run order')} onClick={() => builder.setPanel('order')}><IcListOrdered size="md" /><span className="wf-tb-label">{t('Run order')}</span></button>
            <button type="button" className={`toolbar-button${panel === 'runs' ? ' on' : ''}`} title={t('Past runs')} aria-label={t('Past runs')} disabled={!entry.head} onClick={() => builder.setPanel('runs')}><IcHistory size="md" /><span className="wf-tb-label">{t('Runs')}</span></button>
            <button type="button" className={`toolbar-button${panel === 'json' ? ' on' : ''}`} title={t('Saved definition (JSON)')} aria-label={t('JSON')} onClick={() => builder.setPanel('json')}><IcBraces size="md" /><span className="wf-tb-label">{t('JSON')}</span></button>
            {hasAssistant ? <button type="button" className={`toolbar-button${panel === 'assistant' ? ' on' : ''}`} title={t('Discuss with the assistant')} aria-label={t('Assistant')} onClick={() => builder.setPanel('assistant')}><IcMessageText size="md" /><span className="wf-tb-label">{t('Assistant')}</span></button> : null}
            <button type="button" title={t('Check it with the platform, running the steps that only read')} disabled={!recipe.blocks.length || v?.pending} onClick={() => void builder.validate(key, true)}>
              {v?.pending && v.dryRun ? <Spinner /> : <IcCheck size="sm" />}<span className="wf-btn-label"> {t('Test run')}</span>
            </button>
            {canRunAtAll ? <button type="button" title={runTitle} disabled={!canRun || run?.status === 'running'} onClick={() => setRunSheet(true)} aria-label={t('Run…')}><IcPlay size="sm" /><span className="wf-btn-label"> {t('Run…')}</span></button> : null}
            {canEdit ? <button type="button" className="primary" title={readOnly ? t('This workflow is read-only') : !dirty && entry.status !== 'new' ? t('Nothing to save: no changes since this version') : canPublish ? t('Save (⌘S)') : t('Save a draft (⌘S); someone who can publish makes it live')} onClick={() => void save()} disabled={readOnly || isSaving || (!dirty && entry.status !== 'new')}>
              {isSaving ? <Spinner /> : null} {canPublish ? t('Save') : t('Save Draft')}
            </button> : null}
          </div>
        </header>
        {run ? <RunStatusBar entryKey={key} run={run} recipe={recipe} /> : null}
        {view === 'diagram' && (notice || entry.conflict || (dirty && entry.head) || errors.length) ? (
          <div className="dg-statusline">
            {entry.conflict ? <span className="wf-checking warn"><IcAlertCircle size="xs" /> {t('Someone saved version {theirs} while you edited version {base}. Saving warns first.', { theirs: entry.conflict.theirs, base: entry.conflict.base })}</span> : null}
            {errors.length ? <span className="wf-problem-summary static"><IcAlertCircle size="xs" /> {plural(errors.length, '{n} thing to fix before it can go live — marked on the boxes', '{n} things to fix before it can go live — marked on the boxes')}</span> : null}
            {dirty && entry.head ? <span className="dg-hint">{t('Unsaved changes since version {version}.', { version: entry.version })} <button type="button" className="link" onClick={() => void confirmDialog(t('Throw away your changes and go back to the saved version?'), { title: t('Discard Changes'), okLabel: t('Discard'), destructive: true }).then((ok) => { if (ok) builder.discard(key) })}>{t('Discard')}</button></span> : null}
            {notice ? <span className={`wf-checking ${notice.tone === 'ok' ? 'ok' : 'warn'}`}>{notice.text}{notice.action ? <button type="button" className="link" onClick={notice.action.run}>{notice.action.label}</button> : null}<button type="button" className="icon-button" aria-label={t('Dismiss')} onClick={() => setNotice(null)}><IcX size="xs" /></button></span> : null}
          </div>
        ) : null}
        <div className="wf-editor-body">
          {view === 'diagram' ? (
            <DiagramCanvas entry={entry} compiled={compiled} readOnlyReasons={readOnlyReasons} onUnlock={canEdit ? () => setUnlocked(true) : undefined} onDiscuss={hasAssistant ? discuss : undefined} />
          ) : (
          <div className="wf-scroll">
            <div className="wf-doc">
              {readOnly ? (
                <div className="callout wf-readonly">
                  <IcLock size="sm" />
                  <div>
                    <strong>{t('Opened read-only.')}</strong> {readOnlyReasons.join('; ')}.
                    {canEdit ? <div className="button-row" style={{ marginTop: 8 }}>
                      <button type="button" onClick={() => builder.duplicate(key)}>{t('Edit a Copy')}</button>
                      <button type="button" className="link" onClick={() => setUnlocked(true)}>{t('Edit anyway')}</button>
                    </div> : null}
                  </div>
                </div>
              ) : null}
              {notice ? (
                <div className={`callout wf-notice ${notice.tone}`}>
                  {notice.tone === 'ok' ? <IcCheck size="sm" /> : <IcAlertCircle size="sm" />}
                  <div>
                    {notice.text}
                    {notice.detail?.length ? <ul className="wf-notice-list">{notice.detail.map((d, i) => <li key={i}>{d}</li>)}</ul> : null}
                    {notice.action ? <div className="button-row"><button type="button" onClick={notice.action.run}>{notice.action.label}</button></div> : null}
                  </div>
                  <button type="button" className="icon-button" aria-label={t('Dismiss')} onClick={() => setNotice(null)}><IcX size="sm" /></button>
                </div>
              ) : null}
              {dirty && entry.head ? (
                <p className="wf-unsaved">{t('Unsaved changes since version {version}.', { version: entry.version })} <button type="button" className="link" onClick={() => void confirmDialog(t('Throw away your changes and go back to the saved version?'), { title: t('Discard Changes'), okLabel: t('Discard'), destructive: true }).then((ok) => { if (ok) builder.discard(key) })}>{t('Discard')}</button></p>
              ) : null}
              <input className="wf-doc-title" value={recipe.title} disabled={readOnly} placeholder={t('Name this workflow')} aria-label={t('Workflow name')}
                onChange={(e) => update((r) => ({ ...r, title: e.target.value, ...(entry.status === 'new' ? { name: slug(e.target.value, 'workflow').replace(/_/g, '-') } : {}) }))} />
              <textarea className="wf-doc-desc" rows={1} value={recipe.description} disabled={readOnly} placeholder={t('What does it do? (optional)')}
                onChange={(e) => update((r) => ({ ...r, description: e.target.value }))} />
              <CheckSummary errors={errors.length} pending={!!v?.pending} failed={v?.error ?? null} empty={!recipe.blocks.length} dryRun={v?.dryRun && !v.pending ? v.result?.dry_run ?? null : null} tooLarge={v?.tooLarge ?? null} />
              {problems.filter((p) => !p.at && p.source === 'platform').map((p, i) => <p key={i} className={`wf-problem ${p.severity}`}><IcAlertCircle size="xs" /> {p.message}</p>)}

              <StartsWith />
              <Runs entry={entry} schedules={schedules[key] ?? []} />

              <h2 className="wf-section-title">{t('Steps')}</h2>
              <BlockList blocks={recipe.blocks} parent={null} />

              <Returns />
            </div>
          </div>
          )}
          {panel === 'order' ? <RunOrder rounds={compiled.rounds} /> : null}
          {panel === 'json' ? <JsonPanel definition={compiled.definition} children={compiled.children} /> : null}
          {panel === 'runs' ? <RunsPanel entry={entry} /> : null}
          {panel === 'assistant' ? <AssistantPanel entry={entry} dirty={dirty}
            focus={focusBlocks.map((b) => ({ title: blockTitle(b), name: b.kind === 'step' ? b.name : b.kind, type: b.kind === 'step' ? b.workflowType : undefined }))}
            onClearFocus={() => setFocus([])} /> : null}
        </div>
      </div>
      {picking ? (
        <StepPicker catalog={catalog} filter={picking.filter} title={picking.filter ? t('Choose a step') : t('Add a step')}
          onClose={() => setPicking(null)} onPick={(e) => { setPicking(null); picking.onPick(e) }} />
      ) : null}
      {conflict ? <ConflictSheet conflict={conflict} onCancel={() => setConflict(null)} onSave={() => void save(conflict.theirs)} /> : null}
      {confirmSave ? <SaveSheet deps={confirmSave.deps} found={confirmSave.found} version={entry.version} onCancel={() => setConfirmSave(null)} onSave={(declare) => void doSave(declare)} /> : null}
      {runSheet ? <RunSheet entry={entry} onClose={() => setRunSheet(false)} /> : null}
    </EditorContext.Provider>
  )
}

function describeSave(result: SaveResult, children: SaveResult[]): { tone: 'ok' | 'warn' | 'error'; text: string; detail?: string[] } {
  if (result.unchanged) return { tone: 'ok', text: t('No changes to save — version {version} is current.', { version: result.version }) }
  const detail: string[] = []
  for (const c of children) if (c.status !== 'active') detail.push(t('The steps repeated per item saved as a draft: {problem}', { problem: c.validation_errors[0] ?? t('see its problems') }))
  for (const d of result.stale_dependents ?? []) detail.push(t('{what} still uses version {versions}.', { what: `${d.site ?? t('Something')}${d.uuid ? ` (${String(d.uuid).slice(0, 8)})` : ''}`, versions: result.superseded_versions?.join(', ') ?? t('the previous one') }))
  if (result.status === 'active') return { tone: detail.length ? 'warn' : 'ok', text: t('Saved version {version} — it’s live.', { version: result.version }), detail }
  const n = result.validation_errors.length
  return { tone: 'warn', text: plural(n, 'Saved version {version} as a draft. The platform found {n} thing to fix before it can go live.', 'Saved version {version} as a draft. The platform found {n} things to fix before it can go live.', { version: result.version }), detail: [...result.validation_errors.slice(0, 5), ...detail] }
}

function statusLine(entry: Entry, dirty: boolean, checking?: boolean): string {
  const parts: string[] = []
  if (entry.status === 'new') parts.push(t('Not saved yet'))
  else if (entry.status === 'live') parts.push(t('Live · version {version}', { version: entry.version }))
  else parts.push(entry.live ? t('Draft version {version} · live is {live}', { version: entry.version, live: entry.live.version }) : t('Draft · version {version}', { version: entry.version }))
  if (dirty && entry.status !== 'new') parts.push(t('unsaved changes'))
  if (entry.conflict) parts.push(t('version {version} saved by someone else', { version: entry.conflict.theirs }))
  if (checking) parts.push(t('checking…'))
  return parts.join(' · ')
}

function CheckSummary({ errors, pending, failed, empty, dryRun, tooLarge }: { errors: number; pending: boolean; failed: string | null; empty: boolean; dryRun: { passed: boolean; evaluated: boolean } | null; tooLarge: number | null }) {
  if (empty) return null
  return (
    <div className="wf-check-summary">
      {errors ? (
        <button type="button" className="wf-problem-summary" onClick={() => document.querySelector('.wf-card.has-errors, .wf-problem.error')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          <IcAlertCircle size="sm" /> {plural(errors, '{n} thing to fix before it can go live', '{n} things to fix before it can go live')}
        </button>
      ) : pending || failed ? null : <span className="wf-ok"><IcCheck size="sm" /> {t('Ready to go live')}</span>}
      {pending ? <span className="wf-checking"><Spinner /> {t('Checking with the platform…')}</span> : null}
      {failed ? <span className="wf-checking warn">{t('Couldn’t check with the platform: {error}', { error: failed })}</span> : null}
      {tooLarge ? <span className="wf-checking warn" title={t('The quick check accepts at most {limit} KB of input')}>{t('Too large for the quick check ({size} KB, limit {limit} KB) — it is checked fully when you save.', { size: Math.round(tooLarge / 1024), limit: CHECK_INPUT_LIMIT / 1024 })}</span> : null}
      {dryRun ? <span className={`wf-checking ${dryRun.passed ? 'ok' : 'warn'}`}>{!dryRun.evaluated ? t('Test run couldn’t try the steps') : dryRun.passed ? t('Test run passed') : t('Test run found problems')}</span> : null}
    </div>
  )
}

function ConflictSheet({ conflict, onCancel, onSave }: { conflict: { base: number; theirs: number }; onCancel: () => void; onSave: () => void }) {
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }}>
      <div className="sheet wf-deps" role="dialog" aria-label={t('Someone else changed it')}>
        <h3>{t('Someone else changed this workflow')}</h3>
        <p className="muted small">{t('You started from version {base}; version {theirs} was saved since. Saving makes yours the newest version — what changed in version {theirs} won’t be in it. Your edits are kept either way.', { base: conflict.base, theirs: conflict.theirs })}</p>
        <div className="sheet-actions">
          <button type="button" autoFocus onClick={onCancel}>{t('Cancel')}</button>
          <button type="button" className="primary" onClick={onSave}>{t('Save Anyway')}</button>
        </div>
      </div>
    </div>
  )
}

// ---- Starts with ----

export function StartsWith() {
  const { recipe, update, readOnly, problems } = useEditorCtx()
  const visible = recipe.inputs.filter((i) => !i.hidden)
  const set = (id: string, patch: Partial<Recipe['inputs'][number]>) => update((r) => ({ ...r, inputs: r.inputs.map((i) => (i.id === id ? { ...i, ...patch } : i)) }))
  const general = problems.filter((p) => !p.at && /question/i.test(p.message))
  return (
    <section className="wf-section">
      <h2 className="wf-section-title">{t('Starts with')}</h2>
      <p className="wf-section-hint">{t('What to ask when it runs. Use the answers in any step.')}</p>
      {visible.length ? (
        <div className="wf-inputs">
          {visible.map((input) => (
            <div key={input.id} className="wf-input-row">
              <input className="wf-input" value={input.label} disabled={readOnly} placeholder={t('Question')} aria-label={t('Question')}
                onChange={(e) => {
                  const label = e.target.value
                  update((r) => {
                    const withLabel = { ...r, inputs: r.inputs.map((i) => (i.id === input.id ? { ...i, label } : i)) }
                    if (!input.autoName) return withLabel
                    // Not saved yet: the machine name follows the label, and so does everything using it.
                    const name = uniqueName(slug(label, 'answer'), new Set(r.inputs.filter((i) => i.id !== input.id).map((i) => i.name)))
                    return name === input.name ? withLabel : renameInput(withLabel, input.name, name)
                  })
                }} />
              <select className="wf-select" disabled={readOnly} value={input.type} onChange={(e) => set(input.id, { type: e.target.value as FieldType })}>
                {TYPES.map(([type, l]) => <option key={type} value={type}>{t(l)}</option>)}
              </select>
              <label className="wf-check"><input type="checkbox" disabled={readOnly} checked={input.required} onChange={(e) => set(input.id, { required: e.target.checked })} /> {t('Required')}</label>
              {input.found ? <span className="tag" title={t('The steps read this, but the workflow never declared it')}>{t('Found in this workflow')}</span> : null}
              {readOnly ? null : <button type="button" className="icon-button" aria-label={t('Remove question')} onClick={() => update((r) => ({ ...r, inputs: r.inputs.filter((i) => i.id !== input.id) }))}><IcX size="sm" /></button>}
            </div>
          ))}
        </div>
      ) : null}
      {visible.some((i) => i.found) ? <p className="wf-section-hint">{t('Found in this workflow: its steps already read these without declaring them. Saving declares them.')}</p> : null}
      {general.map((p, i) => <p key={i} className="error-text">{p.message}</p>)}
      {readOnly ? null : (
        <button type="button" className="link wf-add-input" onClick={() => update((r) => {
          const name = uniqueName('answer', new Set(r.inputs.map((i) => i.name)))
          return { ...r, inputs: [...r.inputs, { id: uid('i'), name, label: '', type: 'string', required: true, autoName: true }] }
        })}><IcPlus size="xs" /> {t('Ask for something')}</button>
      )}
    </section>
  )
}

// ---- Runs ----

function Runs({ entry, schedules }: { entry: Entry; schedules: Schedule[] }) {
  const { recipe, update, readOnly } = useEditorCtx()
  const modes: Array<[RunMode, string]> = [['manual', t('When started')], ['app', t('From an app')], ['schedule', t('On a schedule')]]
  const asked = recipe.inputs.filter((i) => !i.hidden)
  const schedule = schedules[0]
  const key = entry.key
  const rules = api.scheduleRules
  return (
    <section className="wf-section">
      <h2 className="wf-section-title">{t('Runs')}</h2>
      <div className="wf-runs">
        <div className="segmented">
          {modes.map(([mode, label]) => (
            <button key={mode} type="button" disabled={readOnly} className={recipe.runs.mode === mode ? 'selected' : ''}
              onClick={() => update((r) => ({ ...r, runs: { ...r.runs, mode } }))}>{label}</button>
          ))}
        </div>
        {recipe.runs.mode === 'schedule' ? (
          <CadenceFields runs={recipe.runs} disabled={readOnly} expressions={rules.expressions} minMinutes={rules.minMinutes}
            onChange={(change) => update((r) => {
              const runs = { ...r.runs, ...change }
              if ('cron' in change && change.cron === undefined) { delete runs.cron; delete runs.timezone }
              return { ...r, runs }
            })} />
        ) : null}
      </div>
      {recipe.runs.mode === 'schedule' ? <PlannedRuns cadence={runsCadence(recipe.runs)} minMinutes={rules.minMinutes} nextRunAt={schedule?.active ? schedule.next_run_at : null} /> : null}
      <span className="wf-section-hint">
        {recipe.runs.mode === 'app' ? t('Your apps can start it for their users once it’s exposed to an app.') : recipe.runs.mode === 'schedule' ? t('Starts by itself with the answers below. Saving sets up the schedule.') : t('Start it from here, the assistant or another workflow.')}
      </span>
      {recipe.runs.mode === 'schedule' && asked.length ? (
        <div className="wf-answers">
          {asked.map((input) => (
            <div key={input.id} className="wf-field">
              <label className="wf-field-label">{input.label || input.name}{input.required ? <span className="wf-req">•</span> : null}</label>
              <input className="wf-input" disabled={readOnly} value={String(recipe.runs.answers?.[input.name] ?? '')}
                onChange={(e) => update((r) => ({ ...r, runs: { ...r.runs, answers: { ...(r.runs.answers ?? {}), [input.name]: e.target.value } } }))} />
            </div>
          ))}
        </div>
      ) : null}
      {schedule ? (
        <div className="wf-schedule">
          <span className={`dot ${schedule.active ? 'dot-success' : 'dot-muted'}`} />
          <span>{schedule.active ? (schedule.schedule_expression ? t('Scheduled at “{expression}” ({zone})', { expression: schedule.schedule_expression, zone: schedule.timezone || 'UTC' }) : t('Scheduled every {minutes} min', { minutes: schedule.interval_minutes })) : t('Schedule paused')}{schedule.active && schedule.next_run_at ? t(' · next {when}', { when: new Date(schedule.next_run_at).toLocaleString(intlLocale()) }) : ''}</span>
          <button type="button" className="link" onClick={() => void builder.setScheduleActive(key, schedule.schedule_uuid, !schedule.active)}>{schedule.active ? <><IcPause size="xs" /> {t('Pause')}</> : <><IcPlay size="xs" /> {t('Resume')}</>}</button>
          <button type="button" className="link danger" onClick={() => void confirmDialog(t('Delete this schedule? The workflow stays; it just stops starting by itself.'), { title: t('Delete Schedule'), okLabel: t('Delete'), destructive: true }).then((ok) => { if (ok) void builder.deleteSchedule(key, schedule.schedule_uuid) })}><IcTrash size="xs" /> {t('Delete')}</button>
        </div>
      ) : null}
    </section>
  )
}

// ---- Returns ----

export function Returns() {
  const { recipe, update, readOnly } = useEditorCtx()
  return (
    <section className="wf-section">
      <h2 className="wf-section-title">{t('Returns')}</h2>
      <p className="wf-section-hint">{t('What whoever started it gets back.')}</p>
      {recipe.returns.map((ret) => (
        <div key={ret.id} className="wf-field">
          <input className="wf-input wf-return-name" value={ret.name} disabled={readOnly} placeholder={t('name')} aria-label={t('Returned value name')}
            onChange={(e) => update((r) => ({ ...r, returns: r.returns.map((x) => (x.id === ret.id ? { ...x, name: e.target.value } : x)) }))} />
          <div className="wf-field-body wf-return-value">
            <ValueField atId={null} field={{ name: ret.name || 'value', type: 'json' }} onAskField={false} value={ret.value}
              onChange={(value) => update((r) => ({ ...r, returns: r.returns.map((x) => (x.id === ret.id ? { ...x, value } : x)) }))} />
            {readOnly ? null : <button type="button" className="icon-button" aria-label={t('Remove')} onClick={() => update((r) => ({ ...r, returns: r.returns.filter((x) => x.id !== ret.id) }))}><IcX size="sm" /></button>}
          </div>
        </div>
      ))}
      {readOnly ? null : (
        <button type="button" className="link wf-add-input" onClick={() => update((r) => ({ ...r, returns: [...r.returns, { id: uid('r'), name: '', value: { kind: 'empty' } }] }))}>
          <IcPlus size="xs" /> Return a value
        </button>
      )}
    </section>
  )
}

// ---- Side panels ----

function RunOrder({ rounds }: { rounds: ReturnType<typeof compile>['rounds'] }) {
  return (
    <aside className="wf-panel">
      <h3 className="wf-panel-title">{t('Run order')}</h3>
      <p className="wf-section-hint">{t('Worked out from what each step uses. Steps in the same round run at the same time.')}</p>
      <ol className="wf-rounds">
        {rounds.map((round, i) => (
          <li key={i} className="wf-round">
            <span className="wf-round-num">{i + 1}</span>
            <div className="wf-round-steps">
              {round.repeat ? <span className="wf-round-note">{t('repeats up to {n}×', { n: round.repeat })}</span> : null}
              {round.titles.map((t, j) => <span key={j} className={`wf-round-step${t.startsWith('Write the ') ? ' helper' : ''}`}>{t}</span>)}
            </div>
          </li>
        ))}
      </ol>
    </aside>
  )
}

function JsonPanel({ definition, children }: { definition: unknown; children: ReturnType<typeof compile>['children'] }) {
  return (
    <aside className="wf-panel wf-json">
      <h3 className="wf-panel-title">{t('Saved definition')}</h3>
      <p className="wf-section-hint">{t('What is saved. Read-only.')}</p>
      <pre>{JSON.stringify(definition, null, 2)}</pre>
      {children.map((c) => (
        <details key={c.name} open>
          <summary>Runs per item: {c.name}</summary>
          <pre>{JSON.stringify(c.definition, null, 2)}</pre>
        </details>
      ))}
    </aside>
  )
}
