// The editor's seam to whatever hosts it. The editor never calls a platform
// API itself: it asks a CompositionBackend (compositions, checks, runs,
// schedules), reads steps from a LiveCatalog, and uses ComposerHost for
// everything the surrounding app owns (dialogs, menus, notifications, storage).
// An organization's console and a customer's app plug in different backends;
// the editor is the same.
import type { Catalog } from '../model/catalog'
import type { CompositionDefinition } from '../model/definition'
import type { Cadence } from '../model/schedule'

export type Json = Record<string, unknown>

// ---- What the backend returns ----

/** One saved version of a composition. */
export interface CompositionRow {
  composition_uuid: string
  name: string
  /** The display name, when the backend keeps one apart from the lineage name (app workspaces). */
  title?: string | null
  version: number
  status: 'draft' | 'active' | 'archived' | 'retired'
  workflow_type: string
  lineage_uuid?: string | null
  orn?: string | null
  orn_pinned?: string | null
  description?: string | null
  tags?: string[]
  source_session_uuid?: string | null
  validation?: { passed?: boolean; errors?: string[]; warnings?: string[] } | null
  created_at?: string | null
  updated_at?: string | null
  layer_count?: number
  step_count?: number
  definition?: CompositionDefinition
}

/** One composition in the list: its newest version and the live one, when they differ. */
export interface Lineage {
  name: string
  head: CompositionRow
  live: CompositionRow | null
  /** Every version's workflow type known to the list (runs and schedules point at these), with its version. */
  versionTypes: string[]
  versionOf: Record<string, number>
  /** Live, but not offered to this workspace (the list's `availability: unexposed`): it can't run until published again. */
  unexposed?: boolean
}

/** What the list filters need beyond the rows: schedules and how the latest runs went. */
export interface ListFacts {
  /** Schedule state by target (workflow type or ORN). */
  schedules: Map<string, 'active' | 'paused'>
  /** How the latest finished run of each workflow type ended. */
  lastRuns: Map<string, { status: 'success' | 'failed'; at: string | null }>
}

export interface ValidateResult {
  passed: boolean
  errors: string[]
  warnings: string[]
  repairs: Array<{ step_name?: string | null; param?: string | null; workflow_type?: string | null; candidates?: Array<{ producer_step?: string; field_name?: string; source_kind?: string; value?: unknown; rationale?: string }>; path?: string; hint?: string }>
  dry_run?: { passed: boolean; errors: string[]; evaluated: boolean }
}

export interface SaveResult {
  composition_uuid: string
  /** The lineage name the backend saved it under, when it isn't the one asked for (app workspaces). */
  name?: string
  title?: string | null
  lineage_uuid?: string
  orn?: string | null
  orn_pinned?: string | null
  workflow_type: string
  version: number
  status: 'draft' | 'active'
  validation_passed: boolean
  validation_errors: string[]
  validation_warnings: string[]
  superseded_versions?: number[]
  stale_dependents?: Array<{ site?: string; uuid?: string; field?: string; references?: string }>
  unchanged?: boolean
}

export interface Dependents {
  name: string
  head_workflow_type?: string
  stale_workflow_types: string[]
  dependents: Array<{ site?: string; uuid?: string; name?: string; field?: string; references?: string; [k: string]: unknown }>
  dependent_count: number
}

export interface Schedule {
  schedule_uuid: string
  name: string
  target_workflow_type: string
  interval_minutes: number
  /** A five-field time expression the schedule follows instead of the interval, read in `timezone`. */
  schedule_expression?: string | null
  /** IANA time zone the expression is read in (UTC when absent). */
  timezone?: string | null
  active: boolean
  next_run_at?: string
  initial_data?: Json
  last_status?: string | null
  last_error?: string | null
  paused_reason?: string | null
}

export interface RunRow {
  workflow_uuid: string
  workflow_type: string
  state_name: string
  is_terminal: boolean
  terminal_status: 'success' | 'failed' | null
  actor?: string | null
  triggered_by?: string | null
  created_at_iso?: string | null
  /** Who started it, when the backend knows: a schedule, this editor (tracked locally), or anything else. */
  source?: 'schedule' | 'editor' | 'other'
}

/** A run as the backend reports it while it goes. */
export interface RunState {
  workflow_id: string
  workflow_type?: string
  state_name?: string
  is_terminal?: boolean
  terminal_status?: 'success' | 'failed' | null
  state_data?: Json
}

export interface InspectorStep {
  step_name: string
  workflow_type: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unrecoverable'
  is_resumable?: boolean
  output_keys?: string[]
  failure_reason?: string
}

export interface RunInspector {
  workflow_id: string
  workflow_type: string
  state_name: string
  terminal_status: 'success' | 'failed' | null
  resumable?: boolean
  layers: Array<{ name: string; index: number; steps: InspectorStep[] }>
}

