// An in-memory CompositionBackend for the harness and the tests. Not part of
// the published API: a real host passes a backend that talks to its platform.
import { compile } from '../model/compile'
import type { CompositionDefinition } from '../model/definition'
import { confirmBigOrders } from '../model/__fixtures__/samples'
import { sampleCatalog } from '../model/__fixtures__/sampleCatalog'
import { liveCatalog, type CompositionBackend, type CompositionRow, type Json, type Lineage, type PublishInput, type PublishReceipt, type RunRow, type RunState, type Schedule } from './host'
import { ComposerError } from '../backends/errors'

export interface FixtureOptions {
  /** Compositions saved before the editor opens (each becomes version 1, live). */
  definitions?: Array<{ name: string; definition: CompositionDefinition }>
  kind?: 'member' | 'app'
  capabilities?: { publish: boolean; run: boolean; draft?: boolean }
  /** Save publishes (idempotently, refusing a stale expected version), as an app backend does. */
  publishing?: boolean
  /** The shortest schedule gap allowed, in minutes. */
  minIntervalMinutes?: number
  /** Lineages that are live but not offered to the workspace; a publish offers them again. */
  unexposed?: string[]
}

export type FixtureBackend = CompositionBackend & {
  rows: CompositionRow[]
  schedulesList: Schedule[]
  started: RunRow[]
  /** Every publish call, as sent. */
  publishes: PublishInput[]
  /** Receipts by idempotency key. */
  receipts: Map<string, PublishReceipt>
  /** When set, the next publish does its work and then answers with this error (a timeout, say). */
  failNextPublish: Error | null
}

let seq = 0
const id = (prefix: string) => `${prefix}${(++seq).toString(16).padStart(8, '0')}`

export const fixtureCatalog = liveCatalog(sampleCatalog)

/** The sample "Confirm big orders" composition, compiled. */
export function sampleDefinition(): CompositionDefinition {
  return sampleCompositions()[0].definition
}

/** The sample composition and the per-item compositions its "For each" calls, saved together. */
export function sampleCompositions(options: { childNames?: 'engine' | 'slug' } = {}): Array<{ name: string; definition: CompositionDefinition }> {
  const recipe = confirmBigOrders()
  const compiled = compile({ ...recipe, name: 'confirm-big-orders' }, sampleCatalog, { childNames: options.childNames })
  return [{ name: 'confirm-big-orders', definition: compiled.definition }, ...compiled.children.map((c) => ({ name: c.name, definition: c.definition }))]
}

