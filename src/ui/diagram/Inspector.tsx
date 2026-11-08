// The side panel for what's selected on the diagram: a step's inputs with the
// very same editors as the step list (its StepCard), what it gives, what it
// waits for, the catalog's docs and, for a step that runs another workflow,
// a way into that workflow. Blocks, "Starts with" and "Returns" edit here too.
import { t, plural } from '../i18n'
import { IcEnter, IcMessageText, IcSwap, IcTrash, IcX, IcListOrdered, IcCopy } from '../icons'
import { fieldLabel, unknownEntry, type FieldType } from '../../model/catalog'
import { describeRef } from '../../model/data'
import { blockTitle, INPUTS, RETURNS } from '../../model/graph'
import { findBlock, updateBlock, type Block, type ForEachBlock, type RepeatBlock, type Step } from '../../model/recipe'
import { ProblemsFor, StepCard } from '../blocks'
import { useEditor } from '../context'
import { ConditionEditor, RefButton, typeWord } from '../fields'
import { Returns, StartsWith } from '../RecipeEditor'
import { StepIcon } from './nodes'
import { runsWorkflow, type Nested } from './nested'

export interface InspectorActions {
  close: () => void
  remove: (ids: string[]) => void
  duplicate: (id: string) => void
  parallelize: (ids: string[]) => void
  sequence: (ids: string[]) => void
  /** Null when the host has no assistant. */
  discuss: ((ids: string[]) => void) | null
  unwait: (step: string, from: string) => void
  openNested: (id: string) => void
  drill: (id: string) => void
  select: (id: string) => void
  /** Steps this one waits for (all reasons), for "Runs after". */
  waitsFor: (id: string) => Array<{ id: string; why: string }>
  nested: (step: Step) => Nested | null
}

