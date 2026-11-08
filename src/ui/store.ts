// The editor's state, backed by a CompositionBackend: the compositions the
// caller may see, the one open in the editor, its checks, saves, runs and
// schedules. Unsaved edits live in the host's storage until they are saved.
//
// One store per page: createComposerStore() binds the backend, the host and
// the catalog, and the components read the bound store.
import { isBlankDraft } from '../model/drafts'
import { useSyncExternalStore } from 'react'
import { bindHost, notify, showNotification, store as kv } from './runtime'
import { t } from './i18n'
import { compile, type CompileOptions, type RecipeMeta } from '../model/compile'
import { canonicalJson, type CompositionDefinition } from '../model/definition'
import { decompile } from '../model/decompile'
import { savedInputs } from '../model/infer'
import { emptyRecipe, lineageSlug, slug, uid, uniqueLineageSlug, uniqueName, type Recipe } from '../model/recipe'
import { History } from '../model/history'
import type { ComposerHost, CompositionBackend, CompositionRow, Dependents, FieldDecision, InspectorStep, Json, ListFacts, LiveCatalog, PublishReceipt, RunInspector, RunRow, RunState, SaveOptions, SaveResult, Schedule, SchedulePatch, ValidateResult } from './host'
import { cadenceProblem, runsCadence, type Cadence } from '../model/schedule'
import { ComposerError, isComposerError } from '../backends/errors'
import { newIdempotencyKey, publishWithRecovery } from '../backends/publish'
import { publishFingerprint, receiptAsSave } from '../backends/wire'
import { liveCatalog } from './host'
import { staticCatalog } from '../model/catalog'
import { emptyFilter, readFilter, type FilterSubject, type WorkflowFilter } from '../model/filters'
import { serverProblems, type ServerProblem } from './findings'
import { cadenceProblemText } from './cadence'

// ---- The bound backend and catalog ----

let backend: CompositionBackend | null = null
let boundCatalog: LiveCatalog = liveCatalog(staticCatalog([]))

function b(): CompositionBackend {
  if (!backend) throw new Error('No composition backend: render <CompositionEditor> with a backend')
  return backend
}
const unsupported = (what: string) => Promise.reject(new Error(t('This backend can’t {what}', { what })))

/** The bound catalog: every read goes to whatever catalog the mounted editor was given. */
export const catalog: LiveCatalog = {
  get version() { return boundCatalog.version },
  subscribe: (listener) => boundCatalog.subscribe(listener),
  ensure: (types) => boundCatalog.ensure(types),
  loadList: () => boundCatalog.loadList(),
  apps: () => boundCatalog.apps(),
  get: (type) => boundCatalog.get(type),
  search: (query, options) => boundCatalog.search(query, options),
  isMissing: (type) => boundCatalog.isMissing?.(type) ?? false,
}

/**
 * Compile for the bound backend. An app backend publishes by slug, so For each children get
 * names it accepts; a member backend keeps the names its saved children already have.
 */
export function compileFor(recipe: Recipe, options: Omit<CompileOptions, 'childNames'> = {}) {
  return compile(recipe, catalog, { ...options, childNames: backend?.kind === 'app' ? 'slug' : 'engine' })
}

/** The bound backend, in the shape the editor calls it. Missing optional features answer "not available". */
export const api = {
  lineages: () => b().lineages(),
  facts: (): Promise<ListFacts> => b().facts?.() ?? Promise.resolve({ schedules: new Map(), lastRuns: new Map() }),
  listSupports: async (field: string): Promise<boolean> => (field === 'uses_workflow_type' ? (await b().canFilterByStep?.()) ?? false : false),
  namesUsing: (type: string): Promise<Set<string>> => b().namesUsing?.(type) ?? unsupported(t('search by step')),
  get: (uuid: string): Promise<CompositionRow> => b().get(uuid),
  byName: (name: string): Promise<CompositionRow | null> => b().byName(name),
  byType: (type: string): Promise<CompositionRow | null> => b().byType?.(type) ?? Promise.resolve(null),
  headVersion: (name: string): Promise<number | null> => b().headVersion(name),
  validate: (definition: CompositionDefinition, dryRun = false): Promise<ValidateResult> => b().validate(definition, dryRun),
  save: (name: string, definition: CompositionDefinition, description?: string, options?: SaveOptions): Promise<SaveResult> => b().save(name, definition, description, options),
  /** Whether Save publishes (a backend with drafts and publishing as separate steps). */
  get publishes() { return !!b().publish },
  dependents: (name: string): Promise<Dependents> => b().dependents?.(name) ?? unsupported(t('list who uses a composition')),
  start: (type: string, inputs: Json): Promise<RunState> => b().start(type, inputs),
  state: (id: string): Promise<RunState> => b().state(id),
  inspect: (id: string): Promise<RunInspector> => b().inspect?.(id) ?? unsupported(t('show a run step by step')),
  runs: (types: string[], limit = 25, result: 'all' | 'success' | 'failed' | 'running' = 'all'): Promise<RunRow[]> => b().runs(types, limit, result),
  history: (id: string) => b().history?.(id) ?? Promise.resolve([]),
  schedules: (targets: string[]): Promise<Schedule[]> => b().schedules.list(targets),
  createSchedule: (target: string, cadence: number | Cadence, name: string, initialData: Json) => b().schedules.create(target, cadence, name, initialData),
  updateSchedule: (uuid: string, patch: SchedulePatch) => b().schedules.update(uuid, patch),
  /** The shortest gap the backend's schedules allow, in minutes, and whether they take time expressions. */
  get scheduleRules() { return { minMinutes: b().schedules.minIntervalMinutes ?? 1, expressions: !!b().schedules.expressions } },
  setScheduleActive: (uuid: string, active: boolean) => b().schedules.setActive(uuid, active),
  deleteSchedule: (uuid: string) => b().schedules.remove(uuid),
  fieldOptions: (type: string, partial: Json): Promise<FieldDecision[]> => b().fieldOptions?.(type, partial) ?? Promise.resolve([]),
  get kind() { return b().kind },
  get capabilities() {
    const c = b().capabilities ?? { publish: true, run: true }
    return { ...c, draft: c.draft ?? c.publish }
  },
  /** Whether this person's Save publishes: a publishing backend, and the right to publish (else Save keeps a draft). */
  get savePublishes() { return !!b().publish && (b().capabilities?.publish ?? true) },
}


