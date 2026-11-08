// The backend for an app's end user, signed in with Orkestia: compositions of
// the person's workspace, through the `composer-*` entry points the app's
// authoring enablement publishes, and schedules through `schedule.app.*`.
//
//   const backend = appBackend(endUserClient)
//   <CompositionEditor backend={backend} catalog={backend.catalog()} />
//
// Every field name on the wire lives in ./wire.ts.
import type { CompositionDefinition } from '../model/definition'
import { MIN_APP_SCHEDULE_MINUTES, cadenceGapMinutes, type Cadence } from '../model/schedule'
import type {
  ComposerStorage, CompositionBackend, CompositionRow, Json, Lineage, ListFacts, PublishInput, PublishPending, PublishReceipt, RunRow, RunState, SaveOptions,
  SaveResult, Schedule, ScheduleBackend, SchedulePatch, ValidateResult,
} from '../ui/host'
import { PlatformCatalog, type CatalogLabels } from './catalog'
import type { WorkflowsClientLike } from './client'
import { ComposerError, isComposerError } from './errors'
import * as wire from './wire'

export interface AppBackendOptions {
  /** The workflows the app exposes to this person. Default: `GET` the types list (wire.EXPOSED_PATH). */
  exposed?: () => Promise<wire.ExposedWorkflow[]>
  /** Entry-point workflow types by key, when the host already knows them (skips discovery for those). */
  entryPoints?: Partial<Record<wire.EntryPointKey, string>>
  /** The 12-character app suffix of the entry-point names, when the person sees more than one app's. */
  app12?: string
  /** Force what the person may do. Default: what the workspace grants; draft and publish only when the app offers save-draft (and publish). */
  capabilities?: { publish?: boolean; run?: boolean; draft?: boolean }
  /** How long one call may take before it counts as timed out (ms, default 60 000). */
  timeoutMs?: number
  /** Where runs started from the editor are remembered across reloads (default: in memory only). */
  storage?: ComposerStorage
  /** Titles and app names for the catalog. */
  labels?: CatalogLabels
  /** After a publish times out: how many status checks, how far apart (default 5, 2000 ms). */
  publishRecovery?: { attempts?: number; intervalMs?: number }
}

export type AppBackend = Omit<CompositionBackend, 'catalog'> & {
  kind: 'app'
  publish(input: PublishInput): Promise<PublishReceipt>
  publishStatus(idempotencyKey: string): Promise<PublishReceipt | PublishPending>
  saveDraft(input: { lineage: string; title: string; definition: CompositionDefinition; expectedVersion?: number; description?: string }): Promise<SaveResult>
  archive(compositionUuid: string): Promise<void>
  catalog(): PlatformCatalog
  byType(workflowType: string): Promise<CompositionRow | null>
  facts(): Promise<ListFacts>
  readonly capabilities: { publish: boolean; run: boolean; draft: boolean }
  /** The entry points found (after the first call). */
  entryPoints(): Promise<Partial<Record<wire.EntryPointKey, string>>>
  /** The workspaces the person belongs to (needs the app's `composer-workspaces` entry point). */
  workspaces(): Promise<wire.Workspace[]>
  /**
   * Make another workspace the active one (`composer-workspace-switch`; the platform checks
   * membership). Everything read before belongs to the old workspace, so the caches reset;
   * the host reloads its lists. A session bound to the old workspace can no longer start runs.
   */
  switchWorkspace(workspaceUuid: string): Promise<{ active: string; workspace: wire.Workspace | null }>
}

const TRACK_KEY = 'composer.app.runs.v1'
const TRACK_LIMIT = 200

