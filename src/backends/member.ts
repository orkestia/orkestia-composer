// The backend for an organization member: the platform's composition,
// audit and schedule workflows, run as the person in their organization.
//
//   const backend = memberBackend(client, () => activeOrganizationId)
//
// Every call passes `organization_uuid` when `org` names one, so a console
// scoped to one organization never acts in another.
import type { CompositionDefinition } from '../model/definition'
import type { Cadence } from '../model/schedule'
import type {
  CompositionBackend, CompositionRow, Dependents, FieldDecision, HistoryRow, Json, Lineage, ListFacts, RunInspector, RunRow, RunState, SaveResult, Schedule,
  ScheduleBackend, SchedulePatch, ValidateResult,
} from '../ui/host'
import { PlatformCatalog, registrySource, type CatalogLabels } from './catalog'
import type { WorkflowsClientLike } from './client'

export interface MemberBackendOptions {
  /** Titles and app names for the step catalog (`catalog()`). */
  labels?: CatalogLabels
  /** Tags every save carries (default `['builder']`). */
  tags?: string[]
}

export type MemberBackend = Omit<CompositionBackend, 'catalog'> & {
  kind: 'member'
  activate(compositionUuid: string): Promise<Json>
  archive(compositionUuid: string): Promise<Json>
  dependents(name: string): Promise<Dependents>
  byType(workflowType: string): Promise<CompositionRow | null>
  catalog(): PlatformCatalog
  history(workflowId: string): Promise<HistoryRow[]>
  facts(): Promise<ListFacts>
  /** Whether `data.composition.list` takes a filter yet (the platform adds them over time). */
  listSupports(field: string): Promise<boolean>
}

/** How a cadence goes on the wire: minutes, or a time expression and its zone. */
function cadenceInput(cadence: number | Cadence): Json {
  if (typeof cadence === 'number') return { interval_minutes: cadence }
  return cadence.kind === 'interval'
    ? { interval_minutes: cadence.everyMinutes }
    : { schedule_expression: cadence.expression, ...(cadence.timezone ? { timezone: cadence.timezone } : {}) }
}

