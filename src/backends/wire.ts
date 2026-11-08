// THE WIRE ADAPTER for `appBackend`: every field name the app backend sends
// to, or reads from, the platform lives in this file and nowhere else.
//
// It follows the end-user authoring contract (`composition.app.*`, wrapped by
// the app's `composer-<key>-<app12>` entry points, which pass every input
// through) and the `schedule.app.*` verbs. When the contract moves, change
// this file and its tests; `app.ts` should not need to.
//
// What the contract fixes is read exactly. A few readers stay tolerant where
// it costs nothing (an entry point's output nested under its step); what is
// still not fixed by the contract is marked ASSUMPTION.
import { canonicalJson, type CompositionDefinition } from '../model/definition'
import type { Cadence } from '../model/schedule'
import type { CompositionRow, Json, Lineage, PublishInput, PublishPending, PublishReceipt, RunRow, SaveResult, Schedule, SchedulePatch, ValidateResult } from '../ui/host'
import { ComposerError, REFUSAL_CODES, type ComposerErrorCode, type RefusalCode } from './errors'

// ---- Entry points ----

/**
 * What each `composer-<key>-<app12>` entry point wraps: `composition.app.<verb>`, and
 * for `workspaces` / `workspace-switch` the person's workspaces
 * (`identity.end-user.organization.query` / `.switch`, input renamed `workspace_uuid`).
 */
export const ENTRY_POINT_KEYS = ['validate', 'list', 'get', 'catalog', 'save-draft', 'publish', 'archive', 'publish-status', 'workspaces', 'workspace-switch'] as const
export type EntryPointKey = (typeof ENTRY_POINT_KEYS)[number]
/** The entry points every authoring-enabled app has. The workspace ones arrived later (identity v0.80.2), so they are optional. */
export const AUTHORING_ENTRY_POINT_KEYS: readonly EntryPointKey[] = ['validate', 'list', 'get', 'catalog', 'save-draft', 'publish', 'archive', 'publish-status']

/** `composer-<key>-<app12>`: the names the app's enablement publishes them under. */
const ENTRY_POINT_NAME = /^composer-(validate|list|get|catalog|save-draft|publish-status|publish|archive|workspace-switch|workspaces)-([0-9a-f]{12})$/

/** One workflow the signed-in end user may start, as the app's exposed list names it. */
export interface ExposedWorkflow { name: string; workflow_type: string }

/**
 * The app's exposed list. ASSUMPTION (not part of the authoring contract): an
 * end user's `GET /api/workflows/types` lists what the app exposes to them; an
 * exposed composition carries its lineage name in `lineage_name`,
 * `composition_name`, `title` or `name`, and the type to start in
 * `workflow_type` (else `name`). Hosts that know better pass `exposed` or
 * `entryPoints` to `appBackend`.
 */
export const EXPOSED_PATH = '/api/workflows/types?limit=500&offset=0'

export function readExposed(out: unknown): ExposedWorkflow[] {
  const rows = listIn(out, ['workflows', 'items', 'exposed', 'entries'])
  const found: ExposedWorkflow[] = []
  for (const raw of rows) {
    if (!isObject(raw)) continue
    const type = str(raw.workflow_type) ?? str(raw.name)
    if (!type) continue
    for (const name of [raw.lineage_name, raw.composition_name, raw.title, raw.name, raw.display_name]) {
      if (typeof name === 'string' && name) found.push({ name, workflow_type: type })
    }
  }
  return found
}

/** The entry points by key, found by name. With `app12`, only that app's. */
export function findEntryPoints(exposed: ExposedWorkflow[], app12?: string): Partial<Record<EntryPointKey, string>> {
  const out: Partial<Record<EntryPointKey, string>> = {}
  for (const e of exposed) {
    const m = ENTRY_POINT_NAME.exec(e.name)
    if (!m || (app12 && m[2] !== app12.toLowerCase())) continue
    out[m[1] as EntryPointKey] ??= e.workflow_type
  }
  return out
}