export function createFixtureBackend(options: FixtureOptions = {}): FixtureBackend {
  const rows: CompositionRow[] = []
  const schedulesList: Schedule[] = []
  const started: RunRow[] = []
  const runs = new Map<string, RunState>()
  const unexposed = new Set(options.unexposed ?? [])

  const save = (name: string, definition: CompositionDefinition, description?: string) => {
    const version = Math.max(0, ...rows.filter((r) => r.name === name).map((r) => r.version)) + 1
    for (const r of rows) if (r.name === name && r.status === 'active') r.status = 'archived'
    const uuid = id('c')
    const row: CompositionRow = {
      composition_uuid: uuid, name, version, status: 'active', workflow_type: `virtual.${uuid}@${version}`,
      lineage_uuid: rows.find((r) => r.name === name)?.lineage_uuid ?? id('l'),
      description: description ?? null, tags: ['builder'], definition: structuredClone(definition),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      step_count: definition.layers.reduce((n, l) => n + l.steps.length, 0), layer_count: definition.layers.length,
    }
    rows.push(row)
    return row
  }
  for (const d of options.definitions ?? []) save(d.name, d.definition)

  const backend: FixtureBackend = {
    kind: options.kind ?? 'member',
    capabilities: options.capabilities,
    rows,
    schedulesList,
    started,
    publishes: [],
    receipts: new Map(),
    failNextPublish: null,
    async lineages(): Promise<Lineage[]> {
      const names = [...new Set(rows.map((r) => r.name))]
      return names.map((name) => {
        const versions = rows.filter((r) => r.name === name)
        const head = versions.reduce((a, b) => (b.version > a.version ? b : a))
        const live = versions.filter((r) => r.status === 'active').reduce<CompositionRow | null>((a, b) => (!a || b.version > a.version ? b : a), null)
        return {
          name, head, live, versionTypes: versions.map((r) => r.workflow_type), versionOf: Object.fromEntries(versions.map((r) => [r.workflow_type, r.version])),
          ...(live && unexposed.has(name) ? { unexposed: true } : {}),
        }
      })
    },
    async get(uuid) {
      const row = rows.find((r) => r.composition_uuid === uuid)
      if (!row) throw new Error(`No composition ${uuid}`)
      return structuredClone(row)
    },
    async byName(name) {
      const versions = rows.filter((r) => r.name === name)
      return versions.length ? structuredClone(versions.reduce((a, b) => (b.version > a.version ? b : a))) : null
    },
    async byType(type) {
      const row = rows.find((r) => r.workflow_type === type)
      return row ? structuredClone(row) : null
    },
    async headVersion(name) {
      const versions = rows.filter((r) => r.name === name).map((r) => r.version)
      return versions.length ? Math.max(...versions) : null
    },
    async validate() {
      return { passed: true, errors: [], warnings: [], repairs: [] }
    },
    async save(name, definition, description) {
      const row = save(name, definition, description)
      return {
        composition_uuid: row.composition_uuid, lineage_uuid: row.lineage_uuid ?? undefined, workflow_type: row.workflow_type,
        version: row.version, status: 'active', validation_passed: true, validation_errors: [], validation_warnings: [],
      }
    },
    async start(workflowType: string, inputs: Json) {
      const workflowId = id('wf_')
      const state: RunState = { workflow_id: workflowId, workflow_type: workflowType, state_name: 'completed', is_terminal: true, terminal_status: 'success', state_data: { inputs } }
      runs.set(workflowId, state)
      started.unshift({ workflow_uuid: workflowId, workflow_type: workflowType, state_name: 'completed', is_terminal: true, terminal_status: 'success', created_at_iso: new Date().toISOString() })
      return state
    },
    async state(workflowId) {
      const run = runs.get(workflowId)
      if (!run) throw new Error(`No run ${workflowId}`)
      return run
    },
    async runs(types, limit = 25) {
      return started.filter((r) => types.includes(r.workflow_type)).slice(0, limit)
    },
    schedules: {
      async list(targets) { return schedulesList.filter((s) => targets.includes(s.target_workflow_type)) },
      minIntervalMinutes: options.minIntervalMinutes,
      expressions: true,
      async create(target, cadence, name, initialData) {
        const when = typeof cadence === 'number' ? { interval_minutes: cadence }
          : cadence.kind === 'interval' ? { interval_minutes: cadence.everyMinutes }
          : { interval_minutes: 0, schedule_expression: cadence.expression, timezone: cadence.timezone ?? null }
        const s: Schedule = { schedule_uuid: id('s'), name, target_workflow_type: target, ...when, active: true, initial_data: initialData }
        schedulesList.push(s)
        return s
      },
      async update(uuid, patch) {
        const s = schedulesList.find((x) => x.schedule_uuid === uuid)
        if (!s) throw new Error(`No schedule ${uuid}`)
        Object.assign(s, patch)
        return s
      },
      async setActive(uuid, active) {
        const s = schedulesList.find((x) => x.schedule_uuid === uuid)
        if (s) s.active = active
        return { active }
      },
      async remove(uuid) {
        const i = schedulesList.findIndex((x) => x.schedule_uuid === uuid)
        if (i >= 0) schedulesList.splice(i, 1)
        return { deleted: i >= 0 }
      },
    },
  }
  if (options.publishing) {
    backend.publishRecovery = { attempts: 2, intervalMs: 0 }
    backend.publish = async (input) => {
      backend.publishes.push(structuredClone(input))
      const known = backend.receipts.get(input.idempotencyKey)
      if (known) return known
      const head = Math.max(0, ...rows.filter((r) => r.name === input.lineage).map((r) => r.version))
      if (input.expectedVersion !== head) throw new ComposerError('VERSION_CONFLICT', { data: { head_version: head } })
      const row = save(input.lineage, input.definition, input.description)
      row.title = input.title
      unexposed.delete(row.name)
      const receipt: PublishReceipt = {
        composition_uuid: row.composition_uuid, lineage_uuid: row.lineage_uuid, lineage_name: row.name, title: input.title,
        version: row.version, workflow_type: row.workflow_type, orn_pinned: null, published_at: row.created_at, request_uuid: id('r'),
      }
      backend.receipts.set(input.idempotencyKey, receipt)
      const fail = backend.failNextPublish
      backend.failNextPublish = null
      if (fail) throw fail
      return receipt
    }
    backend.publishStatus = async (key) => backend.receipts.get(key) ?? { status: 'accepted' }
  }
  return backend
}
