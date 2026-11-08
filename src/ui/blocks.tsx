// The recipe body: step cards and the three wrapping blocks, with an insert
// point between every two blocks.
import { t, plural } from './i18n'
import { useEffect, useState } from 'react'
import {
  IcAlertCircle, IcBranch, IcEnter, IcMore, IcPlus, IcRepeat, IcRepeatOnce, IcSwap, IcUndo, IcUserCheck, IcX,
} from './icons'
import { popupMenu, type MenuSpec } from './runtime'
import { fieldLabel, unknownEntry, type CatalogEntry, type CatalogField } from '../model/catalog'
import { SERVER_CONTROLLED } from '../model/definition'
import { blockTitle } from '../model/graph'
import {
  findBlock, insertBlocks, locate, moveBlock, newStep, removeBlock, slug, stepNames, uid, uniqueName, updateBlock,
  type Block, type ForEachBlock, type IfBlock, type Recipe, type RepeatBlock, type Step, type Value,
} from '../model/recipe'
import { useEditor } from './context'
import { ConditionEditor, RefButton, ValueField } from './fields'
import { Popover } from './Popover'

export function BlockList({ blocks, parent }: { blocks: Block[]; parent: string | null }) {
  const { readOnly } = useEditor()
  return (
    <div className="wf-blocks">
      {blocks.map((block, i) => (
        <div key={block.id} className="wf-block-slot">
          {readOnly ? null : <InsertPoint parent={parent} index={i} />}
          <BlockView block={block} />
        </div>
      ))}
      {readOnly ? null : <AddRow parent={parent} index={blocks.length} empty={!blocks.length} />}
    </div>
  )
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === 'step') return <StepCard step={block} />
  if (block.kind === 'if') return <IfCard block={block} />
  if (block.kind === 'foreach') return <ForEachCard block={block} />
  return <RepeatCard block={block} />
}

// ---- Inserting ----

function useInsert(parent: string | null, index: number) {
  const { update, pickStep } = useEditor()
  const put = (block: Block) => update((r) => ({ ...r, blocks: insertBlocks(r.blocks, parent, index, [block]) }))
  const addStep = (entry: CatalogEntry) => {
    update((r) => {
      const step = newStep(entry.type, entry.title, stepNames(r))
      return { ...r, blocks: insertBlocks(r.blocks, parent, index, [step]) }
    })
  }
  return {
    step: (anchor: HTMLElement | null) => pickStep(anchor, addStep),
    ask: (anchor: HTMLElement | null) => pickStep(anchor, addStep, (e) => !!e.asksPerson),
    onlyIf: () => put({ kind: 'if', id: uid('c'), condition: { kind: 'compare', left: null, op: 'eq', value: '' }, blocks: [] }),
    forEach: () => put({ kind: 'foreach', id: uid('c'), list: null, as: 'item', onError: 'fail', blocks: [] }),
    repeat: () => put({ kind: 'repeat', id: uid('c'), max: 3, blocks: [] }),
  }
}

function InsertMenu({ anchor, parent, index, onClose }: { anchor: HTMLElement; parent: string | null; index: number; onClose: () => void }) {
  const insert = useInsert(parent, index)
  const item = (label: string, hint: string, icon: React.ReactNode, run: () => void) => (
    <button type="button" className="wf-menu-item" onClick={() => { onClose(); run() }}>
      <span className="wf-menu-icon">{icon}</span>
      <span className="wf-menu-text"><span>{label}</span><span className="wf-menu-hint">{hint}</span></span>
    </button>
  )
  return (
    <Popover anchor={anchor} onClose={onClose} width={280} className="wf-insert-menu">
      {item(t('Step…'), t('Do something: look up, send, create'), <IcPlus size="md" />, () => insert.step(anchor))}
      {item(t('Ask a person…'), t('Wait for someone to approve or decide'), <IcUserCheck size="md" />, () => insert.ask(anchor))}
      <div className="wf-menu-sep" />
      {item(t('Only if…'), t('Run steps only when something is true'), <IcBranch size="md" />, insert.onlyIf)}
      {item(t('For each…'), t('Run steps once per item of a list'), <IcRepeatOnce size="md" />, insert.forEach)}
      {item(t('Repeat…'), t('Run steps again, up to a number of times'), <IcRepeat size="md" />, insert.repeat)}
    </Popover>
  )
}