// ---- Inputs ----

/** Workspace lineage names are `ws-<workspace hex32>-<slug>`; anything else is a slug. */
const WORKSPACE_NAME = /^ws-[0-9a-f]{32}-(.+)$/

/** The slug part of a workspace lineage name (the name itself when it isn't one). */
export function slugOf(lineage: string): string {
  return WORKSPACE_NAME.exec(lineage)?.[1] ?? lineage
}

/** `lineage_name` for a stored lineage, `slug` for anything else (a new composition, or one known by its slug). */
export const lineageRef = (lineage: string): Json => (WORKSPACE_NAME.test(lineage) ? { lineage_name: lineage } : { slug: lineage })

/** `composition.app.list`: `limit` ≤ 200 (default 50), `cursor`, optional `status` (`live | draft | retired`). */
export const listInput = (cursor?: string | null, status?: 'live' | 'draft' | 'retired'): Json => ({ limit: 200, ...(cursor ? { cursor } : {}), ...(status ? { status } : {}) })
/** `composition.app.get`: one version by uuid, or a lineage (by name or slug) with an optional version. */
export const getInput = (ref: { compositionUuid: string } | { lineage: string; version?: number }): Json =>
  'compositionUuid' in ref ? { composition_uuid: ref.compositionUuid } : { ...lineageRef(ref.lineage), ...(ref.version !== undefined ? { version: ref.version } : {}) }
/** `composition.app.archive`: one version by uuid, or a lineage with its version. */
export const archiveInput = (ref: { compositionUuid: string } | { lineage: string; version: number }): Json =>
  'compositionUuid' in ref ? { composition_uuid: ref.compositionUuid } : { ...lineageRef(ref.lineage), version: ref.version }
/** `composition.app.validate`: the definition; the editor's Test run asks for the dry run. */
export const validateInput = (definition: CompositionDefinition, dryRun = false): Json => ({ definition, ...(dryRun ? { include_dry_run: true } : {}) })
export const publishStatusInput = (idempotencyKey: string): Json => ({ idempotency_key: idempotencyKey })
/** `workspace-switch`: the workspace to make active (the entry point maps it onto the switch verb's `app_organization_uuid`). */
export const switchWorkspaceInput = (workspaceUuid: string): Json => ({ workspace_uuid: workspaceUuid })

export function saveDraftInput(input: { lineage: string; title: string; definition: CompositionDefinition; expectedVersion?: number; description?: string }): Json {
  return {
    // `title` is required for a new lineage; it is always sent.
    ...lineageRef(input.lineage), title: input.title, definition: input.definition,
    ...(input.expectedVersion !== undefined ? { expected_version: input.expectedVersion } : {}),
  }
}

/** `composition.app.publish`: the save-draft inputs, `expected_version` required (0 for new), and the attempt's key. */
export function publishInput(input: PublishInput): Json {
  return {
    ...lineageRef(input.lineage), title: input.title, definition: input.definition,
    expected_version: input.expectedVersion, idempotency_key: input.idempotencyKey,
  }
}

// ---- Outputs ----

/**
 * The verb's output from an entry point's output: at the top level, or (cheap
 * tolerance) nested under the entry point's step, at most two levels down.
 */
export function unwrap(out: unknown, keys: string[]): Json {
  const queue: Array<[unknown, number]> = [[out, 0]]
  while (queue.length) {
    const [value, depth] = queue.shift()!
    if (!isObject(value)) continue
    if (keys.some((k) => k in value)) return value
    if (depth < 2) for (const v of Object.values(value)) if (isObject(v)) queue.push([v, depth + 1])
  }
  return isObject(out) ? out : {}
}

/** What the caller may do in the workspace (`list` and `get` say). */
/** `draft`: saving draft versions of one's own compositions (`compositions:draft`); publishing implies it. */
export interface WorkspaceCapabilities { read: boolean; run: boolean; draft: boolean; publish: boolean }