/** One field the backend can offer choices for (connections, channels…). */
export interface FieldDecision {
  field: string
  status: string
  options?: Array<{ value: unknown; label: string }>
  reason?: string
}

export interface HistoryRow {
  state_name: string
  is_terminal: boolean
  terminal_status: string | null
  created_at_iso?: string
  state_data_json?: unknown
}

// ---- The backend ----

/** What a schedule update may change. A time expression replaces the interval, and the other way round. */
export interface SchedulePatch {
  target_workflow_type?: string
  interval_minutes?: number
  schedule_expression?: string | null
  timezone?: string | null
  initial_data?: Json
  name?: string
}

export interface ScheduleBackend {
  /** The schedules that start any of these targets (workflow types or ORNs). */
  list(targets: string[]): Promise<Schedule[]>
  /** `cadence` is a number of minutes, or a Cadence (an interval, or a time expression in an IANA zone). */
  create(target: string, cadence: number | Cadence, name: string, initialData: Json): Promise<Schedule>
  update(scheduleUuid: string, patch: SchedulePatch): Promise<Schedule>
  setActive(scheduleUuid: string, active: boolean): Promise<unknown>
  remove(scheduleUuid: string): Promise<unknown>
  /** The shortest gap the backend allows between runs, in minutes (app schedules: 15). Absent = 1. */
  minIntervalMinutes?: number
  /** Whether it takes time expressions (`schedule_expression` + `timezone`). Absent = intervals only. */
  expressions?: boolean
}

// ---- Publishing (backends that save drafts and publish them as separate steps) ----

/** Extra context a save may use: the display title, and the version the edits started from. */
export interface SaveOptions {
  title?: string
  /** The head version the edits started from (0 for a new composition). */
  expectedVersion?: number
}

export interface PublishInput {
  /** The lineage name of an existing composition, or a new one's name (slug). */
  lineage: string
  title: string
  definition: CompositionDefinition
  /** The current head version this publish replaces (0 for a new composition); else VERSION_CONFLICT. */
  expectedVersion: number
  /** One per publish attempt: retrying the same attempt never publishes twice. */
  idempotencyKey: string
  description?: string
}

/** What a finished publish returns. */
export interface PublishReceipt {
  composition_uuid: string
  lineage_uuid?: string | null
  lineage_name: string
  title?: string | null
  version: number
  workflow_type: string
  orn_pinned?: string | null
  published_at?: string | null
  request_uuid?: string | null
}

/** A publish the platform accepted but hasn't finished (or that another attempt holds). */
export interface PublishPending {
  status: 'accepted' | 'in_progress'
  request_uuid?: string | null
}

/**
 * Everything the editor reads and writes. Optional members switch features
 * off when absent: no `facts` = no schedule/run filters, no `inspect` = run
 * results without per-step status, no `dependents` = no "who uses this" before
 * saving, no `fieldOptions` = plain inputs instead of pickers.
 */
export interface CompositionBackend {
  /** Who the backend acts for: an organization member, or an end user of an app. */
  kind: 'member' | 'app'
  /** Every composition the caller may see: newest version per name, plus the live one. */
  lineages(): Promise<Lineage[]>
  get(compositionUuid: string): Promise<CompositionRow>
  /** The newest version saved under a lineage name, or null. */
  byName(name: string): Promise<CompositionRow | null>
  /** The composition behind a workflow type or ORN, or null (opening a step that runs another composition). */
  byType?(workflowType: string): Promise<CompositionRow | null>
  /** The newest version number saved under a lineage name (to warn before saving over someone else's). */
  headVersion(name: string): Promise<number | null>
  validate(definition: CompositionDefinition, dryRun?: boolean): Promise<ValidateResult>
  /** Save a new version. A member's save goes live when it passes; an app backend saves a draft. */
  save(name: string, definition: CompositionDefinition, description?: string, options?: SaveOptions): Promise<SaveResult>
  /**
   * Publish a new live version, idempotently. When present, the editor's Save
   * publishes: one idempotency key per attempt (kept with the draft), a
   * timeout checked with `publishStatus` before offering to retry, and
   * VERSION_CONFLICT opened as "someone else saved a newer version".
   */
  publish?(input: PublishInput): Promise<PublishReceipt>
  publishStatus?(idempotencyKey: string): Promise<PublishReceipt | PublishPending>
  /** After a publish times out: how many status checks, how far apart (default 5, 2000 ms). */
  publishRecovery?: { attempts?: number; intervalMs?: number }
  /** Make a saved version the live one. */
  activate?(compositionUuid: string): Promise<unknown>
  /** Retire a version (it stops being live, and stops running from schedules or apps). */
  archive?(compositionUuid: string): Promise<unknown>
  /** The steps this backend lets the caller use, when it knows (an app's authoring catalog). The `catalog` prop wins. */
  catalog?(): LiveCatalog
  dependents?(name: string): Promise<Dependents>
  /** Start a run; the editor follows it with `state` (and `inspect` when present). */
  start(workflowType: string, inputs: Json): Promise<RunState>
  state(workflowId: string): Promise<RunState>
  inspect?(workflowId: string): Promise<RunInspector>
  runs(workflowTypes: string[], limit?: number, result?: 'all' | 'success' | 'failed' | 'running'): Promise<RunRow[]>
  history?(workflowId: string): Promise<HistoryRow[]>
  /** Schedules and recent runs of every composition, for the list filters. */
  facts?(): Promise<ListFacts>
  /** Whether the backend can list compositions using a step type (the "uses step" filter). */
  canFilterByStep?(): Promise<boolean>
  namesUsing?(workflowType: string): Promise<Set<string>>
  fieldOptions?(workflowType: string, partialInputs: Json): Promise<FieldDecision[]>
  schedules: ScheduleBackend
  /**
   * What the caller may do. draft false and publish false = read-only editor; draft without
   * publish = the editor saves drafts and does not publish; run false = no "Run". Absent = all.
   * `draft` absent = the same as `publish`.
   */
  capabilities?: { publish: boolean; run: boolean; draft?: boolean }
}