function InsertPoint({ parent, index }: { parent: string | null; index: number }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <div className={`wf-insert${anchor ? ' open' : ''}`}>
      <button type="button" className="wf-insert-button" aria-label={t('Insert here')} title={t('Insert here')} onClick={(e) => setAnchor(e.currentTarget)}>
        <IcPlus size="xs" />
      </button>
      {anchor ? <InsertMenu anchor={anchor} parent={parent} index={index} onClose={() => setAnchor(null)} /> : null}
    </div>
  )
}

function AddRow({ parent, index, empty }: { parent: string | null; index: number; empty: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const insert = useInsert(parent, index)
  return (
    <div className={`wf-add-row${empty ? ' empty' : ''}`}>
      <button type="button" className="wf-add-step" onClick={(e) => insert.step(e.currentTarget)}>
        <IcPlus size="sm" /> {empty && parent ? t('Add a step here') : empty ? t('Add the first step') : t('Add a step')}
      </button>
      <button type="button" className="wf-add-more" onClick={(e) => setAnchor(e.currentTarget)}>{t('More…')}</button>
      {anchor ? <InsertMenu anchor={anchor} parent={parent} index={index} onClose={() => setAnchor(null)} /> : null}
    </div>
  )
}

// ---- Shared block actions ----

function blockMenu(update: (c: (r: Recipe) => Recipe) => void, block: Block, extra: MenuSpec[] = []): Promise<void> {
  return popupMenu([
    { label: t('Move Up'), action: () => update((r) => ({ ...r, blocks: moveBlock(r.blocks, block.id, -1) })) },
    { label: t('Move Down'), action: () => update((r) => ({ ...r, blocks: moveBlock(r.blocks, block.id, 1) })) },
    ...extra,
    'separator',
    { label: block.kind === 'step' ? t('Delete Step') : t('Delete With Its Steps'), action: () => update((r) => ({ ...r, blocks: removeBlock(r.blocks, block.id) })) },
  ])
}

/** Step menu entries to move a step into the block just above it, or out of its block. */
function nesting(r: Recipe, step: Step, update: (change: (r: Recipe) => Recipe) => void): MenuSpec[] {
  const at = locate(r.blocks, step.id)
  if (!at) return []
  const siblings = at.parent === null ? r.blocks : ((findContainer(r.blocks, at.parent)?.blocks) ?? [])
  const above = siblings[at.index - 1]
  const out: MenuSpec[] = []
  if (above && above.kind !== 'step') {
    out.push({ label: t('Move Into “{block}” Above', { block: blockName(above) }), action: () => update((x) => ({ ...x, blocks: insertBlocks(removeBlock(x.blocks, step.id), above.id, above.blocks.length, [step]) })) })
  }
  if (at.parent !== null) {
    const parentAt = locate(r.blocks, at.parent)
    if (parentAt) out.push({ label: t('Move Out of This Block'), action: () => update((x) => ({ ...x, blocks: insertBlocks(removeBlock(x.blocks, step.id), parentAt.parent, parentAt.index + 1, [step]) })) })
  }
  return out
}

function findContainer(blocks: Block[], id: string): Exclude<Block, Step> | null {
  for (const b of blocks) {
    if (b.kind === 'step') continue
    if (b.id === id) return b
    const inner = findContainer(b.blocks, id)
    if (inner) return inner
  }
  return null
}

function blockName(block: Exclude<Block, Step>): string {
  return block.kind === 'if' ? t('Only if') : block.kind === 'foreach' ? t('For each {item}', { item: block.as }) : t('Repeat')
}

function unwrap(r: Recipe, block: Block): Recipe {
  if (block.kind === 'step') return r
  const at = locate(r.blocks, block.id)
  if (!at) return r
  return { ...r, blocks: insertBlocks(removeBlock(r.blocks, block.id), at.parent, at.index, block.blocks) }
}

function wrap(r: Recipe, step: Step, kind: 'if' | 'foreach'): Recipe {
  const container: Block = kind === 'if'
    ? { kind: 'if', id: uid('c'), condition: { kind: 'compare', left: null, op: 'eq', value: '' }, blocks: [step] }
    : { kind: 'foreach', id: uid('c'), list: null, as: 'item', onError: 'fail', blocks: [step] }
  return { ...r, blocks: updateBlock(r.blocks, step.id, () => container) }
}

export function ProblemsFor({ at, field }: { at: string; field?: string }) {
  const { problems, applyFix, readOnly } = useEditor()
  const mine = problems.filter((p) => p.at === at && p.field === field && p.severity !== 'note')
  if (!mine.length) return null
  return (
    <ul className="wf-problems">
      {mine.map((p, i) => (
        <li key={i} className={`wf-problem ${p.severity}`}>
          <IcAlertCircle size="xs" /> <span>{p.message}{p.source === 'platform' ? <span className="wf-problem-src"> {t('· platform')}</span> : null}</span>
          {p.fix && !readOnly ? <button type="button" className="link wf-fix" onClick={() => applyFix(p.fix!)}>{t('Use {what}', { what: p.fix.label })}</button> : null}
        </li>
      ))}
    </ul>
  )
}

// ---- Steps ----

const isAsked = (f: CatalogField) => !f.automatic && !SERVER_CONTROLLED.has(f.name)

export function StepCard({ step }: { step: Step }) {
  const { recipe, catalog, update, readOnly, numbers, runSteps, runFailures, runOutput, problems } = useEditor()
  const [more, setMore] = useState(false)
  const entry = catalog.get(step.workflowType)
  const spec = entry ?? unknownEntry(step.workflowType)
  const declared = spec.inputs.filter(isAsked)
  const extra: CatalogField[] = Object.keys(step.fields)
    .filter((name) => !spec.inputs.some((f) => f.name === name) && !SERVER_CONTROLLED.has(name))
    .map((name) => ({ name, type: 'json' }))
  const filled = (f: CatalogField) => { const v = step.fields[f.name]; return !!v && v.kind !== 'empty' }
  const primary = [...declared.filter((f) => f.required || filled(f)), ...extra]
  const optional = declared.filter((f) => !f.required && !filled(f))
  const setField = (name: string, value: Value) => update((r) => ({
    ...r,
    blocks: updateBlock(r.blocks, step.id, (b) => (b.kind === 'step' ? { ...b, fields: { ...b.fields, [name]: value } } : b)),
  }))
  const setStep = (change: (s: Step) => Step) => update((r) => ({ ...r, blocks: updateBlock(r.blocks, step.id, (b) => (b.kind === 'step' ? change(b) : b)) }))
  const rename = (title: string) => setStep((s) => {
    if (!s.autoName) return { ...s, title }
    const taken = stepNames(recipe)
    taken.delete(s.name)
    return { ...s, title, name: uniqueName(slug(title), taken) }
  })
  const addUndo = () => {
    const pick = (e: CatalogEntry) => setStep((s) => ({
      ...s,
      undo: [...s.undo, { id: uid('u'), name: uniqueName(slug(e.title), stepNames(recipe)), title: e.title, workflowType: e.type, fields: {} }],
    }))
    pickFor(pick)
  }
  const { pickStep } = useEditor()
  const pickFor = (cb: (e: CatalogEntry) => void) => pickStep(null, cb, (e) => !e.readOnly)
  const menu = () => blockMenu(update, step, [
    ...nesting(recipe, step, update),
    { label: t('Duplicate'), action: () => update((r) => {
      const at = locate(r.blocks, step.id)
      if (!at) return r
      const copy: Step = { ...structuredClone(step), id: uid('s'), name: uniqueName(step.name, stepNames(r)), title: t('{title} (copy)', { title: step.title }), undo: [] }
      return { ...r, blocks: insertBlocks(r.blocks, at.parent, at.index + 1, [copy]) }
    }) },
    'separator',
    { label: t('Only If…'), action: () => update((r) => wrap(r, step, 'if')) },
    { label: t('For Each Item of a List…'), action: () => update((r) => wrap(r, step, 'foreach')) },
    'separator',
    { label: t('Run at the Same Time as the Step Before'), checked: step.alongside, enabled: !spec.readOnly, action: () => setStep((s) => ({ ...s, alongside: !s.alongside })) },
    { label: t('Stop Everything if This Fails'), checked: step.stopOnFail, action: () => setStep((s) => ({ ...s, stopOnFail: !s.stopOnFail })) },
    { label: t('Add an Undo Step…'), action: addUndo },
  ])
  const general = problems.filter((p) => p.at === step.id && !p.field)
  const errors = problems.filter((p) => p.at === step.id && p.severity === 'error').length

  return (
    <article className={`wf-card wf-step${runSteps[step.id] ? ` run-${runSteps[step.id]}` : ''}${errors ? ' has-errors' : ''}`} data-step={step.name} data-id={step.id}
      onContextMenu={(e) => { if (readOnly) return; e.preventDefault(); void menu() }}>
      <header className="wf-card-head">
        <span className="wf-num" title={t('Step {n}', { n: numbers.get(step.id) ?? '' })}>{numbers.get(step.id)}</span>
        <div className="wf-card-titles">
          <input className="wf-title-input" value={step.title} disabled={readOnly} aria-label={t('Step name')} onChange={(e) => rename(e.target.value)} />
          <div className="wf-card-meta">
            <span className="wf-app">{spec.app}</span>
            {entry ? null : <span className="tag mono" title={step.workflowType}>{shortType(step.workflowType)}</span>}
            {spec.readOnly ? <span className="tag">{t('reads only')}</span> : null}
            {spec.asksPerson ? <span className="tag tag-accent">{t('waits for a person')}</span> : null}
            {step.alongside ? <span className="tag" title={t('Runs at the same time as the step before')}><IcSwap size="xs" /> {t('with the step before')}</span> : null}
            {step.stopOnFail ? <span className="tag tag-warning">{t('stops everything if it fails')}</span> : null}
            {(step.after ?? []).map((id) => {
              const other = findBlock(recipe.blocks, id)?.block
              const label = !other ? t('a removed step') : other.kind === 'step' ? `${numbers.get(other.id) ?? ''} · ${other.title}` : blockTitle(other)
              return (
                <span key={id} className="tag wf-after-tag" title={t('Waits for this step even though it uses none of its data (drawn on the diagram)')}>
                  after {label}
                  {readOnly ? null : <button type="button" className="wf-chip-x" aria-label={t('Stop waiting for {step}', { step: label })} onClick={() => setStep((s) => { const after = (s.after ?? []).filter((x) => x !== id); const out = { ...s, after }; if (!after.length) delete (out as Partial<Step>).after; return out })}><IcX size="xs" /></button>}
                </span>
              )
            })}
          </div>
        </div>
        {readOnly ? null : <button type="button" className="icon-button" aria-label={t('Step actions')} onClick={() => void menu()}><IcMore size="md" /></button>}
      </header>
      {spec.description ? <p className="wf-card-desc">{spec.description}</p> : null}
      {runFailures[step.id] ? <p className="wf-run-failure"><IcAlertCircle size="xs" /> {runFailures[step.id]}</p> : null}
      {runOutput && runOutput[step.name] !== undefined ? (
        <details className="wf-run-output">
          <summary>{t('What it returned')}</summary>
          <pre>{JSON.stringify(runOutput[step.name], null, 2)}</pre>
        </details>
      ) : null}
      <div className="wf-fields">
        {primary.map((f) => (
          <FieldRow key={f.name} at={step.id} field={f} value={step.fields[f.name]} onChange={(v) => setField(f.name, v)} step={step} />
        ))}
        {more ? optional.map((f) => (
          <FieldRow key={f.name} at={step.id} field={f} value={step.fields[f.name]} onChange={(v) => setField(f.name, v)} step={step} />
        )) : null}
        {optional.length && !readOnly ? (
          <button type="button" className="link wf-more" onClick={() => setMore(!more)}>
            {more ? t('Fewer options') : plural(optional.length, '{n} more option', '{n} more options')}
          </button>
        ) : null}
        {!primary.length && !optional.length ? <p className="wf-card-desc">{t('Nothing to fill in.')}</p> : null}
      </div>
      {step.undo.map((u) => {
        const ue = catalog.get(u.workflowType) ?? unknownEntry(u.workflowType)
        const ufields = [...ue.inputs.filter(isAsked).filter((f) => f.required || u.fields[f.name]), ...Object.keys(u.fields).filter((n) => !ue.inputs.some((f) => f.name === n)).map((name): CatalogField => ({ name, type: 'json' }))]
        return (
          <div key={u.id} className="wf-undo">
            <div className="wf-undo-head">
              <IcUndo size="sm" /> <span>{t('If a later step fails, undo with')} <strong>{u.title}</strong></span>
              {readOnly ? null : (
                <button type="button" className="icon-button" aria-label={t('Remove undo step')} onClick={() => setStep((s) => ({ ...s, undo: s.undo.filter((x) => x.id !== u.id) }))}><IcX size="sm" /></button>
              )}
            </div>
            {ufields.map((f) => (
              <FieldRow key={f.name} at={step.id} field={f} value={u.fields[f.name]}
                onChange={(v) => setStep((s) => ({ ...s, undo: s.undo.map((x) => (x.id === u.id ? { ...x, fields: { ...x.fields, [f.name]: v } } : x)) }))} />
            ))}
          </div>
        )
      })}
      {general.length ? <ProblemsFor at={step.id} /> : null}
    </article>
  )
}

function FieldRow({ at, field, value, onChange, step }: { at: string; field: CatalogField; value: Value | undefined; onChange: (v: Value) => void; step?: Step }) {
  const picker = step && field.source?.kind === 'workflow' && (!value || value.kind === 'empty' || value.kind === 'literal')
  return (
    <div className="wf-field">
      <label className="wf-field-label" title={field.description ?? field.name}>
        {fieldLabel(field.name)}{field.required ? <span className="wf-req" aria-label={t('required')}>•</span> : null}
      </label>
      <div className="wf-field-body">
        {picker ? <PlatformChoices step={step!} field={field} value={value} onChange={onChange} /> : null}
        <ValueField atId={at} field={field} value={value} onChange={onChange} />
        <ProblemsFor at={at} field={field.name} />
      </div>
    </div>
  )
}

/** Choices the platform can look up for a field (connections, channels…). */
function PlatformChoices({ step, field, value, onChange }: { step: Step; field: CatalogField; value: Value | undefined; onChange: (v: Value) => void }) {
  const { fieldOptions, readOnly } = useEditor()
  const [options, setOptions] = useState<Array<{ value: unknown; label: string }> | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'none'>('idle')
  const literals = Object.fromEntries(Object.entries(step.fields).flatMap(([k, v]) => (v.kind === 'literal' && v.value !== '' && k !== field.name ? [[k, v.value]] : [])))
  const depsKey = JSON.stringify(literals)
  const load = () => {
    setState('loading')
    void fieldOptions(step.workflowType, literals).then((decisions) => {
      const d = decisions.find((x) => x.field === field.name)
      const opts = d?.options ?? []
      setOptions(opts)
      setState(opts.length ? 'idle' : 'none')
    }).catch(() => setState('none'))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setOptions(null); setState('idle') }, [depsKey])
  const current = value?.kind === 'literal' ? String(value.value ?? '') : ''
  if (readOnly) return null
  if (!options) {
    return <button type="button" className="link wf-choose" onClick={load} disabled={state === 'loading'}>{state === 'loading' ? t('Looking up choices…') : t('Choose from your {things}…', { things: fieldLabel(field.name).toLowerCase() })}</button>
  }
  if (state === 'none') return <span className="wf-section-hint">{t('No choices found — type a value or use data.')}</span>
  return (
    <select className="wf-select wf-choices" value={options.some((o) => String(o.value) === current) ? current : ''}
      onChange={(e) => { const o = options.find((x) => String(x.value) === e.target.value); onChange(o ? { kind: 'literal', value: o.value } : { kind: 'empty' }) }}>
      <option value="">{t('Choose…')}</option>
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  )
}