export function readCapabilities(out: Json): WorkspaceCapabilities | null {
  const c = out.capabilities
  if (!isObject(c)) return null
  const publish = c.publish === true
  return { read: c.read !== false, run: c.run === true, draft: c.draft === true || publish, publish }
}

// ---- Workspaces ----

/** One workspace the person belongs to. */
export interface Workspace { uuid: string; name: string; slug: string | null; role: string | null; status: string | null }

function readWorkspace(raw: unknown): Workspace | null {
  if (!isObject(raw)) return null
  const ref = isObject(raw.app_organization_ref) ? raw.app_organization_ref : raw
  const uuid = str(ref.uuid) ?? str(raw.app_organization_uuid)
  if (!uuid) return null
  return { uuid, name: str(ref.name) ?? uuid, slug: str(ref.slug) ?? null, role: str(raw.role) ?? null, status: str(raw.membership_status) ?? null }
}

/** `workspaces` (`identity.end-user.organization.query`): `{items: [{app_organization_ref {uuid, name, slug}, role, membership_status}], total}`. */
export function readWorkspaces(out: unknown): Workspace[] {
  return listIn(unwrap(out, ['items']), ['items']).map(readWorkspace).filter((w): w is Workspace => !!w)
}

/** `workspace-switch`: `{active_app_organization_uuid, app_organization_ref, membership_status}`. */
export function readSwitch(out: unknown): { active: string; workspace: Workspace | null } {
  const o = unwrap(out, ['active_app_organization_uuid'])
  const active = str(o.active_app_organization_uuid)
  if (!active) throw new ComposerError('UNKNOWN', { detail: 'workspace-switch returned no active workspace' })
  return { active, workspace: readWorkspace(o) }
}

/** The contract's statuses as the editor's: a live version is `active`, a retired one stays `retired`. */
function status(value: unknown, fallback: CompositionRow['status']): CompositionRow['status'] {
  const v = str(value)
  if (v === 'live' || v === 'active' || v === 'published') return 'active'
  if (v === 'draft' || v === 'archived' || v === 'retired') return v
  return fallback
}

/** One version (`get`'s `composition`, or `save-draft`'s output). */
export function readRow(raw: Json, fallback: CompositionRow['status'] = 'draft'): CompositionRow {
  return {
    composition_uuid: str(raw.composition_uuid) ?? '',
    name: str(raw.lineage_name) ?? '',
    title: str(raw.title) ?? null,
    version: num(raw.version) ?? 0,
    status: status(raw.status, fallback),
    workflow_type: str(raw.workflow_type) ?? '',
    lineage_uuid: str(raw.lineage_uuid) ?? null,
    // End users schedule and run pinned versions only (`virtual.<uuid>@N`); a following ORN would not
    // fire for them, so the editor is never handed one to target. The pinned ORN is kept.
    orn: null,
    orn_pinned: str(raw.orn_pinned) ?? null,
    validation: isObject(raw.validation) ? raw.validation as CompositionRow['validation'] : null,
    created_at: str(raw.created_at) ?? null,
    updated_at: str(raw.updated_at) ?? null,
    ...(num(raw.step_count) !== undefined ? { step_count: num(raw.step_count) } : {}),
    ...(isObject(raw.definition) ? { definition: raw.definition as unknown as CompositionDefinition } : {}),
  }
}

/**
 * One page of `composition.app.list`: `{lineages, count, next_cursor?, view,
 * capabilities}`. A lineage names its head `{composition_uuid, version,
 * status}` and its live version `{composition_uuid, version, workflow_type}`;
 * the head's workflow type is only known when it is the live one.
 */