export type Status = 'new' | 'draft' | 'live'
export type Panel = 'none' | 'order' | 'json' | 'runs' | 'assistant'
/** How the open workflow is shown: the step list or the diagram. Both edit the same recipe. */
export type View = 'steps' | 'diagram'

export interface Entry {
  /** Lineage name once saved; `local:<id>` before. */
  key: string
  title: string
  status: Status
  /** Newest saved version (0 = never saved) and the live one. */
  version: number
  head: CompositionRow | null
  live: CompositionRow | null
  stepCount: number
  updatedAt: string | null
  tags: string[]
  /** Workflow types of every known version (runs and schedules point at these). */
  versionTypes: string[]
  versionOf: Record<string, number>
  /** Live but not offered to this workspace; publishing again makes it available. */
  unexposed?: boolean
  recipe: Recipe | null
  /** The saved version as a recipe: "unsaved changes" compares against it. */
  saved: Recipe | null
  childDefs: Record<string, CompositionDefinition>
  loading: boolean
  error: string | null
  /**
   * Someone saved a newer version while this one was being edited: the edits
   * are kept, and saving warns first ("Warn, then save").
   */
  conflict?: { base: number; theirs: number } | null
}

/** The platform's read/check workflows refuse inputs over 16 KB (engine ReadOnlyDataWorkflow cap). */
export const CHECK_INPUT_LIMIT = 16 * 1024

/** What the quick check needs: the definition without the builder's own layout notes. */
function forCheck(definition: CompositionDefinition): CompositionDefinition {
  const metadata = { ...(definition.metadata ?? {}) }
  delete metadata.recipe
  return { ...definition, metadata }
}

export function isLimitError(message: string | null | undefined): boolean {
  return !!message && /size cap|hard cap is|item cap|exceeds the query workflow/i.test(message)
}

export interface Validation {
  key: string
  pending: boolean
  /** Too big for the platform's quick check: size in bytes. */
  tooLarge?: number
  result: ValidateResult | null
  problems: ServerProblem[]
  error: string | null
  dryRun: boolean
}

export interface RunView {
  workflowId: string
  workflowType: string
  status: 'running' | 'success' | 'failed'
  steps: Record<string, InspectorStep['status']>
  failures: Record<string, string>
  output: Json | null
  error: string | null
  startedAt: number
}

interface State {
  org: string | null
  entries: Entry[]
  selected: string | null
  panel: Panel
  listLoading: boolean
  listError: string | null
  validation: Record<string, Validation>
  runs: Record<string, RunView>
  saving: Record<string, boolean>
  schedules: Record<string, Schedule[]>
  /** The last save of each workflow, for the editor's message (survives the rename a first save does). */
  lastSave: Record<string, { result: SaveResult; children: SaveResult[]; at: number }>
  /** The list's search and filters (remembered per organization). */
  filter: WorkflowFilter
  /** Schedules and recent runs of every workflow, for the filters. */
  facts: ListFacts | null
  /** Workflows using the step in `filter.usesStep`; null while unknown. */
  usingStep: { type: string; names: Set<string> | null; error: string | null } | null
  /** Whether the platform can search by step (`uses_workflow_type`). */
  canFilterByStep: boolean
  view: View
  /** The open workflow takes the whole window (side panes collapsed). */
  fullPage: boolean
  /** Bumped when undo/redo availability changes. */
  historyTick: number
}

const VIEW_KEY = 'view'
function readView(): View {
  return kv.get(VIEW_KEY) === 'diagram' ? 'diagram' : 'steps'
}

function initialState(): State {
  return { org: null, entries: [], selected: null, panel: 'none', listLoading: false, listError: null, validation: {}, runs: {}, saving: {}, schedules: {}, lastSave: {}, filter: emptyFilter, facts: null, usingStep: null, canFilterByStep: false, view: 'steps', fullPage: false, historyTick: 0 }
}

let state: State = initialState()