function shortType(type: string): string {
  return type.startsWith('virtual.') ? t('another workflow') : type
}

// ---- Wrapping blocks ----

function ContainerHead({ block, icon, children, extra = [] }: { block: Block; icon: React.ReactNode; children: React.ReactNode; extra?: MenuSpec[] }) {
  const { update, readOnly } = useEditor()
  return (
    <header className="wf-container-head" onContextMenu={(e) => { if (readOnly) return; e.preventDefault(); void blockMenu(update, block, extra) }}>
      <span className="wf-container-icon">{icon}</span>
      <div className="wf-container-sentence">{children}</div>
      {readOnly ? null : (
        <button type="button" className="icon-button" aria-label={t('Block actions')} onClick={() => void blockMenu(update, block, [
          { label: t('Remove Block, Keep Its Steps'), action: () => update((r) => unwrap(r, block)) }, ...extra,
        ])}><IcMore size="md" /></button>
      )}
    </header>
  )
}

function IfCard({ block }: { block: IfBlock }) {
  const { update } = useEditor()
  return (
    <section className="wf-container wf-if" data-block="if" data-id={block.id}>
      <ContainerHead block={block} icon={<IcBranch size="sm" />}>
        <span className="wf-keyword">{t('Only if')}</span>
        <ConditionEditor atId={block.id} condition={block.condition}
          onChange={(condition) => update((r) => ({ ...r, blocks: updateBlock(r.blocks, block.id, (b) => (b.kind === 'if' ? { ...b, condition } : b)) }))} />
      </ContainerHead>
      <ProblemsFor at={block.id} />
      <BlockList blocks={block.blocks} parent={block.id} />
    </section>
  )
}