export function readListPage(out: unknown): { items: Lineage[]; next?: string; capabilities: WorkspaceCapabilities | null } {
  const page = unwrap(out, ['lineages'])
  const items: Lineage[] = []
  for (const raw of listIn(page, ['lineages'])) {
    if (!isObject(raw)) continue
    const name = str(raw.lineage_name) ?? ''
    const common = {
      name, title: str(raw.title) ?? null, lineage_uuid: str(raw.lineage_uuid) ?? null, orn: null,
      updated_at: str(raw.updated_at) ?? null, ...(num(raw.step_count) !== undefined ? { step_count: num(raw.step_count) } : {}),
    }
    const l = isObject(raw.live) ? raw.live : null
    const live: CompositionRow | null = l ? {
      ...common, composition_uuid: str(l.composition_uuid) ?? '', version: num(l.version) ?? num(raw.live_version) ?? 0, status: 'active',
      workflow_type: str(l.workflow_type) ?? str(raw.live_workflow_type) ?? '',
    } : null
    const h = isObject(raw.head) ? raw.head : {}
    const headUuid = str(h.composition_uuid) ?? ''
    const head: CompositionRow = live && headUuid === live.composition_uuid ? live : {
      ...common, composition_uuid: headUuid, version: num(h.version) ?? num(raw.head_version) ?? 0, status: status(h.status, 'draft'), workflow_type: '',
    }
    const typed = [head, ...(live && live !== head ? [live] : [])].filter((r) => r.workflow_type)
    items.push({
      name, head, live,
      versionTypes: typed.map((r) => r.workflow_type),
      versionOf: Object.fromEntries(typed.map((r) => [r.workflow_type, r.version])),
      ...(live && str(raw.availability) === 'unexposed' ? { unexposed: true } : {}),
    })
  }
  const next = str(page.next_cursor)
  return { items, ...(next ? { next } : {}), capabilities: readCapabilities(page) }
}

/** `composition.app.get`: `{composition, capabilities}`. */
export function readComposition(out: unknown): { row: CompositionRow; headVersion: number | null; capabilities: WorkspaceCapabilities | null } {
  const o = unwrap(out, ['composition'])
  const c = isObject(o.composition) ? o.composition : {}
  return { row: readRow(c), headVersion: num(c.head_version) ?? null, capabilities: readCapabilities(o) }
}

/**
 * `composition.app.validate`: the `composition.validate` fields plus the
 * authoring gate (`authoring`, `findings`, `publishable` = `valid`). Passing
 * means publishable; each finding is a problem, worded by the platform.
 */
export function readValidate(out: unknown): ValidateResult {
  const o = unwrap(out, ['publishable', 'valid', 'passed'])
  const authoring = isObject(o.authoring) ? o.authoring : {}
  const findings = (Array.isArray(o.findings) ? o.findings : Array.isArray(authoring.findings) ? authoring.findings : []).filter(isObject)
  const publishable = typeof o.publishable === 'boolean' ? o.publishable : typeof o.valid === 'boolean' ? o.valid : o.passed === true && !findings.length
  const said = (f: Json) => [str(f.step_name) ? `Step '${str(f.step_name)}'` : '', str(f.message) ?? str(f.reason) ?? str(f.code) ?? ''].filter(Boolean).join(': ')
  return {
    passed: publishable,
    errors: [...strings(o.errors), ...findings.map(said)],
    warnings: strings(o.warnings),
    repairs: Array.isArray(o.repairs) ? o.repairs as ValidateResult['repairs'] : [],
    ...(isObject(o.dry_run) ? { dry_run: o.dry_run as unknown as NonNullable<ValidateResult['dry_run']> } : {}),
  }
}

/** `composition.app.save-draft`: the new draft version. */
export function readSaveDraft(out: unknown): SaveResult {
  const o = unwrap(out, ['composition_uuid'])
  const row = readRow(o)
  return {
    composition_uuid: row.composition_uuid, name: row.name, title: row.title, lineage_uuid: row.lineage_uuid ?? undefined,
    workflow_type: row.workflow_type, version: row.version, status: 'draft',
    validation_passed: o.validation_passed === true, validation_errors: strings(o.validation_errors), validation_warnings: strings(o.validation_warnings),
  }
}