export function memberBackend(client: WorkflowsClientLike, org: string | null | (() => string | null | undefined), options: MemberBackendOptions = {}): MemberBackend {
  const orgOf = typeof org === 'function' ? org : () => org
  const input = (extra: Json): Json => {
    const organization_uuid = orgOf()
    return organization_uuid ? { organization_uuid, ...extra } : extra
  }
  const run = <T = Json>(type: string, extra: Json, timeoutMs?: number) => client.run<T>(type, input(extra), timeoutMs)
  const get = client.get ? <T = Json>(path: string) => client.get!<T>(path) : null
  const post = client.post ? <T = Json>(path: string, body: Json) => client.post!<T>(path, body) : null
  let listFields: Promise<Set<string>> | null = null
  let catalog: PlatformCatalog | null = null

  const listSupports = async (field: string): Promise<boolean> => {
    if (!get) return false
    listFields ??= get<{ fields?: Array<{ name: string }> }>('/api/workflows/types/data.composition.list/schema')
      .then((o) => new Set((o.fields ?? []).map((f) => f.name))).catch(() => new Set<string>())
    return (await listFields).has(field)
  }

  const getRow = async (compositionUuid: string): Promise<CompositionRow> => {
    const out = await run<{ composition: CompositionRow }>('data.composition.get', { composition_uuid: compositionUuid })
    return out.composition
  }

  const schedules: ScheduleBackend = {
    expressions: true,
    async list(targets: string[]): Promise<Schedule[]> {
      const out = await run<{ schedules?: Schedule[] }>('schedule.list', { limit: 200 })
      const wanted = new Set(targets)
      return (out.schedules ?? []).filter((s) => wanted.has(s.target_workflow_type))
    },
    create(target: string, cadence: number | Cadence, name: string, initialData: Json): Promise<Schedule> {
      return run<Schedule>('schedule.create', { target_workflow_type: target, ...cadenceInput(cadence), name, initial_data: initialData, active: true })
    },
    update(scheduleUuid: string, patch: SchedulePatch): Promise<Schedule> {
      return run<Schedule>('schedule.update', { schedule_uuid: scheduleUuid, ...patch })
    },
    setActive(scheduleUuid: string, active: boolean): Promise<Json> {
      return run(active ? 'schedule.resume' : 'schedule.pause', { schedule_uuid: scheduleUuid })
    },
    remove(scheduleUuid: string): Promise<Json> {
      return run('schedule.delete', { schedule_uuid: scheduleUuid })
    },
  }

  const backend: MemberBackend = {
    kind: 'member',
    schedules,

    /** Every workflow of the organization: newest version per name, plus the live one. */
    async lineages(): Promise<Lineage[]> {
      const list = (status: string) => run<{ compositions?: CompositionRow[] }>('data.composition.list', { status, limit: 200 }, 120_000)
      const [active, drafts, archived] = await Promise.all([
        list('active'), list('draft'),
        // Superseded versions only tell runs and schedules apart; the list works without them.
        list('archived').catch(() => ({ compositions: [] as CompositionRow[] })),
      ])
      const byName = new Map<string, Lineage>()
      for (const row of [...(active.compositions ?? []), ...(drafts.compositions ?? [])]) {
        const current = byName.get(row.name)
        const live = row.status === 'active' ? row : current?.live ?? null
        const head = !current || row.version > current.head.version ? row : current.head
        byName.set(row.name, {
          name: row.name, head, live: live && (!current?.live || live.version >= current.live.version) ? live : current?.live ?? null,
          versionTypes: [...(current?.versionTypes ?? []), row.workflow_type],
          versionOf: { ...(current?.versionOf ?? {}), [row.workflow_type]: row.version },
        })
      }
      for (const row of archived.compositions ?? []) {
        const lineage = byName.get(row.name)
        if (!lineage) continue
        lineage.versionTypes.push(row.workflow_type)
        lineage.versionOf[row.workflow_type] = row.version
      }
      const at = (r: CompositionRow) => String(r.updated_at ?? r.created_at ?? '')
      return [...byName.values()].sort((a, b) => at(b.head).localeCompare(at(a.head)))
    },

    /** Schedules and recent runs of all the organization's workflows, for the list filters. */
    async facts(): Promise<ListFacts> {
      const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
      const query = (exclude: string[]) => run<{ items?: RunRow[] }>('audit.workflow-run.query', {
        workflow_type_prefixes: ['virtual.'], ...(exclude.length ? { exclude_workflow_type_prefixes: exclude } : {}), since, limit: 500,
      }, 120_000).then((o) => o.items ?? []).catch(() => [] as RunRow[])
      const recentRuns = async () => {
        // Workflows that run every minute fill a page in a few hours; a second page without them reaches the quieter ones.
        const first = await query([])
        const perType = new Map<string, number>()
        for (const r of first) perType.set(r.workflow_type, (perType.get(r.workflow_type) ?? 0) + 1)
        const busy = [...perType].filter(([, n]) => n >= 20).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([t]) => t)
        return busy.length && first.length >= 500 ? [...first, ...(await query(busy))] : first
      }
      const [scheduled, runs] = await Promise.all([
        run<{ schedules?: Schedule[] }>('schedule.list', { limit: 200 }).then((o) => o.schedules ?? []).catch(() => [] as Schedule[]),
        recentRuns(),
      ])
      const facts: ListFacts = { schedules: new Map(), lastRuns: new Map() }
      for (const s of scheduled) {
        // A target scheduled twice counts as scheduled if either one is on.
        if (facts.schedules.get(s.target_workflow_type) !== 'active') facts.schedules.set(s.target_workflow_type, s.active ? 'active' : 'paused')
      }
      for (const r of runs) {
        // How it last ended: a run still waiting (an approval gate, a long poll) says nothing yet.
        if (!r.is_terminal) continue
        const at = r.created_at_iso ?? null
        const prev = facts.lastRuns.get(r.workflow_type)
        if (prev && String(prev.at ?? '') >= String(at ?? '')) continue
        facts.lastRuns.set(r.workflow_type, { status: r.terminal_status === 'success' ? 'success' : 'failed', at })
      }
      return facts
    },

    listSupports,
    canFilterByStep: () => listSupports('uses_workflow_type'),

    /** Names of the workflows that use a step type (server-side search). */
    async namesUsing(workflowType: string): Promise<Set<string>> {
      const rows = await Promise.all(['active', 'draft'].map((status) =>
        run<{ compositions?: CompositionRow[] }>('data.composition.list', { status, uses_workflow_type: [workflowType], include_validation: false, limit: 200 }, 120_000)
          .then((o) => o.compositions ?? [])))
      return new Set(rows.flat().map((r) => r.name))
    },

    get: getRow,

    /** The live (else newest) version of a lineage, by name: for child compositions of a For each. */
    async byName(name: string): Promise<CompositionRow | null> {
      for (const status of ['active', 'draft']) {
        const out = await run<{ compositions?: CompositionRow[] }>('data.composition.list', { name, status, limit: 5 })
        const row = (out.compositions ?? []).sort((a, b) => b.version - a.version)[0]
        if (row) return getRow(row.composition_uuid)
      }
      return null
    },

    /** The newest version number saved under a name (any status but retired), without reading the definitions. */
    async headVersion(name: string): Promise<number | null> {
      const out = await run<{ compositions?: CompositionRow[] }>('data.composition.list', { name, statuses: ['active', 'draft', 'archived'], include_validation: false, limit: 5 })
      const versions = (out.compositions ?? []).filter((r) => r.name === name).map((r) => r.version)
      return versions.length ? Math.max(...versions) : null
    },

    /** A saved composition by the workflow type its version runs as (`virtual.<id>@<n>`), for opening a nested workflow. */
    async byType(workflowType: string): Promise<CompositionRow | null> {
      const out = await run<{ compositions?: CompositionRow[] }>('data.composition.list', { q: workflowType, statuses: ['active', 'draft', 'archived'], include_validation: false, limit: 10 })
      const row = (out.compositions ?? []).find((r) => r.workflow_type === workflowType || r.orn === workflowType || r.orn_pinned === workflowType)
      return row ? getRow(row.composition_uuid) : null
    },

    validate(definition: CompositionDefinition, dryRun = false): Promise<ValidateResult> {
      return run<ValidateResult>('composition.validate', { definition, include_dry_run: dryRun }, 180_000)
    },

    save(name: string, definition: CompositionDefinition, description?: string): Promise<SaveResult> {
      return run<SaveResult>('composition.save', { name, definition, tags: options.tags ?? ['builder'], ...(description ? { description } : {}) }, 240_000)
    },

    activate(compositionUuid: string): Promise<Json> {
      return run('composition.activate', { composition_uuid: compositionUuid }, 180_000)
    },

    archive(compositionUuid: string): Promise<Json> {
      return run('composition.archive', { composition_uuid: compositionUuid })
    },

    dependents(name: string): Promise<Dependents> {
      return run<Dependents>('data.composition.dependents', { name }, 120_000)
    },

    /** Start a run; the editor follows it with `inspect` / `state`. */
    start(workflowType: string, inputs: Json): Promise<RunState> {
      return client.start(workflowType, input(inputs))
    },

    state(workflowId: string): Promise<RunState> {
      return client.state(workflowId)
    },

    async runs(workflowTypes: string[], limit = 25, result: 'all' | 'success' | 'failed' | 'running' = 'all'): Promise<RunRow[]> {
      // One query per version type (each version is its own `virtual.<uuid>@<n>`), newest first.
      const filter: Json = result === 'running' ? { is_terminal: false } : result === 'all' ? {} : { terminal_status: result }
      const lists = await Promise.all([...new Set(workflowTypes)].map((workflow_type) =>
        run<{ items?: RunRow[] }>('audit.workflow-run.query', { workflow_type, limit, offset: 0, ...filter }).then((o) => o.items ?? [])))
      return lists.flat().sort((a, b) => String(b.created_at_iso ?? '').localeCompare(String(a.created_at_iso ?? ''))).slice(0, limit)
    },

    async history(workflowId: string): Promise<HistoryRow[]> {
      const out = await run<{ items?: HistoryRow[] }>('audit.workflow-run.get-history', { workflow_uuid: workflowId, limit: 100, offset: 0 })
      return out.items ?? []
    },

    catalog() {
      catalog ??= new PlatformCatalog(get ? registrySource(get) : { list: async () => [], schema: async () => null }, options.labels)
      return catalog
    },
  }

  if (get) backend.inspect = (workflowId: string): Promise<RunInspector> => get<RunInspector>(`/api/workflows/${encodeURIComponent(workflowId)}/run-inspector`)
  if (post) {
    /** Choices for a field the platform can look up (connections, channels…). */
    backend.fieldOptions = async (workflowType: string, partialInputs: Json): Promise<FieldDecision[]> => {
      const out = await post<{ decisions?: FieldDecision[] }>(`/api/workflows/types/${encodeURIComponent(workflowType)}/field-options`, {
        partial_inputs: input(partialInputs), include_optional: true,
      }).catch(() => ({ decisions: [] as FieldDecision[] }))
      return out.decisions ?? []
    }
  }
  return backend
}