function ForEachCard({ block }: { block: ForEachBlock }) {
  const { update, readOnly, runSteps } = useEditor()
  const set = (patch: Partial<ForEachBlock>) => update((r) => ({ ...r, blocks: updateBlock(r.blocks, block.id, (b) => (b.kind === 'foreach' ? { ...b, ...patch } : b)) }))
  return (
    <section className={`wf-container wf-each${runSteps[block.id] ? ` run-${runSteps[block.id]}` : ''}`} data-block="foreach" data-id={block.id}>
      <ContainerHead block={block} icon={<IcRepeatOnce size="sm" />}>
        <span className="wf-keyword">{t('For each')}</span>
        <input className="wf-input wf-as" value={block.as} disabled={readOnly} aria-label={t('Name for one item')} onChange={(e) => set({ as: e.target.value })} />
        <span className="wf-keyword-soft">{t('in')}</span>
        <RefButton atId={block.id} refValue={block.list} want="list" placeholder={t('Choose a list…')} onChange={(list) => set({ list })} />
        <select className="wf-select" disabled={readOnly} value={block.onError} onChange={(e) => set({ onError: e.target.value as ForEachBlock['onError'] })}>
          <option value="fail">{t('stop if one fails')}</option>
          <option value="continue">{t('skip ones that fail')}</option>
        </select>
      </ContainerHead>
      <ProblemsFor at={block.id} />
      <BlockList blocks={block.blocks} parent={block.id} />
    </section>
  )
}