export function readReceipt(r: Json): PublishReceipt {
  return {
    composition_uuid: str(r.composition_uuid) ?? '',
    lineage_uuid: str(r.lineage_uuid) ?? null,
    lineage_name: str(r.lineage_name) ?? '',
    title: str(r.title) ?? null,
    version: num(r.version) ?? 0,
    workflow_type: str(r.workflow_type) ?? '',
    orn_pinned: str(r.orn_pinned) ?? null,
    published_at: str(r.published_at) ?? null,
    request_uuid: str(r.request_uuid) ?? null,
  }
}

/** A finished publish as the editor's SaveResult (a publish is live by definition). */
export function receiptAsSave(receipt: PublishReceipt): SaveResult {
  return {
    composition_uuid: receipt.composition_uuid, name: receipt.lineage_name, title: receipt.title, lineage_uuid: receipt.lineage_uuid ?? undefined,
    workflow_type: receipt.workflow_type, orn_pinned: receipt.orn_pinned, version: receipt.version, status: 'active',
    validation_passed: true, validation_errors: [], validation_warnings: [],
  }
}

/**
 * The outcome `publish` and `publish-status` both return: `{request_uuid,
 * idempotency_key, status, refusal_code, refusal, receipt, replayed, …}`.
 * Publish doesn't raise once its request exists, so `refused` and `failed`
 * are answers: they throw their typed error here. `accepted` is still in
 * progress: `asPending` answers it (publish-status); otherwise it throws
 * PUBLISH_IN_PROGRESS (retryable: check the status, then retry the same key).
 */
export function readPublishOutcome(out: unknown, asPending = false): PublishReceipt | PublishPending {
  const o = unwrap(out, ['request_uuid', 'receipt', 'refusal_code'])
  const state = str(o.status)
  if (state === 'published') return readReceipt({ request_uuid: o.request_uuid, lineage_name: o.lineage_name, ...(isObject(o.receipt) ? o.receipt : {}) })
  if (state === 'refused' || state === 'failed') {
    const refusal = isObject(o.refusal) ? o.refusal : {}
    const code = codeOf(str(refusal.code)) ?? codeOf(str(o.refusal_code)) ?? (state === 'failed' ? 'INTERNAL_ERROR' : 'UNKNOWN')
    throw new ComposerError(code, { detail: detailOf(refusal, str(refusal.message)), data: { ...refusal, request_uuid: o.request_uuid } })
  }
  if (asPending) return { status: 'accepted', request_uuid: str(o.request_uuid) ?? null }
  throw new ComposerError('PUBLISH_IN_PROGRESS', { data: { request_uuid: o.request_uuid } })
}

/** One step type of the app's authoring catalog, mapped for the step catalog. */
export interface AuthoringType { type: string; authorable: boolean; schema: Json }

/**
 * `composition.app.catalog`: `{workflow_types: [{workflow_type, name,
 * description, authorable, reason?, schema: {input_fields, output_fields}}],
 * count, limits}`. The schema is mapped to the registry's shape (`fields`,
 * `outputs`); a server-controlled input is filled by the platform, never asked.
 */
export function readCatalog(out: unknown): AuthoringType[] {
  const o = unwrap(out, ['workflow_types'])
  return listIn(o, ['workflow_types']).filter(isObject).flatMap((raw) => {
    const type = str(raw.workflow_type)
    if (!type) return []
    const schema = isObject(raw.schema) ? raw.schema : {}
    const fields = listIn(schema, ['input_fields']).filter(isObject).map((f) => (f.server_controlled ? { ...f, source: { kind: 'context' } } : f))
    const name = str(raw.name)
    return [{
      type,
      authorable: raw.authorable === true,
      schema: {
        fields, outputs: listIn(schema, ['output_fields']).filter(isObject),
        ...(str(raw.description) ? { description: str(raw.description) } : {}),
        ...(name && name !== type ? { display_name: name } : {}),
      },
    }]
  })
}