// ---- The catalog the editor reads steps from ----

/**
 * A catalog that may learn about steps over time: the editor asks
 * synchronously (`get`, `search`) and re-renders when `version` moves.
 */
export interface LiveCatalog extends Catalog {
  readonly version: number
  subscribe(listener: () => void): () => void
  /** Make sure these types are known (loads their schemas when the source can). */
  ensure(types: Iterable<string>): Promise<void>
  /** Load the list of every step (the step picker's first open). */
  loadList(): Promise<void>
  apps(): string[]
}

/** A LiveCatalog over a fixed Catalog (fixtures, tests, a host that preloads every step). */
export function liveCatalog(catalog: Catalog): LiveCatalog {
  return {
    version: 0,
    subscribe: () => () => {},
    ensure: async () => {},
    loadList: async () => {},
    get: (type) => catalog.get(type),
    search: (query, options) => catalog.search(query, options),
    apps: () => catalog.apps?.() ?? [],
    isMissing: catalog.isMissing ? (type) => catalog.isMissing!(type) : undefined,
  }
}

// ---- What the surrounding app provides ----

export type MenuSpec =
  | 'separator'
  | { label: string; action?: () => void; enabled?: boolean; checked?: boolean }
  | { label: string; submenu: MenuSpec[] }

export type ToastKind = 'info' | 'success' | 'warn' | 'error'
/** A button on a toast ("Undo"). */
export interface ToastAction { label: string; run: () => void }

/** Key-value storage for drafts and view preferences (strings only). */
export interface ComposerStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Services the surrounding app owns. Every member is optional: the editor has
 * a DOM default for each (an in-page dialog, menu and toast; storage in
 * localStorage when available).
 */
export interface ComposerHost {
  /** Ask before something destructive. Resolves true to go ahead. */
  confirm?(message: string, options?: { title?: string; okLabel?: string; destructive?: boolean }): Promise<boolean>
  /** A context menu at the pointer. */
  menu?(items: MenuSpec[]): Promise<void>
  /** A short message in the app. */
  toast?(toast: { kind?: ToastKind; text: string; ttl?: number | null; action?: ToastAction }): void
  /** A system notification (a run finished while the person looks elsewhere). */
  notify?(id: string, title: string, body: string): Promise<void>
  /** 'mac' shows ⌘ in shortcuts, anything else Ctrl. Defaults from the user agent. */
  platform?: 'mac' | 'other'
  storage?: ComposerStorage
  /** Separates drafts and preferences per account, organization or workspace. */
  scopeKey?: string
}

// ---- Slots ----

/** What the editor passes to a host-rendered assistant. */
export interface AssistantSlotProps {
  /** The composition as saved (what the assistant should load). */
  definition: CompositionDefinition | null
  /** A plain-text outline of the open composition, edits included. */
  outline: string
  /** Steps picked on the diagram, as context. */
  focus: Array<{ title: string; name: string; type?: string }>
  /** Lineage name, title and version of the open composition. */
  lineage: { key: string; title: string; version: number; compositionUuid: string | null; dirty: boolean }
  /** Hand the editor a proposed definition: the person reviews and applies it. `savedAs` when the assistant already saved one. */
  onPropose(definition: CompositionDefinition, options?: { savedAs?: string | null }): void
}