function RepeatCard({ block }: { block: RepeatBlock }) {
  const { update, readOnly } = useEditor()
  const set = (patch: Partial<RepeatBlock>) => update((r) => ({ ...r, blocks: updateBlock(r.blocks, block.id, (b) => (b.kind === 'repeat' ? { ...b, ...patch } : b)) }))
  return (
    <section className="wf-container wf-repeat" data-block="repeat" data-id={block.id}>
      <ContainerHead block={block} icon={<IcRepeat size="sm" />}>
        <span className="wf-keyword">{t('Repeat up to')}</span>
        <input className="wf-input wf-count" type="number" min={1} max={100} value={block.max} disabled={readOnly} aria-label={t('Times')}
          onChange={(e) => set({ max: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
        <span className="wf-keyword-soft">{t('times')}</span>
        {block.until ? (
          <>
            <span className="wf-keyword-soft">{t(', stop early when')}</span>
            <ConditionEditor atId={block.id} condition={block.until} onChange={(until) => set({ until })} />
            {readOnly ? null : <button type="button" className="icon-button" aria-label={t('Never stop early')} onClick={() => set({ until: undefined })}><IcX size="sm" /></button>}
          </>
        ) : readOnly ? null : (
          <button type="button" className="link" onClick={() => set({ until: { kind: 'compare', left: null, op: 'truthy' } })}>
            <IcEnter size="xs" /> stop early when…
          </button>
        )}
      </ContainerHead>
      <ProblemsFor at={block.id} />
      <BlockList blocks={block.blocks} parent={block.id} />
    </section>
  )
}