/** A fingerprint of what a publish sends, so a retry reuses its attempt's key only for the same content. */
export function publishFingerprint(input: Omit<PublishInput, 'idempotencyKey'>): string {
  return canonicalJson({ l: input.lineage, t: input.title, v: input.expectedVersion, d: input.definition })
}

// ---- Refusals ----

/** Codes other verbs (`schedule.app.*`) use for the same refusals. */
const SYNONYMS: Record<string, ComposerErrorCode> = {
  schedule_not_found: 'NOT_FOUND',
  schedule_interval_too_short: 'SCHEDULE_TOO_FREQUENT',
  schedule_quota_exceeded: 'QUOTA_EXCEEDED',
  schedule_manage_forbidden: 'CAPABILITY_REQUIRED',
}

function codeOf(value: string | undefined): ComposerErrorCode | undefined {
  if (!value) return undefined
  if ((REFUSAL_CODES as readonly string[]).includes(value)) return value as RefusalCode
  return SYNONYMS[value.toLowerCase()]
}

/** What a refusal says beyond its code: the findings, the capability or limit it names, or the platform's words. */
function detailOf(details: Json, said?: string): string | undefined {
  const findings = Array.isArray(details.findings) ? details.findings.filter(isObject) : []
  if (findings.length) return findings.map((f) => [str(f.step_name), str(f.message) ?? str(f.reason) ?? str(f.code)].filter(Boolean).join(': ')).join('; ')
  if (str(details.capability)) return str(details.capability)
  const limit = num(details.maximum) ?? num(details.limit)
  if (limit !== undefined) return String(limit)
  return said
}

/**
 * A client error as a ComposerError. The contract: the message starts with
 * `"<CODE>: "` and the failed run's output carries `failure_details: {code,
 * …}` (with `capability`, `head_version` / `expected_version`, `limit` /
 * `maximum` and `findings` where they apply). The client puts the run's
 * output on `error.data` (or `state_data`); `failure_details` straight on the
 * error, or a bare `error.code`, are read too.
 */
export function refusalOf(error: unknown): ComposerError {
  if (error instanceof ComposerError) return error
  const e = (isObject(error) ? error : {}) as Json
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(e.message ?? '')
  const output = [e.data, e.state_data].find(isObject) ?? {}
  const details = [e.failure_details, output.failure_details].find(isObject) ?? {}
  const prefix = /^\s*([A-Za-z][A-Za-z_]*):\s*([\s\S]*)$/.exec(message)
  const code = codeOf(str(details.code)) ?? codeOf(str(e.code)) ?? codeOf(prefix?.[1]) ?? codeOf(/\b(schedule_[a-z_]+)\b/.exec(message)?.[1])
  const fields: Json = { ...details }
  if (code) {
    const said = codeOf(prefix?.[1]) ? prefix?.[2]?.trim() : message
    const detail = detailOf(details, said || undefined)
    return new ComposerError(code, { data: fields, cause: error, ...(detail ? { detail } : {}) })
  }
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError' || /timed out|timeout/i.test(message)) return new ComposerError('TIMEOUT', { cause: error, data: fields })
  return new ComposerError('UNKNOWN', { detail: message || undefined, cause: error, data: fields })
}

// ---- Schedules (`schedule.app.*`) ----

export const SCHEDULE_VERBS = {
  list: 'schedule.app.list', runs: 'schedule.app.runs', create: 'schedule.app.create', update: 'schedule.app.update',
  pause: 'schedule.app.pause', resume: 'schedule.app.resume', remove: 'schedule.app.delete',
} as const

