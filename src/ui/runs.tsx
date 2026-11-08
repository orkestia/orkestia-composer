// Running a workflow for real: the form for its "Starts with" answers, the bar
// that follows the run on the cards, and the list of past runs.
import { t, msg } from './i18n'
import { Problem, Skeleton } from './primitives'
import { useEffect, useState } from 'react'
import { IcAlertCircle, IcDone, IcPlay, IcX } from './icons'
import { Ago, Spinner } from './primitives'
import type { Json } from './host'
import { literal } from '../model/text'
import type { Recipe } from '../model/recipe'
import type { RunRow } from './host'
import { compile } from '../model/compile'
import { api, builder, catalog, type Entry, type RunView } from './store'

export function RunSheet({ entry, onClose }: { entry: Entry & { recipe: Recipe }; onClose: () => void }) {
  const asked = entry.recipe.inputs.filter((i) => !i.hidden)
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(asked.map((i) => [i.name, String(entry.recipe.runs.answers?.[i.name] ?? '')])))
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const missing = asked.filter((i) => i.required && !answers[i.name]?.trim())
  const start = async () => {
    setStarting(true)
    setError(null)
    const input: Json = {}
    for (const i of asked) {
      const raw = answers[i.name] ?? ''
      if (raw === '') continue
      const v = literal(raw, i.type)
      if (v.kind === 'literal') input[i.name] = v.value
    }
    try {
      const running = builder.run(entry.key, input)
      onClose()
      await running
    } catch (e) {
      setStarting(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet wf-run-sheet" role="dialog" aria-label={t('Run workflow')}>
        <h3>{t('Run “{title}”', { title: entry.title })}</h3>
        <p className="muted small">{t('Runs the live version (version {version}) for real: steps that send, create or change things will do so.', { version: entry.live?.version ?? '' })}</p>
        {asked.length ? asked.map((i) => (
          <section key={i.name}>
            <label className="sheet-label">{i.label || i.name}{i.required ? ' •' : ''}</label>
            {i.type === 'boolean' ? (
              <div className="segmented">
                {['true', 'false'].map((v) => <button key={v} type="button" className={answers[i.name] === v ? 'selected' : ''} onClick={() => setAnswers({ ...answers, [i.name]: v })}>{v === 'true' ? t('Yes') : t('No')}</button>)}
              </div>
            ) : i.type === 'text' || i.type === 'json' || i.type === 'dict' || i.type === 'list' ? (
              <textarea className="wf-input" rows={3} value={answers[i.name] ?? ''} onChange={(e) => setAnswers({ ...answers, [i.name]: e.target.value })} placeholder={i.type === 'text' ? '' : 'JSON'} />
            ) : (
              <input className="wf-input" type={i.type === 'integer' || i.type === 'float' ? 'number' : i.type === 'email' ? 'email' : 'text'} value={answers[i.name] ?? ''}
                onChange={(e) => setAnswers({ ...answers, [i.name]: e.target.value })} />
            )}
            {i.description ? <span className="wf-section-hint">{i.description}</span> : null}
          </section>
        )) : <p className="muted small">{t('It doesn’t ask for anything.')}</p>}
        {error ? <Problem title={t('The run could not be started.')} raw={error} /> : null}
        <div className="sheet-actions">
          <button type="button" onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="primary" disabled={starting || missing.length > 0} onClick={() => void start()}>{starting ? <Spinner /> : <IcPlay size="sm" />} {t('Run')}</button>
        </div>
      </div>
    </div>
  )
}

export function RunStatusBar({ entryKey, run, recipe }: { entryKey: string; run: RunView; recipe: Recipe }) {
  const [open, setOpen] = useState(false)
  const icon = run.status === 'running' ? <Spinner /> : run.status === 'success' ? <IcDone size="sm" /> : <IcAlertCircle size="sm" />
  const text = run.status === 'running' ? t('Running…') : run.status === 'success' ? t('Finished') : t('Failed: {error}', { error: run.error ?? t('see the step marked in red') })
  return (
    <div className={`wf-runbar ${run.status}`}>
      {icon}
      <span className="wf-runbar-text">{text}</span>
      <span className="wf-runbar-id mono">{run.workflowId}</span>
      {run.output ? <button type="button" className="link" onClick={() => setOpen(!open)}>{open ? t('Hide result') : t('Show result')}</button> : null}
      <button type="button" className="icon-button" aria-label={t('Close run')} onClick={() => builder.clearRun(entryKey)}><IcX size="sm" /></button>
      {open && run.output ? <pre className="wf-runbar-output">{JSON.stringify(resultOf(run.output, recipe), null, 2)}</pre> : null}
    </div>
  )
}

/** The run's result: the "Returns" values when it declares them, else its state without internals. */
function resultOf(output: Json, recipe: Recipe): unknown {
  const mapping = compile(recipe, catalog).definition.metadata?.output_mapping as Record<string, { source: string; step?: string; field?: string; value?: unknown }> | undefined
  if (mapping && Object.keys(mapping).length) {
    const read = (from: unknown, path: string | undefined) => (path ? path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Json)[k] : undefined), from) : from)
    return Object.fromEntries(Object.entries(mapping).map(([name, m]) => [name,
      m.source === 'static' ? m.value : m.source === 'input' ? read(output, m.field) : m.source === 'step' ? read(output[m.step ?? ''], m.field) : undefined]))
  }
  const clean: Json = {}
  for (const [k, v] of Object.entries(output)) {
    if (k.startsWith('_') || k === 'organization_uuid') continue
    clean[k] = v
  }
  return clean
}