export function appBackend(client: WorkflowsClientLike, options: AppBackendOptions = {}): AppBackend {
  const timeoutMs = options.timeoutMs ?? 60_000
  let discovered: Promise<Partial<Record<wire.EntryPointKey, string>>> | null = null
  let lineagesCache: Lineage[] = []
  /** workflow type ↔ lineage name + version, from every list read: schedules name their target by lineage. */
  const typeIndex = new Map<string, { name: string; version: number }>()
  /** What the workspace lets the person do: the host's say, else what `list` / `get` answered, else the entry points offered. */
  let offered: { publish: boolean; draft: boolean } | null = null
  let granted: wire.WorkspaceCapabilities | null = null
  /** A CAPABILITY_REQUIRED answer to publish / save-draft: the workspace said no, whatever list said. */
  let publishRefused = false
  let draftRefused = false
  const capabilities = () => {
    const publish = options.capabilities?.publish ?? (!publishRefused && (offered?.publish ?? true) && (granted?.publish ?? true))
    return {
      publish,
      run: options.capabilities?.run ?? granted?.run ?? true,
      // Publishing implies drafting. A host that forces publish off without saying anything
      // about drafts keeps what that meant before drafts existed: a read-only editor.
      draft: options.capabilities?.draft
        ?? (options.capabilities?.publish === false ? false
          : publish || (!draftRefused && (offered?.draft ?? true) && (granted?.draft ?? true))),
    }
  }
  const grant = (c: wire.WorkspaceCapabilities | null) => { if (c) granted = c }

  const discover = () => {
    discovered ??= (async () => {
      const given = options.entryPoints ?? {}
      if (wire.AUTHORING_ENTRY_POINT_KEYS.every((k) => given[k])) return given
      const list = options.exposed ? await options.exposed()
        : client.get ? wire.readExposed(await client.get(wire.EXPOSED_PATH))
        : []
      const found = { ...wire.findEntryPoints(list, options.app12), ...given }
      offered = { publish: !!(found['save-draft'] && found.publish), draft: !!found['save-draft'] }
      return found
    })().catch((error) => { discovered = null; throw wire.refusalOf(error) })
    return discovered
  }

  /** Run one entry point; refusals come back typed. */
  const call = async (key: wire.EntryPointKey, input: Json, ms = timeoutMs): Promise<unknown> => {
    const type = (await discover())[key]
    if (!type) throw new ComposerError('ENTRY_POINT_MISSING', { detail: `composer-${key}` })
    try {
      return await client.run(type, input, ms)
    } catch (error) {
      const refusal = wire.refusalOf(error)
      if (refusal.code === 'CAPABILITY_REQUIRED' && key === 'publish') publishRefused = true
      if (refusal.code === 'CAPABILITY_REQUIRED' && key === 'save-draft') {
        // A save on someone else's lineage needs publish, which says nothing about drafting
        // in general: only a refusal that names publish keeps drafts on. The capability comes
        // in failure_details, or (while the platform drops those) in the message.
        const needs = typeof refusal.data?.capability === 'string' ? refusal.data.capability
          : /compositions:(draft|publish)/.exec(refusal.message)?.[0] ?? ''
        // No drafting means no publishing either (publish implies draft).
        if (needs !== 'compositions:publish') { draftRefused = true; publishRefused = true }
      }
      throw refusal
    }
  }
  const verb = async (type: string, input: Json): Promise<unknown> => {
    try { return await client.run(type, input, timeoutMs) } catch (error) { throw wire.refusalOf(error) }
  }
  /**
   * A schedule verb, through the app's `composer-schedule-*` entry point. An app enabled before
   * those existed has none: the verb is then called by name, which the platform refuses for an
   * end user (`NOT_EXPOSED_TO_END_USERS`) until the app re-runs its authoring enablement.
   */
  const scheduleVerb = async (op: keyof typeof wire.SCHEDULE_VERBS, input: Json): Promise<unknown> => {
    const key = wire.SCHEDULE_ENTRY_POINTS[op]
    return (await discover())[key] ? call(key, input) : verb(wire.SCHEDULE_VERBS[op], input)
  }

  const index = (lineages: Lineage[]) => {
    for (const l of lineages) for (const [type, version] of Object.entries(l.versionOf)) typeIndex.set(type, { name: l.name, version })
  }

  const lineages = async (): Promise<Lineage[]> => {
    const all: Lineage[] = []
    let cursor: string | undefined
    for (let page = 0; page < 25; page++) {
      const { items, next, capabilities: c } = wire.readListPage(await call('list', wire.listInput(cursor)))
      grant(c)
      all.push(...items)
      if (!next || next === cursor) break
      cursor = next
    }
    const at = (r: CompositionRow) => String(r.updated_at ?? r.created_at ?? '')
    lineagesCache = all.sort((a, b) => at(b.head).localeCompare(at(a.head)))
    index(lineagesCache)
    return lineagesCache
  }

  const read = async (ref: Parameters<typeof wire.getInput>[0]) => {
    const out = wire.readComposition(await call('get', wire.getInput(ref)))
    grant(out.capabilities)
    if (out.row.workflow_type) typeIndex.set(out.row.workflow_type, { name: out.row.name, version: out.row.version })
    return out
  }
  const getRow = async (compositionUuid: string) => (await read({ compositionUuid })).row
  /** A lineage's head, by lineage name or slug; null when the workspace has none by that name. */
  const byLineage = async (name: string) => {
    try { return await read({ lineage: lineageNamed(name)?.name ?? name }) } catch (error) {
      if (isComposerError(error, 'NOT_FOUND')) return null
      throw error
    }
  }

  /** A lineage by its name, or by the slug a new composition was named with. */
  const lineageNamed = (name: string) => lineagesCache.find((l) => l.name === name) ?? lineagesCache.find((l) => wire.slugOf(l.name) === name) ?? null

  // ---- Runs the editor started, remembered locally (end users can't list runs yet) ----

  let tracked: RunRow[] = (() => {
    try { return JSON.parse(options.storage?.getItem(TRACK_KEY) ?? '[]') as RunRow[] } catch { return [] }
  })()
  const keepTracked = () => {
    tracked = tracked.slice(0, TRACK_LIMIT)
    try { options.storage?.setItem(TRACK_KEY, JSON.stringify(tracked)) } catch { /* in memory only */ }
  }
  const refreshTracked = async (rows: RunRow[]) => {
    await Promise.all(rows.filter((r) => !r.is_terminal).map(async (r) => {
      const s = await client.state(r.workflow_uuid).catch(() => null)
      if (!s) return
      r.state_name = s.state_name ?? r.state_name
      r.is_terminal = !!s.is_terminal
      r.terminal_status = s.terminal_status ?? null
    }))
    keepTracked()
  }

  // ---- Schedules ----

  const typeOfTarget = (target: wire.ScheduleTarget): string | undefined => {
    if (target.workflowType) return target.workflowType
    if (!target.name) return undefined
    const versions = [...typeIndex].filter(([, v]) => v.name === target.name)
    const wanted = target.version ?? (target.followsHead ? Math.max(...versions.map(([, v]) => v.version)) : null)
    return versions.find(([, v]) => v.version === wanted)?.[0]
  }
  const rawSchedules = async () => wire.readScheduleList(await scheduleVerb('list', { limit: 200 }))
  const assertCadence = (cadence: number | Cadence | null) => {
    if (cadence === null) return
    const c: Cadence = typeof cadence === 'number' ? { kind: 'interval', everyMinutes: cadence } : cadence
    if (cadenceGapMinutes(c) < MIN_APP_SCHEDULE_MINUTES) throw new ComposerError('SCHEDULE_TOO_FREQUENT')
  }

  const schedules: ScheduleBackend = {
    minIntervalMinutes: MIN_APP_SCHEDULE_MINUTES,
    expressions: true,
    async list(targets: string[]): Promise<Schedule[]> {
      const wanted = new Set(targets)
      return (await rawSchedules()).map((raw) => wire.readSchedule(raw, typeOfTarget)).filter((s) => wanted.has(s.target_workflow_type))
    },
    async create(target, cadence, name, initialData) {
      assertCadence(cadence)
      return wire.readSchedule(wire.readScheduleOne(await scheduleVerb('create', wire.scheduleCreateInput(target, cadence, name, initialData))), typeOfTarget)
    },
    async update(scheduleUuid: string, patch: SchedulePatch) {
      assertCadence(patch.schedule_expression ? { kind: 'cron', expression: patch.schedule_expression, timezone: patch.timezone } : patch.interval_minutes ?? null)
      return wire.readSchedule(wire.readScheduleOne(await scheduleVerb('update', wire.scheduleUpdateInput(scheduleUuid, patch))), typeOfTarget)
    },
    setActive: (scheduleUuid, active) => scheduleVerb(active ? 'resume' : 'pause', { schedule_uuid: scheduleUuid }),
    remove: (scheduleUuid) => scheduleVerb('remove', { schedule_uuid: scheduleUuid }),
  }

  let catalog: PlatformCatalog | null = null
  let catalogRows: Promise<Map<string, wire.AuthoringType>> | null = null
  const loadCatalog = () => {
    catalogRows ??= call('catalog', {}).then((out) => new Map(wire.readCatalog(out).map((e) => [e.type, e])))
      .catch((error) => { catalogRows = null; throw error })
    return catalogRows
  }

  const backend: AppBackend = {
    kind: 'app',
    publishRecovery: options.publishRecovery,
    get capabilities() { return capabilities() },
    entryPoints: discover,

    async workspaces() {
      return wire.readWorkspaces(await call('workspaces', {}))
    },

    async switchWorkspace(workspaceUuid: string) {
      const out = wire.readSwitch(await call('workspace-switch', wire.switchWorkspaceInput(workspaceUuid)))
      // Another workspace: its lineages, versions and grants are not the old one's.
      lineagesCache = []
      typeIndex.clear()
      granted = null
      publishRefused = false
      draftRefused = false
      return out
    },
    schedules,
    lineages,
    get: getRow,

    async byName(name) {
      return (await byLineage(name))?.row ?? null
    },

    async byType(workflowType) {
      const known = typeIndex.get(workflowType)
      const l = known ? lineageNamed(known.name) : lineagesCache.find((x) => x.versionTypes.includes(workflowType))
      if (!l) return null
      if (l.head.workflow_type === workflowType) return getRow(l.head.composition_uuid)
      if (l.live?.workflow_type === workflowType) return getRow(l.live.composition_uuid)
      return null
    },

    async headVersion(name) {
      const found = await byLineage(name)
      return found ? found.headVersion ?? found.row.version : null
    },

    async validate(definition: CompositionDefinition, dryRun = false): Promise<ValidateResult> {
      return wire.readValidate(await call('validate', wire.validateInput(definition, dryRun)))
    },

    /** A save from the editor is a draft; Save in the editor publishes (see `publish`). */
    save(name: string, definition: CompositionDefinition, description?: string, saveOptions: SaveOptions = {}) {
      return backend.saveDraft({ lineage: lineageNamed(name)?.name ?? name, title: saveOptions.title ?? name, definition, expectedVersion: saveOptions.expectedVersion, description })
    },

    async saveDraft(input) {
      return wire.readSaveDraft(await call('save-draft', wire.saveDraftInput(input)))
    },

    async publish(input: PublishInput): Promise<PublishReceipt> {
      // Refused and failed publishes are answers, not errors: the outcome reader throws them typed.
      const receipt = wire.readPublishOutcome(await call('publish', wire.publishInput({ ...input, lineage: lineageNamed(input.lineage)?.name ?? input.lineage }))) as PublishReceipt
      typeIndex.set(receipt.workflow_type, { name: receipt.lineage_name, version: receipt.version })
      return receipt
    },

    async publishStatus(idempotencyKey: string) {
      return wire.readPublishOutcome(await call('publish-status', wire.publishStatusInput(idempotencyKey)), true)
    },

    async archive(compositionUuid: string) {
      await call('archive', wire.archiveInput({ compositionUuid }))
    },

    /** Runs a live version (`virtual.<uuid>@N`), remembered here as started from the editor. */
    async start(workflowType: string, inputs: Json): Promise<RunState> {
      let state: RunState
      try { state = await client.start(workflowType, inputs) } catch (error) { throw wire.refusalOf(error) }
      if (state.workflow_id) {
        tracked.unshift({
          workflow_uuid: state.workflow_id, workflow_type: workflowType, state_name: state.state_name ?? 'started',
          is_terminal: !!state.is_terminal, terminal_status: state.terminal_status ?? null,
          created_at_iso: new Date().toISOString(), triggered_by: 'editor', source: 'editor',
        })
        keepTracked()
      }
      return state
    },

    state: (workflowId) => client.state(workflowId),

    async runs(workflowTypes, limit = 25, result = 'all') {
      const types = new Set(workflowTypes)
      const mine = tracked.filter((r) => types.has(r.workflow_type))
      await refreshTracked(mine)
      const scheduled = (await rawSchedules().catch(() => [])).map((raw) => ({ raw, type: typeOfTarget(wire.scheduleTarget(raw)) })).filter((s) => s.type && types.has(s.type))
      const fromSchedules = (await Promise.all(scheduled.map(async ({ raw, type }) =>
        wire.readScheduleRuns(await scheduleVerb('runs', { schedule_uuid: raw.schedule_uuid, limit }).catch(() => ({})), type!)))).flat()
      const seen = new Set<string>()
      return [...mine, ...fromSchedules]
        .filter((r) => (seen.has(r.workflow_uuid) ? false : (seen.add(r.workflow_uuid), true)))
        .filter((r) => result === 'all' || (result === 'running' ? !r.is_terminal : r.terminal_status === result))
        .sort((a, b) => String(b.created_at_iso ?? '').localeCompare(String(a.created_at_iso ?? '')))
        .slice(0, limit)
    },

    /** Schedules for the list filters, and how the runs started here ended. */
    async facts(): Promise<ListFacts> {
      const facts: ListFacts = { schedules: new Map(), lastRuns: new Map() }
      for (const raw of await rawSchedules().catch(() => [])) {
        const s = wire.readSchedule(raw, typeOfTarget)
        if (facts.schedules.get(s.target_workflow_type) !== 'active') facts.schedules.set(s.target_workflow_type, s.active ? 'active' : 'paused')
      }
      for (const r of tracked) {
        if (!r.is_terminal || facts.lastRuns.has(r.workflow_type)) continue
        facts.lastRuns.set(r.workflow_type, { status: r.terminal_status === 'success' ? 'success' : 'failed', at: r.created_at_iso ?? null })
      }
      return facts
    },

    /** The app's authoring catalog: only the steps the app lets its people use. */
    catalog() {
      catalog ??= new PlatformCatalog({
        // Only authorable steps go in the picker; the others still have a schema, so a definition using one reads well.
        list: async () => [...(await loadCatalog()).values()].filter((e) => e.authorable)
          .map((e) => ({ type: e.type, readOnly: false, featured: true, ...(typeof e.schema.description === 'string' ? { description: e.schema.description } : {}) })),
        schema: async (type) => (await loadCatalog()).get(type)?.schema ?? null,
      }, options.labels)
      return catalog
    },
  }
  return backend
}

/** Whether an error means "the same attempt may still finish": check `publishStatus`, then offer to retry. */
export const isPendingPublish = (error: unknown) => isComposerError(error) && error.retryable