/** A schedule's target as the redacted row names it: a composition lineage and version, or a workflow type. */
export interface ScheduleTarget { name: string | null; version: number | null; followsHead: boolean; workflowType: string | null }

export function scheduleTarget(raw: Json): ScheduleTarget {
  const t = isObject(raw.target) ? raw.target : {}
  return {
    name: str(t.name) ?? null, version: num(t.version) ?? null, followsHead: t.follows_head === true,
    workflowType: str(raw.target_workflow_type) ?? (str(t.kind) === 'workflow' ? str(t.name) ?? null : null),
  }
}

/** A redacted `schedule.app.*` row as a Schedule; `typeOf` turns its lineage + version back into a workflow type. */
export function readSchedule(raw: Json, typeOf: (target: ScheduleTarget) => string | undefined): Schedule {
  const target = scheduleTarget(raw)
  const seconds = num(raw.interval_seconds) ?? (num(raw.interval_minutes) ?? 0) * 60
  return {
    schedule_uuid: str(raw.schedule_uuid) ?? '',
    name: str(raw.name) ?? '',
    target_workflow_type: typeOf(target) ?? target.workflowType ?? (target.name ? `${target.name}${target.version !== null ? `@${target.version}` : ''}` : ''),
    interval_minutes: Math.round(seconds / 60),
    schedule_expression: str(raw.schedule_expression) ?? null,
    timezone: str(raw.timezone) ?? null,
    active: raw.active === true,
    ...(str(raw.next_run_at) ? { next_run_at: str(raw.next_run_at) } : {}),
    ...(isObject(raw.initial_data) ? { initial_data: raw.initial_data } : {}),
    last_status: str(raw.last_status) ?? null,
    last_error: str(raw.last_error_code) ?? null,
    paused_reason: str(raw.paused_reason) ?? null,
  }
}

export const readScheduleList = (out: unknown): Json[] => listIn(unwrap(out, ['schedules']), ['schedules']).filter(isObject)
export const readScheduleOne = (out: unknown): Json => {
  const o = unwrap(out, ['schedule', 'schedule_uuid'])
  return isObject(o.schedule) ? o.schedule : o
}

export function scheduleCreateInput(target: string, cadence: number | Cadence, name: string, initialData: Json): Json {
  const c: Json = typeof cadence === 'number' ? { interval_minutes: cadence }
    : cadence.kind === 'interval' ? { interval_minutes: cadence.everyMinutes }
    : { schedule_expression: cadence.expression, ...(cadence.timezone ? { timezone: cadence.timezone } : {}) }
  return { target_workflow_type: target, name, initial_data: initialData, active: true, ...c }
}

export function scheduleUpdateInput(scheduleUuid: string, patch: SchedulePatch): Json {
  const out: Json = { schedule_uuid: scheduleUuid }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v
  return out
}

/** `schedule.app.runs`: `{runs: [{workflow_id, status, started_at, finished_at, terminal_status}]}`. */
export function readScheduleRuns(out: unknown, workflowType: string): RunRow[] {
  return listIn(unwrap(out, ['runs']), ['runs']).filter(isObject).map((r) => {
    const terminal = r.terminal_status === 'success' || r.terminal_status === 'failed' ? r.terminal_status : null
    return {
      workflow_uuid: str(r.workflow_id) ?? str(r.workflow_uuid) ?? '',
      workflow_type: str(r.workflow_type) ?? workflowType,
      state_name: str(r.status) ?? '',
      is_terminal: terminal !== null || !!str(r.finished_at),
      terminal_status: terminal,
      created_at_iso: str(r.started_at) ?? null,
      triggered_by: 'schedule',
      source: 'schedule' as const,
    }
  })
}

// ---- Helpers ----

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))) : []
}
function listIn(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value
  if (!isObject(value)) return []
  for (const k of keys) if (Array.isArray(value[k])) return value[k] as unknown[]
  return []
}