export function RunsPanel({ entry }: { entry: Entry }) {
  const [rows, setRows] = useState<RunRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<'all' | 'success' | 'failed' | 'running'>('all')
  // Every version runs as its own type; the ten newest cover any realistic history.
  const known = Object.entries(entry.versionOf).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 10)
  const types = [...new Set([entry.live?.workflow_type, entry.head?.workflow_type, ...known].filter((t): t is string => !!t))]
  const typesKey = types.join(',')
  useEffect(() => {
    let alive = true
    setRows(null)
    setError(null)
    api.runs(types, 25, result).then((r) => { if (alive) setRows(r) }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typesKey, result])
  const version = (t: string) => {
    if (t === entry.live?.workflow_type) return entry.live.version
    if (t === entry.head?.workflow_type) return entry.head.version
    return entry.versionOf[t] ?? null
  }
  return (
    <aside className="wf-panel">
      <h3 className="wf-panel-title">{t('Past runs')}</h3>
      <div className="segmented wf-runs-filter" role="radiogroup" aria-label={t('Show runs')}>
        {([['all', msg('All')], ['success', msg('Finished')], ['failed', msg('Failed')], ['running', msg('Running')]] as const).map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={result === k} className={result === k ? 'selected' : ''} onClick={() => setResult(k)}>{t(label)}</button>
        ))}
      </div>
      {error ? <Problem title={t('Couldn’t read the past runs.')} raw={error} /> : !rows ? <Skeleton kind="rows" lines={3} /> : !rows.length ? <p className="wf-section-hint">{result === 'all' ? t('No runs yet.') : t('No runs like that.')}</p> : (
        <ul className="wf-run-list">
          {rows.map((r) => (
            <li key={r.workflow_uuid}>
              <button type="button" className="wf-run-row" onClick={() => void builder.follow(entry.key, r.workflow_uuid, r.workflow_type)}>
                <span className={`dot ${r.terminal_status === 'success' ? 'dot-success' : r.terminal_status === 'failed' ? 'dot-danger' : 'dot-accent'}`} />
                <span className="wf-run-main">
                  <span>{r.terminal_status === 'success' ? t('Finished') : r.terminal_status === 'failed' ? t('Failed') : t('Running')}{version(r.workflow_type) ? ` · v${version(r.workflow_type)}` : ''}</span>
                  <span className="wf-section-hint">{r.created_at_iso ? <Ago iso={r.created_at_iso} /> : null}{r.source === 'editor' ? ` · ${t('started here')}` : r.source === 'schedule' ? ` · ${t('by its schedule')}` : ''}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="wf-section-hint">{t('Pick a run to see how each step went, on the cards.')}</p>
    </aside>
  )
}