export function Inspector({ ids, actions }: { ids: string[]; actions: InspectorActions }) {
  const { recipe, catalog, readOnly, numbers } = useEditor()
  if (ids.length > 1) {
    const blocks = ids.map((id) => findBlock(recipe.blocks, id)?.block).filter((b): b is Block => !!b)
    const steps = blocks.filter((b): b is Step => b.kind === 'step')
    return (
      <aside className="dg-inspector" aria-label={t('Selection')}>
        <Head title={t('{n} selected', { n: blocks.length })} onClose={actions.close} />
        <ul className="dg-sel-list">
          {blocks.map((b) => <li key={b.id}><button type="button" className="link" onClick={() => actions.select(b.id)}>{blockTitle(b)}</button></li>)}
        </ul>
        {readOnly ? null : (
          <div className="dg-actions">
            <button type="button" disabled={steps.length < 2} title={t('Run these steps at the same time')} onClick={() => actions.parallelize(steps.map((s) => s.id))}><IcSwap size="sm" /> {t('Run Together')}</button>
            <button type="button" disabled={blocks.length < 2} title={t('Run these one after another, in reading order')} onClick={() => actions.sequence(blocks.map((b) => b.id))}><IcListOrdered size="sm" /> {t('One After Another')}</button>
            <button type="button" className="danger" onClick={() => actions.remove(blocks.map((b) => b.id))}><IcTrash size="sm" /> {t('Delete')}</button>
          </div>
        )}
        {actions.discuss ? <button type="button" onClick={() => actions.discuss!(ids)}><IcMessageText size="sm" /> {t('Discuss These')}</button> : null}
      </aside>
    )
  }
  const id = ids[0]
  if (id === INPUTS || id === RETURNS) {
    return (
      <aside className="dg-inspector" aria-label={id === INPUTS ? t('Starts with') : t('Returns')}>
        <Head title={id === INPUTS ? t('Starts with') : t('Returns')} onClose={actions.close} />
        <div className="dg-inspector-body">{id === INPUTS ? <StartsWith /> : <Returns />}</div>
      </aside>
    )
  }
  const found = findBlock(recipe.blocks, id)
  if (!found) return null
  const block = found.block
  if (block.kind !== 'step') return <BlockInspector block={block} actions={actions} />
  const step = block
  const entry = catalog.get(step.workflowType) ?? unknownEntry(step.workflowType)
  const waits = actions.waitsFor(step.id)
  const nested = runsWorkflow(step.workflowType) ? actions.nested(step) : null
  return (
    <aside className="dg-inspector" aria-label={t('Step {title}', { title: step.title })}>
      <Head title={numbers.get(step.id) ? t('Step {n}', { n: numbers.get(step.id) ?? '' }) : t('Step')} icon={<StepIcon type={step.workflowType} entry={entry} />} sub={entry.readOnly ? t('Only reads data') : undefined} onClose={actions.close} />
      <div className="dg-inspector-body">
        <div className="dg-inspector-card"><StepCard step={step} /></div>

        {nested ? (
          <section className="dg-sec">
            <h4>{t('Runs another workflow')}</h4>
            <p className="dg-hint">{nested.title ? `“${nested.title}”` : t('A saved workflow')}{nested.status === 'loading' ? t(' — reading it…') : nested.status === 'error' ? t(' — couldn’t read it ({error})', { error: nested.error ?? '' }) : ''}</p>
            <div className="dg-actions">
              <button type="button" onClick={() => actions.openNested(step.id)} disabled={nested.status === 'error'} title={nested.entryKey ? t('Open it here; the breadcrumbs bring you back') : t('Show its steps inside this box (read-only: it isn’t one you can edit)')}>
                <IcEnter size="sm" /> {nested.entryKey ? t('Open Definition') : t('Show Its Steps')}
              </button>
            </div>
          </section>
        ) : null}

        {waits.length ? (
        <section className="dg-sec">
          <h4>{t('Runs after')}</h4>
          {(
            <ul className="dg-waits">
              {waits.map((w) => {
                const other = findBlock(recipe.blocks, w.id)?.block
                return (
                  <li key={w.id}>
                    <button type="button" className="link" onClick={() => actions.select(w.id)}>{other ? blockTitle(other) : t('a removed step')}</button>
                    <span className="dg-hint">{w.why}</span>
                    {w.why === t('drawn by hand') && !readOnly ? <button type="button" className="icon-button" aria-label={t('Stop waiting for it')} title={t('Stop waiting for it')} onClick={() => actions.unwait(step.id, w.id)}><IcX size="xs" /></button> : null}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        ) : null}

        <section className="dg-sec">
          <h4 title={t('With Data wires on, drag from one of these to another step’s input')}>{t('Gives')}</h4>
          {entry.outputs.length ? (
            <ul className="dg-outputs">
              {entry.outputs.map((o) => <li key={o.name} title={o.description}><span>{fieldLabel(o.name)}</span><span className="dg-hint">{typeWord(o.type as FieldType)}</span></li>)}
            </ul>
          ) : <p className="dg-hint">{t('The catalog doesn’t list its results. Later steps can still use its whole result.')}</p>}
        </section>

        <details className="dg-sec dg-about">
          <summary>{t('Technical details')}</summary>
          <dl className="dg-facts">
            <dt>{t('Workflow')}</dt><dd className="mono">{step.workflowType}</dd>
            <dt>{t('Saved as')}</dt><dd className="mono">{step.name}</dd>
          </dl>
        </details>

        <div className="dg-actions">
          {actions.discuss ? <button type="button" onClick={() => actions.discuss!([step.id])}><IcMessageText size="sm" /> {t('Discuss')}</button> : null}
          {readOnly ? null : <button type="button" onClick={() => actions.duplicate(step.id)}><IcCopy size="sm" /> {t('Duplicate')}</button>}
          {readOnly ? null : <button type="button" className="danger" onClick={() => actions.remove([step.id])}><IcTrash size="sm" /> {t('Delete')}</button>}
        </div>
      </div>
    </aside>
  )
}

function Head({ title, sub, icon, onClose }: { title: string; sub?: string; icon?: React.ReactNode; onClose: () => void }) {
  return (
    <header className="dg-inspector-head">
      {icon ? <span className="dg-icon">{icon}</span> : null}
      <div className="dg-inspector-titles">
        <h3>{title || t('Untitled step')}</h3>
        {sub ? <span className="dg-hint">{sub}</span> : null}
      </div>
      <button type="button" className="icon-button" aria-label={t('Close inspector')} title={t('Close (Esc)')} onClick={onClose}><IcX size="sm" /></button>
    </header>
  )
}

function BlockInspector({ block, actions }: { block: Exclude<Block, Step>; actions: InspectorActions }) {
  const { update, readOnly, recipe, catalog } = useEditor()
  const set = (change: (b: Block) => Block) => update((r) => ({ ...r, blocks: updateBlock(r.blocks, block.id, change) }))
  return (
    <aside className="dg-inspector" aria-label={blockTitle(block)}>
      <Head title={blockTitle(block)} sub={block.kind === 'if' ? t('Runs its steps only when this is true') : block.kind === 'foreach' ? t('Runs its steps once per item of a list') : t('Runs its steps again, up to a number of times')} onClose={actions.close} />
      <div className="dg-inspector-body">
        {block.kind === 'if' ? (
          <section className="dg-sec">
            <h4>{t('Only if')}</h4>
            <ConditionEditor atId={block.id} condition={block.condition} onChange={(condition) => set((b) => (b.kind === 'if' ? { ...b, condition } : b))} />
          </section>
        ) : block.kind === 'foreach' ? (
          <section className="dg-sec">
            <h4>{t('For each')}</h4>
            <label className="dg-row">{t('Call one item')} <input className="wf-input" value={block.as} disabled={readOnly} onChange={(e) => set((b) => (b.kind === 'foreach' ? { ...b, as: e.target.value } : b))} /></label>
            <label className="dg-row">{t('in')} <RefButton atId={block.id} refValue={block.list} want="list" placeholder={t('Choose a list…')} onChange={(list) => set((b) => (b.kind === 'foreach' ? { ...b, list } : b))} /></label>
            {block.list ? <p className="dg-hint">{t('Goes through {list}.', { list: describeRef(recipe, catalog, block.list).label })}</p> : null}
            <select className="wf-select" disabled={readOnly} value={block.onError} onChange={(e) => set((b) => (b.kind === 'foreach' ? { ...b, onError: e.target.value as ForEachBlock['onError'] } : b))}>
              <option value="fail">{t('Stop if one fails')}</option>
              <option value="continue">{t('Skip ones that fail')}</option>
            </select>
          </section>
        ) : (
          <section className="dg-sec">
            <h4>{t('Repeat')}</h4>
            <label className="dg-row">{t('Up to')} <input className="wf-input wf-count" type="number" min={1} max={100} disabled={readOnly} value={block.max}
              onChange={(e) => set((b) => (b.kind === 'repeat' ? { ...b, max: Math.max(1, Math.min(100, Number(e.target.value) || 1)) } : b))} /> {t('times')}</label>
            {(block as RepeatBlock).until ? (
              <ConditionEditor atId={block.id} condition={(block as RepeatBlock).until!} onChange={(until) => set((b) => (b.kind === 'repeat' ? { ...b, until } : b))} />
            ) : readOnly ? null : <button type="button" className="link" onClick={() => set((b) => (b.kind === 'repeat' ? { ...b, until: { kind: 'compare', left: null, op: 'truthy' } } : b))}>{t('Stop early when…')}</button>}
          </section>
        )}
        <ProblemsFor at={block.id} />
        <p className="dg-hint">{plural(block.blocks.length, '{n} block inside. Drag steps in or out of its box on the canvas.', '{n} blocks inside. Drag steps in or out of its box on the canvas.')}</p>
        <div className="dg-actions">
          <button type="button" onClick={() => actions.drill(block.id)}><IcEnter size="sm" /> {t('Go Inside')}</button>
          {actions.discuss ? <button type="button" onClick={() => actions.discuss!([block.id])}><IcMessageText size="sm" /> {t('Discuss')}</button> : null}
          {readOnly ? null : <button type="button" onClick={() => actions.duplicate(block.id)}><IcCopy size="sm" /> {t('Duplicate')}</button>}
          {readOnly ? null : <button type="button" className="danger" onClick={() => actions.remove([block.id])}><IcTrash size="sm" /> {t('Delete With Its Steps')}</button>}
        </div>
      </div>
    </aside>
  )
}