/** Undo/redo per workflow, shared by the step list and the diagram. */
const histories = new Map<string, History<Recipe>>()
function historyOf(key: string): History<Recipe> {
  let h = histories.get(key)
  if (!h) { h = new History<Recipe>(); histories.set(key, h) }
  return h
}
const listeners = new Set<() => void>()

function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

function patchEntry(key: string, patch: Partial<Entry> | ((e: Entry) => Partial<Entry>)) {
  set({ entries: state.entries.map((e) => (e.key === key ? { ...e, ...(typeof patch === 'function' ? patch(e) : patch) } : e)) })
}

export function useBuilder(): State {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => state)
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ---- Unsaved edits, per organization ----

interface PublishAttempt { key: string; fingerprint: string; expectedVersion: number }

interface Draft {
  recipe: Recipe
  baseVersion: number
  title: string
  /** Publish attempts in flight, by lineage: each one's idempotency key and expected version, for the content it sent. */
  publish?: Record<string, PublishAttempt>
}
const draftKey = (scope: string | null) => `drafts.v2.${scope ?? 'none'}`

function readDrafts(org: string | null): Record<string, Draft> {
  try { return JSON.parse(kv.get(draftKey(org)) ?? '{}') as Record<string, Draft> } catch { return {} }
}

function writeDraft(key: string, draft: Draft | null) {
  try {
    const all = readDrafts(state.org)
    if (draft) all[key] = draft
    else delete all[key]
    kv.set(draftKey(state.org), JSON.stringify(all))
  } catch { /* storage unavailable: edits stay in memory */ }
}

const filterKey = (scope: string | null) => `filter.${scope ?? 'none'}`

function readStoredFilter(org: string | null): WorkflowFilter {
  try { return readFilter(kv.get(filterKey(org))) } catch { return emptyFilter }
}

function baselineOf(recipe: Recipe): string {
  return canonicalJson(compileFor(recipe).definition)
}

function lineageTitle(row: CompositionRow): string {
  if (row.title) return row.title
  const name = row.name.replace(/[-_]+/g, ' ').trim()
  return name ? name[0].toUpperCase() + name.slice(1) : row.name
}

/** Names of the per-item compositions a definition calls (multi-step For each). */
function childNames(definition: CompositionDefinition): string[] {
  const meta = definition.metadata?.recipe as RecipeMeta | undefined
  const out: string[] = []
  const walk = (nodes: RecipeMeta['tree']) => nodes.forEach((n) => {
    if (typeof n === 'string') return
    if ('each' in n && n.each.child) out.push(n.each.child)
    walk(n.items)
  })
  if (meta?.tree) walk(meta.tree)
  return out
}

function stepTypes(definition: CompositionDefinition): string[] {
  return definition.layers.flatMap((l) => [...l.steps, ...(l.compensate ?? [])].map((s) => s.workflow_type))
}

/**
 * Publish one composition. Trying again with the same content is the same
 * attempt: the same idempotency key and the same expected version (a publish
 * that timed out may have gone through, and moved the head). Only content the
 * person changed, or a version they chose to save over (`explicit`), starts a
 * new attempt.
 */
async function publishOne(draftKey: string, input: { lineage: string; title: string; definition: CompositionDefinition; description?: string; expectedVersion: number }, explicit = false): Promise<SaveResult> {
  const fingerprint = publishFingerprint({ ...input, expectedVersion: 0 })
  const previous = readDrafts(state.org)[draftKey]?.publish?.[input.lineage]
  const same = previous && previous.fingerprint === fingerprint && (!explicit || previous.expectedVersion === input.expectedVersion)
  const attempt: PublishAttempt = same ? previous : { key: newIdempotencyKey(), fingerprint, expectedVersion: input.expectedVersion }
  const remember = (value: typeof attempt | null) => {
    const draft = readDrafts(state.org)[draftKey]
    if (!draft) return
    const publish = { ...(draft.publish ?? {}) }
    if (value) publish[input.lineage] = value
    else delete publish[input.lineage]
    writeDraft(draftKey, { ...draft, publish })
  }
  remember(attempt)
  try {
    const receipt: PublishReceipt = await publishWithRecovery(b(), { ...input, expectedVersion: attempt.expectedVersion, idempotencyKey: attempt.key }, b().publishRecovery)
    remember(null)
    return receiptAsSave(receipt)
  } catch (error) {
    // A timeout keeps the key, so trying again can't publish twice; any other answer ends the attempt.
    if (!(isComposerError(error) && error.retryable)) remember(null)
    throw error
  }
}

const timeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))])

export const builder = {
  get state() { return state },

  /** Load the organization's workflows (again). */
  async load(org: string | null): Promise<void> {
    if (org !== state.org) set({ org, entries: [], selected: null, validation: {}, runs: {}, schedules: {}, filter: readStoredFilter(org), facts: null, usingStep: null })
    if (!org) return
    set({ listLoading: true, listError: null })
    void catalog.loadList()
    builder.refreshFacts()
    void api.listSupports('uses_workflow_type').then((ok) => {
      if (state.org !== org) return
      set({ canFilterByStep: ok })
      if (ok && state.filter.usesStep && !state.usingStep) void builder.loadUsingStep(state.filter.usesStep)
    })
    try {
      const lineages = await api.lineages()
      if (state.org !== org) return
      const drafts = readDrafts(org)
      const previous = new Map(state.entries.map((e) => [e.key, e]))
      const entries: Entry[] = lineages.map((l) => {
        const prev = previous.get(l.name)
        const sameVersion = prev && prev.version === l.head.version
        const draft = drafts[l.name]
        // Edited here while someone saved a newer version: keep the edits, warn when saving.
        if (prev?.recipe && !sameVersion && draft && draft.baseVersion === (prev.conflict?.base ?? prev.version) && l.head.version > prev.version) {
          return { ...prev, live: l.live, versionTypes: l.versionTypes, versionOf: l.versionOf, unexposed: !!l.unexposed, conflict: { base: prev.conflict?.base ?? prev.version, theirs: l.head.version } }
        }
        return {
          key: l.name, title: (draft?.recipe.name === l.name ? draft.title : undefined) ?? prev?.title ?? lineageTitle(l.head),
          status: l.live && l.live.version === l.head.version ? 'live' : 'draft',
          version: l.head.version, head: l.head, live: l.live,
          stepCount: l.head.step_count ?? 0, updatedAt: l.head.updated_at ?? l.head.created_at ?? null,
          tags: l.head.tags ?? [], versionTypes: l.versionTypes, versionOf: l.versionOf, unexposed: !!l.unexposed,
          recipe: sameVersion ? prev!.recipe : null, saved: sameVersion ? prev!.saved : null,
          childDefs: sameVersion ? prev!.childDefs : {}, loading: false, error: null,
        }
      })
      for (const [key, draft] of Object.entries(drafts)) {
        if (!key.startsWith('local:')) continue
        entries.unshift(previous.get(key) ?? {
          key, title: draft.title, status: 'new', version: 0, head: null, live: null, stepCount: 0, updatedAt: null, tags: [], versionTypes: [], versionOf: {},
          recipe: draft.recipe, saved: null, childDefs: {}, loading: false, error: null,
        })
      }
      set({ entries, listLoading: false })
      if (state.selected && !entries.some((e) => e.key === state.selected)) set({ selected: null })
    } catch (error) {
      set({ listLoading: false, listError: message(error) })
    }
  },

  async select(key: string | null): Promise<void> {
    set({ selected: key })
    if (!key) return
    const entry = state.entries.find((e) => e.key === key)
    if (!entry || entry.recipe || entry.loading || !entry.head) return
    patchEntry(key, { loading: true, error: null })
    try {
      const row = await api.get(entry.head.composition_uuid)
      const definition = row.definition as CompositionDefinition
      const childDefs: Record<string, CompositionDefinition> = {}
      for (const name of childNames(definition)) {
        const child = await api.byName(name)
        if (child?.definition) childDefs[name] = child.definition
      }
      await timeout(catalog.ensure([...stepTypes(definition), ...Object.values(childDefs).flatMap(stepTypes)]), 10_000)
      const decompiled = decompile(definition, catalog, { children: childDefs })
      // The saved definition's name is the engine's version id; the lineage name is what saves go by.
      const metaTitle = (definition.metadata?.recipe as RecipeMeta | undefined)?.title
      const saved: Recipe = { ...decompiled, name: key, title: metaTitle ?? lineageTitle(row) }
      // Unsaved edits made on top of this exact version come back; anything else is stale.
      const draft = readDrafts(state.org)[key]
      const usable = draft && draft.baseVersion === row.version && draft.recipe.name === key && baselineOf(draft.recipe) !== baselineOf(saved)
      // Edits made on an older version than the one now saved: kept, and saving warns first.
      const older = draft && !usable && draft.recipe.name === key && draft.baseVersion > 0 && draft.baseVersion < row.version && baselineOf(draft.recipe) !== baselineOf(saved)
      if (draft && !usable && !older) writeDraft(key, null)
      const recipe = usable || older ? draft.recipe : saved
      patchEntry(key, { recipe, saved, childDefs, head: { ...entry.head, ...row }, title: recipe.title, loading: false, conflict: older ? { base: draft.baseVersion, theirs: row.version } : null })
      void builder.loadSchedules(key)
    } catch (error) {
      const text = message(error)
      patchEntry(key, { loading: false, error: isLimitError(text)
        ? t('It’s too large to open in one read ({detail}).', { detail: text.replace(/^.*?(\d+ items; hard cap is \d+|exceeds[^.]*).*$/s, '$1') })
        : text })
    }
  },

  /** Reload schedules and recent runs for the list filters. */
  refreshFacts() {
    const org = state.org
    void api.facts().then((facts) => { if (state.org === org) set({ facts }) })
  },

  setFilter(change: Partial<WorkflowFilter>) {
    const filter = { ...state.filter, ...change }
    set({ filter })
    kv.set(filterKey(state.org), JSON.stringify(filter))
    if ('usesStep' in change) {
      if (!filter.usesStep) set({ usingStep: null })
      else if (state.canFilterByStep) void builder.loadUsingStep(filter.usesStep)
    }
  },

  async loadUsingStep(type: string): Promise<void> {
    set({ usingStep: { type, names: null, error: null } })
    try {
      const names = await api.namesUsing(type)
      if (state.usingStep?.type === type) set({ usingStep: { type, names, error: null } })
    } catch (error) {
      if (state.usingStep?.type === type) set({ usingStep: { type, names: null, error: message(error) } })
    }
  },

  setPanel(panel: Panel) { set({ panel: state.panel === panel ? 'none' : panel }) },
  openPanel(panel: Panel) { set({ panel }) },

  update(key: string, change: (recipe: Recipe) => Recipe, options: { merge?: boolean } = {}) {
    const entry = state.entries.find((e) => e.key === key)
    if (!entry?.recipe) return
    const recipe = change(entry.recipe)
    if (recipe === entry.recipe) return
    const h = historyOf(key)
    const could = h.canUndo
    h.record(entry.recipe, Date.now(), options.merge ?? true)
    patchEntry(key, { recipe, title: recipe.title })
    if (!could || h.canRedo) set({ historyTick: state.historyTick + 1 })
    writeDraft(key, { recipe, baseVersion: entry.conflict?.base ?? entry.version, title: recipe.title })
  },

  /** Put the recipe back as it was before the last edit (either view). */
  undo(key: string): boolean { return builder.travel(key, 'undo') },
  redo(key: string): boolean { return builder.travel(key, 'redo') },
  travel(key: string, way: 'undo' | 'redo'): boolean {
    const entry = state.entries.find((e) => e.key === key)
    if (!entry?.recipe) return false
    const h = historyOf(key)
    const recipe = way === 'undo' ? h.undo(entry.recipe) : h.redo(entry.recipe)
    if (!recipe) return false
    patchEntry(key, { recipe, title: recipe.title })
    writeDraft(key, { recipe, baseVersion: entry.conflict?.base ?? entry.version, title: recipe.title })
    set({ historyTick: state.historyTick + 1 })
    return true
  },
  canUndo(key: string): boolean { return histories.get(key)?.canUndo ?? false },
  canRedo(key: string): boolean { return histories.get(key)?.canRedo ?? false },
  /** The next edit starts its own undo step. */
  sealHistory(key: string) { histories.get(key)?.seal() },

  setView(view: View) {
    kv.set(VIEW_KEY, view)
    set({ view, ...(view === 'steps' ? { fullPage: false } : {}) })
  },
  setFullPage(fullPage: boolean) { set({ fullPage, ...(fullPage ? { view: 'diagram' as View } : {}) }) },

  /** The newest saved version of a workflow on the platform (to warn before saving over someone else's). */
  async remoteVersion(key: string): Promise<number | null> {
    const entry = state.entries.find((e) => e.key === key)
    if (!entry?.head) return null
    try { return await api.headVersion(entry.key) } catch { return null }
  },

  create(): string {
    // An untouched "Untitled workflow" is reused, so pressing + twice doesn't pile up empty drafts.
    const blank = state.entries.find(isBlankDraft)
    if (blank) { set({ selected: blank.key }); return blank.key }
    const taken = new Set(state.entries.map((e) => e.key))
    const recipe = emptyRecipe(t('Untitled workflow'))
    recipe.name = uniqueName(recipe.name, new Set(state.entries.map((e) => e.recipe?.name ?? e.key)))
    // A member's composition reads the organization from its run inputs; an app's gets it from the platform.
    recipe.inputs = api.kind === 'member' ? [{ id: uid('i'), name: 'organization_uuid', label: t('Organization'), type: 'uuid', required: true, hidden: true }] : []
    const key = uniqueName(`local:${uid('w')}`, taken)
    const entry: Entry = { key, title: recipe.title, status: 'new', version: 0, head: null, live: null, stepCount: 0, updatedAt: null, tags: [], versionTypes: [], versionOf: {}, recipe, saved: null, childDefs: {}, loading: false, error: null }
    set({ entries: [entry, ...state.entries], selected: key })
    writeDraft(key, { recipe, baseVersion: 0, title: recipe.title })
    return key
  },

  /** Throw away unsaved edits (or an unsaved workflow). */
  discard(key: string) {
    writeDraft(key, null)
    histories.delete(key)
    if (key.startsWith('local:')) {
      set({ entries: state.entries.filter((e) => e.key !== key), selected: state.selected === key ? null : state.selected })
      return
    }
    patchEntry(key, { recipe: null, saved: null })
    void builder.select(key)
  },

  duplicate(key: string): string | null {
    const source = state.entries.find((e) => e.key === key)
    if (!source?.recipe) return null
    const id = builder.create()
    const names = new Set(state.entries.map((e) => e.recipe?.name ?? e.key))
    builder.update(id, () => ({ ...structuredClone(source.recipe!), name: uniqueName(`${source.recipe!.name}-copy`, names), title: `${source.title} copy`, readOnly: [] }))
    return id
  },

  /** Ask the platform what it thinks of the current recipe (debounced by the editor). */
  async validate(key: string, dryRun = false): Promise<void> {
    const entry = state.entries.find((e) => e.key === key)
    if (!entry?.recipe) return
    const compiled = compileFor(entry.recipe)
    const forKey = canonicalJson(compiled.definition) + (dryRun ? ':dry' : '')
    const prev = state.validation[key]
    if (prev && prev.key === forKey && !prev.error) return
    set({ validation: { ...state.validation, [key]: { key: forKey, pending: true, result: prev?.result ?? null, problems: prev?.problems ?? [], error: null, dryRun } } })
    // A child not saved yet is "unknown" to the platform until the parent's save writes it.
    const unsavedChildren = compiled.children.map((c) => `virtual.${c.name}@latest`)
    const checked = forCheck(compiled.definition)
    const bytes = new TextEncoder().encode(JSON.stringify({ organization_uuid: state.org, definition: checked, include_dry_run: dryRun })).length
    if (bytes > CHECK_INPUT_LIMIT - 512) {
      set({ validation: { ...state.validation, [key]: { key: forKey, pending: false, result: null, problems: [], error: null, dryRun, tooLarge: bytes } } })
      return
    }
    try {
      const result = await api.validate(checked, dryRun)
      const problems = serverProblems(result, compiled.definition, compiled.owners, (text) => unsavedChildren.some((t) => text.includes(t)))
      for (const child of compiled.children) {
        const childResult = await api.validate(forCheck(child.definition), false).catch(() => null)
        if (!childResult) continue
        const loop = Object.entries(compiled.owners).find(([name]) => compiled.definition.layers.some((l) => l.steps.some((s) => s.name === name && s.workflow_type === `virtual.${child.name}@latest`)))?.[1]
        for (const p of serverProblems(childResult, child.definition, compileFor(child.recipe).owners)) problems.push({ ...p, at: p.at ?? loop })
      }
      if (state.validation[key]?.key !== forKey) return
      set({ validation: { ...state.validation, [key]: { key: forKey, pending: false, result, problems, error: null, dryRun } } })
    } catch (error) {
      if (state.validation[key]?.key !== forKey) return
      set({ validation: { ...state.validation, [key]: { key: forKey, pending: false, result: null, problems: [], error: message(error), dryRun } } })
    }
  },

  /** Who still uses the saved versions of this workflow (before saving over it); `error` when the platform couldn't say. */
  async dependents(key: string): Promise<Dependents | { error: string } | null> {
    const entry = state.entries.find((e) => e.key === key)
    if (!entry?.head) return null
    try { return await api.dependents(entry.key) } catch (error) { return { error: message(error) } }
  },

  /**
   * Save: per-item children first, then the workflow; then its schedule.
   * `declareFound` false leaves the questions found in this workflow undeclared, as they were.
   * `overVersion` is the newer version the person chose to save over (after "Save Anyway").
   * A backend that publishes publishes instead, idempotently; a timeout answers `retry`
   * (trying again sends the same key) and someone else's newer version answers `conflict`.
   */
  async save(key: string, { declareFound = true, overVersion }: { declareFound?: boolean; overVersion?: number } = {}): Promise<{ result: SaveResult; children: SaveResult[] } | { error: string; retry?: boolean; conflict?: { base: number; theirs: number } }> {
    const entry = state.entries.find((e) => e.key === key)
    if (!entry?.recipe) return { error: t('Nothing to save') }
    set({ saving: { ...state.saving, [key]: true } })
    try {
      // An app backend publishes by slug (single hyphens, no underscores); a member keeps its names.
      const slugNames = backend?.kind === 'app'
      let name = entry.head ? entry.key : (entry.recipe.name || slug(entry.recipe.title, 'workflow').replace(/_/g, '-'))
      if (!entry.head && slugNames) name = lineageSlug(name)
      if (!entry.head) {
        // A new workflow must not land on an existing one's name: saving by name would add a version to it.
        const taken = new Set(state.entries.filter((e) => e.head).map((e) => e.key))
        const base = name
        while (taken.has(name) || (await api.byName(name).catch(() => null))) {
          taken.add(name)
          name = slugNames ? uniqueLineageSlug(base, taken) : uniqueName(name, taken)
        }
      }
      const recipe = { ...entry.recipe, name }
      const compiled = compileFor(recipe, { declareFound })
      const expectedVersion = entry.head ? overVersion ?? entry.conflict?.base ?? entry.version : 0
      const children: SaveResult[] = []
      for (const child of compiled.children) {
        children.push(api.savePublishes
          ? await publishOne(key, { lineage: child.name, title: child.recipe.title || child.name, definition: child.definition, description: child.recipe.description, expectedVersion: (await api.headVersion(child.name).catch(() => null)) ?? 0 })
          : await api.save(child.name, child.definition, child.recipe.description))
      }
      const result = api.savePublishes
        ? await publishOne(key, { lineage: recipe.name, title: recipe.title, definition: compiled.definition, description: recipe.description, expectedVersion }, overVersion !== undefined)
        : await api.save(recipe.name, compiled.definition, recipe.description, { title: recipe.title, expectedVersion })
      writeDraft(key, null)
      // The backend may keep it under its own lineage name (an app workspace's `ws-…`).
      const savedName = result.name || recipe.name
      const saved: Recipe = { ...recipe, name: savedName, inputs: savedInputs(recipe.inputs, declareFound) }
      const row: CompositionRow = {
        composition_uuid: result.composition_uuid, name: savedName, title: result.title ?? recipe.title, version: result.version, status: result.status,
        workflow_type: result.workflow_type, orn: result.orn, orn_pinned: result.orn_pinned, lineage_uuid: result.lineage_uuid,
        updated_at: new Date().toISOString(), step_count: compiled.definition.layers.reduce((n, l) => n + l.steps.length, 0),
      }
      const live = result.status === 'active' ? row : entry.live
      const next: Partial<Entry> = {
        key: savedName, recipe: saved, saved, version: result.version, head: row, live, conflict: null,
        // Publishing exposes the version again; a draft save leaves the live version as it was.
        unexposed: result.status === 'active' ? false : entry.unexposed,
        status: result.status === 'active' ? 'live' : 'draft', stepCount: row.step_count ?? 0, updatedAt: row.updated_at ?? null,
        tags: entry.tags.length ? entry.tags : ['builder'], versionTypes: [...new Set([...entry.versionTypes, result.workflow_type])], versionOf: { ...entry.versionOf, [result.workflow_type]: result.version },
        childDefs: Object.fromEntries(compiled.children.map((c) => [c.name, c.definition])),
      }
      set({
        entries: state.entries.map((e) => (e.key === key ? { ...e, ...next } : e)),
        selected: state.selected === key ? savedName : state.selected,
        lastSave: { ...state.lastSave, [savedName]: { result, children, at: Date.now() } },
      })
      await builder.syncSchedule(savedName).catch((error) => notify(t('Saved, but the schedule wasn’t updated: {error}', { error: message(error) }), 8000))
      return { result, children }
    } catch (error) {
      if (isComposerError(error, 'VERSION_CONFLICT')) {
        // Someone published a newer version: keep the edits, and warn before saving over it.
        const base = entry.conflict?.base ?? entry.version
        const theirs = error.headVersion ?? (await api.headVersion(entry.key).catch(() => null)) ?? base + 1
        patchEntry(key, { conflict: { base, theirs } })
        return { error: message(error), conflict: { base, theirs } }
      }
      return { error: message(error), ...(isComposerError(error) && error.retryable ? { retry: true } : {}) }
    } finally {
      const saving = { ...state.saving }
      delete saving[key]
      set({ saving })
    }
  },

  async loadSchedules(key: string): Promise<void> {
    const entry = state.entries.find((e) => e.key === key)
    if (!entry?.head) return
    const targets = [entry.head.orn, entry.live?.orn, entry.head.workflow_type, entry.live?.workflow_type].filter((t): t is string => !!t)
    try {
      set({ schedules: { ...state.schedules, [key]: await api.schedules(targets) } })
    } catch { /* schedules are optional */ }
  },

  /** Make the platform schedule match "Runs". */
  async syncSchedule(key: string): Promise<void> {
    await builder.loadSchedules(key)
    const entry = state.entries.find((e) => e.key === key)
    if (!entry?.recipe || !entry.head) return
    const existing = state.schedules[key] ?? []
    const runs = entry.recipe.runs
    const target = entry.head.orn ?? entry.live?.workflow_type ?? entry.head.workflow_type
    if (runs.mode === 'schedule') {
      const initial = (runs.answers ?? {}) as Json
      const cadence = runsCadence(runs)
      const rules = api.scheduleRules
      const problem = cadenceProblem(cadence, rules.minMinutes)
      if (problem) throw new ComposerError(problem.code === 'too-frequent' ? 'SCHEDULE_TOO_FREQUENT' : 'UNKNOWN', { detail: cadenceProblemText(problem) })
      if (cadence.kind === 'cron' && !rules.expressions) throw new Error(t('This backend’s schedules can’t follow a time expression'))
      const when: SchedulePatch = cadence.kind === 'cron'
        ? { schedule_expression: cadence.expression, timezone: cadence.timezone ?? null }
        : { interval_minutes: cadence.everyMinutes, ...(existing[0]?.schedule_expression ? { schedule_expression: null } : {}) }
      if (existing[0]) await api.updateSchedule(existing[0].schedule_uuid, { target_workflow_type: target, ...when, initial_data: initial })
      else await api.createSchedule(target, cadence.kind === 'interval' ? cadence.everyMinutes : cadence, entry.title, initial)
      if (existing[0] && !existing[0].active) await api.setScheduleActive(existing[0].schedule_uuid, true)
    } else {
      for (const s of existing) if (s.active) await api.setScheduleActive(s.schedule_uuid, false)
    }
    await builder.loadSchedules(key)
    builder.refreshFacts()
  },

  async setScheduleActive(key: string, scheduleUuid: string, active: boolean) {
    await api.setScheduleActive(scheduleUuid, active)
    await builder.loadSchedules(key)
    builder.refreshFacts()
  },

  async deleteSchedule(key: string, scheduleUuid: string) {
    await api.deleteSchedule(scheduleUuid)
    await builder.loadSchedules(key)
    builder.refreshFacts()
  },

  /** Start the live version with these answers and follow it step by step. */
  async run(key: string, answers: Json): Promise<void> {
    const entry = state.entries.find((e) => e.key === key)
    const target = entry?.live?.workflow_type
    if (!entry?.recipe || !target) return
    const started = await api.start(target, answers)
    if (!started.workflow_id) throw new Error(t('The backend didn’t return a run id'))
    await builder.follow(key, started.workflow_id, target, true)
  },

  /** Show a run (live or past) on the cards, following it until it ends. */
  async follow(key: string, workflowId: string, workflowType: string, notifyDone = false): Promise<void> {
    const entry = state.entries.find((e) => e.key === key)
    if (!entry?.recipe) return
    const compiled = compileFor(entry.recipe)
    set({ runs: { ...state.runs, [key]: { workflowId, workflowType, status: 'running', steps: {}, failures: {}, output: null, error: null, startedAt: Date.now() } } })
    const setRun = (patch: Partial<RunView>) => set({ runs: { ...state.runs, [key]: { ...state.runs[key], ...patch } } })
    const rank = { pending: 1, succeeded: 2, running: 3, failed: 4, unrecoverable: 4 } as const
    for (let i = 0; i < 2400; i++) {
      if (state.runs[key]?.workflowId !== workflowId) return
      const [inspector, run] = await Promise.all([api.inspect(workflowId).catch(() => null), api.state(workflowId).catch(() => null)])
      if (state.runs[key]?.workflowId !== workflowId) return
      if (inspector) {
        const steps: RunView['steps'] = {}
        const failures: RunView['failures'] = {}
        for (const layer of inspector.layers ?? []) {
          for (const s of layer.steps) {
            const owner = compiled.owners[s.step_name.replace(/#\d+$/, '')]
            if (!owner) continue
            if (!steps[owner] || rank[s.status] > rank[steps[owner]]) steps[owner] = s.status
            if (s.failure_reason) failures[owner] = s.failure_reason
          }
        }
        setRun({ steps, failures })
      }
      if (run?.is_terminal) {
        const data = (run.state_data ?? {}) as Json
        const ok = run.terminal_status === 'success'
        setRun({ status: ok ? 'success' : 'failed', output: data, error: ok ? null : String(data.failure_reason ?? data.error ?? t('The run failed')) })
        if (notifyDone) builder.refreshFacts()
        if (notifyDone) void showNotification(`workflow:${key}`, ok ? t('{title} finished', { title: entry.title }) : t('{title} failed', { title: entry.title }), ok ? t('Open it to see the result.') : String(data.failure_reason ?? t('Open it to see what went wrong.'))).catch(() => {})
        return
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
  },

  clearRun(key: string) {
    const runs = { ...state.runs }
    delete runs[key]
    set({ runs })
  },
}

export function isDirty(entry: Entry): boolean {
  if (!entry.recipe) return false
  if (!entry.saved) return true
  if (entry.recipe === entry.saved) return false
  return baselineOf(entry.saved) !== baselineOf(entry.recipe)
}

/** What the list filters know about a workflow. */
export function subjectOf(entry: Entry, facts: ListFacts | null, validation?: Validation): FilterSubject {
  const types = entry.versionTypes.length ? entry.versionTypes : [entry.head?.workflow_type, entry.live?.workflow_type].filter((t): t is string => !!t)
  const targets = [...types, entry.head?.orn, entry.live?.orn, entry.head?.orn_pinned, entry.live?.orn_pinned].filter((t): t is string => !!t)
  const scheduleStates = targets.map((t) => facts?.schedules.get(t)).filter(Boolean)
  const runs = types.map((t) => facts?.lastRuns.get(t)).filter((r): r is NonNullable<typeof r> => !!r)
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
  const serverFails = validation && !validation.pending && validation.result ? !validation.result.passed : entry.head?.validation?.passed === false
  return {
    key: entry.key, title: entry.title, status: entry.status, dirty: isDirty(entry),
    description: entry.recipe?.description ?? entry.head?.description ?? '', tags: entry.tags,
    workflowTypes: types, ids: [entry.head?.composition_uuid, entry.head?.lineage_uuid].filter((t): t is string => !!t),
    stepCount: entry.stepCount, updatedAt: entry.updatedAt, checkFails: !!serverFails,
    schedule: scheduleStates.includes('active') ? 'active' : scheduleStates.length ? 'paused' : null,
    lastRun: runs[0]?.status ?? null,
  }
}

// ---- Creating and binding the store ----

export interface ComposerStoreOptions {
  backend: CompositionBackend
  catalog?: LiveCatalog
  host?: ComposerHost
}

/**
 * Bind the editor to a backend, a catalog and a host, and start fresh. One
 * store per page: binding again replaces the previous one (and its state).
 */
export function createComposerStore({ backend: next, catalog: nextCatalog, host = {} }: ComposerStoreOptions) {
  backend = next
  boundCatalog = nextCatalog ?? liveCatalog(staticCatalog([]))
  bindHost(host)
  histories.clear()
  state = { ...initialState(), view: readView() }
  for (const l of listeners) l()
  return { builder, api, catalog, useBuilder, isDirty, subjectOf }
}

export type ComposerStore = ReturnType<typeof createComposerStore>

/** Swap the catalog or the host of the bound store without resetting its state. */
export function rebindComposerStore({ catalog: nextCatalog, host }: { catalog?: LiveCatalog; host?: ComposerHost }) {
  if (nextCatalog) boundCatalog = nextCatalog
  if (host) bindHost(host)
  for (const l of listeners) l()
}
