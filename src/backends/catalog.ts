// The platform's workflow catalog as the editor sees it: a LiveCatalog over a
// CatalogSource. The editor asks synchronously (`get`, `search`); schemas
// arrive in the background and a version bump tells it to look again.
//
// Two sources ship: the whole registry for an organization member
// (`registrySource`, `/api/workflows/types`), and an app's authoring catalog
// (built by `appBackend` from `composition.app.catalog`).
import { humanize, type CatalogEntry, type CatalogField, type FieldType, type SearchOptions } from '../model/catalog'
import { SERVER_CONTROLLED } from '../model/definition'
import type { Json, LiveCatalog } from '../ui/host'

/** One step type in the list: enough to search; the schema comes later. */
export interface CatalogRow { type: string; description?: string; readOnly: boolean; featured: boolean }

/** Where a catalog's list and schemas come from. */
export interface CatalogSource {
  /** Every step type the caller may use. */
  list(): Promise<CatalogRow[]>
  /** One type's schema (`fields`, `outputs`, `description`, `read_only`), or null when the source doesn't know it. */
  schema(type: string): Promise<Json | null>
}

export interface CatalogLabels {
  /** Titles people know steps by, by workflow type. Merged over the defaults. */
  titles?: Record<string, string>
  /** App names by namespace (`slack` → `Slack`). Unlisted namespaces are humanized. */
  apps?: Record<string, string>
}

/** Labels people know these by; everything else comes from the description. */
const TITLES: Record<string, string> = {
  'slack.message.send': 'Send a Slack message',
  'slack.approval.request': 'Ask for approval in Slack',
  'slack.channel.resolve': 'Find a Slack channel',
  'aws.ses.send_email': 'Send an email (AWS SES)',
  'ticket.open': 'Open a ticket',
  'ticket.get': 'Get a ticket',
  'ticket.comment': 'Comment on a ticket',
  'control.value.format': 'Format text',
  'control.value.template': 'Fill a text template',
  'control.value.build': 'Build a record',
  'control.value.get': 'Read a value',
  'control.value.set': 'Set a value',
  'control.value.merge': 'Merge records',
  'control.value.coalesce': 'Use the first value that exists',
  'control.value.cast': 'Convert a value',
  'control.predicate.compare': 'Compare two values',
  'control.collection.slice': 'Take part of a list',
  'control.text.join': 'Join text',
  'control.text.split': 'Split text',
  'control.text.replace': 'Replace text',
  'control.time.now': 'Get the current time',
  'control.switch.select': 'Pick a value by case',
  'flow.wait': 'Wait',
  'http.request': 'Call a web address',
}

const ASKS_PERSON = /^(slack\.approval\.request|approval\.request\.)/
const ENGINE_OUTPUTS = /^(failure_reason|failure_type|failed_action|failed_at_state|failed_step|failed_layer|failed_at|error|error_type|workflow_run_id|holder)$/
const FIELD_TYPES = new Set<FieldType>(['string', 'text', 'email', 'uuid', 'integer', 'float', 'boolean', 'datetime', 'list', 'dict', 'json'])

export function titleFor(type: string, description?: string, labels: CatalogLabels = {}): string {
  const curated = labels.titles?.[type] ?? TITLES[type]
  if (curated) return curated
  // Saved workflows run by id (`virtual.<id>@<n>`): the id says nothing to a person.
  if (type.startsWith('virtual.') || type.startsWith('orn:')) return 'Run another workflow'
  const d = (description ?? '').trim()
  if (d) {
    const cut = d.split(/[.;:,(]| with | using | into | via | for an? | from an? /)[0].trim()
    const words = cut.split(/\s+/)
    if (words.length >= 2 && words.length <= 8 && /^[A-Z]/.test(cut)) return cut
  }
  const parts = type.split('.')
  return humanize(parts.slice(-2).reverse().join(' '))
}

export function appFor(type: string, labels: CatalogLabels = {}): string {
  if (type.startsWith('virtual.') || type.startsWith('orn:')) return 'Your workflows'
  const ns = type.split('.')[0]
  return labels.apps?.[ns] ?? humanize(ns)
}

function fieldType(raw: unknown): FieldType {
  const t = String(raw ?? 'json').toLowerCase()
  if (FIELD_TYPES.has(t as FieldType)) return t as FieldType
  if (t === 'str') return 'string'
  if (t === 'int' || t === 'number') return 'integer'
  if (t === 'bool') return 'boolean'
  if (t === 'object' || t === 'map') return 'dict'
  if (t === 'array') return 'list'
  return 'json'
}

/** One catalog field, mapped. `source` is kept to offer pickers (field options). */
export function mapField(raw: Json): CatalogField {
  const source = (raw.source ?? null) as Json | null
  const kind = source && typeof source.kind === 'string' ? source.kind : undefined
  const name = String(raw.name)
  const options = Array.isArray(raw.options) ? (raw.options as unknown[]).map(String)
    : Array.isArray(raw.validators) ? (raw.validators as unknown[]).map(String).find((v) => v.startsWith('choices:'))?.slice(8).split(',') : undefined
  return {
    name,
    type: fieldType(raw.type),
    ...(raw.required ? { required: true } : {}),
    ...(typeof raw.description === 'string' && raw.description ? { description: raw.description } : {}),
    ...(options?.length ? { options } : {}),
    ...(raw.sensitive ? { sensitive: true } : {}),
    ...(raw.default !== undefined && raw.default !== null ? { hasDefault: true } : {}),
    ...(kind === 'context' || kind === 'principal' || SERVER_CONTROLLED.has(name) ? { automatic: true } : {}),
    ...(kind ? { source: { kind, ...(typeof source!.ref === 'string' ? { ref: source!.ref } : {}) } } : {}),
  }
}

/** A schema response as a catalog entry. */
export function mapSchema(type: string, schema: Json, labels: CatalogLabels = {}): CatalogEntry {
  const fields = Array.isArray(schema.fields) ? (schema.fields as Json[]) : []
  const outputs = Array.isArray(schema.outputs) ? (schema.outputs as Json[]) : []
  const inputs = fields.filter((f) => typeof f.name === 'string' && f.name !== 'workflow_run_id').map(mapField)
  const inputNames = new Set(inputs.map((f) => f.name))
  const seen = new Set<string>()
  const outs: CatalogField[] = []
  for (const o of outputs) {
    const name = String(o.name ?? '')
    if (!name || ENGINE_OUTPUTS.test(name) || seen.has(name)) continue
    // Echoed inputs ("Input field preserved in workflow state.") are noise as results.
    const said = String(o.description ?? '')
    if (inputNames.has(name) && (!said || /preserved in workflow state|echoed from input/i.test(said))) continue
    seen.add(name)
    outs.push({ name, type: fieldType(o.type), ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}) })
  }
  const description = typeof schema.description === 'string' ? schema.description : undefined
  // A source may name the step itself (an app's authoring catalog); the host's labels still win.
  const named = typeof schema.display_name === 'string' && schema.display_name ? schema.display_name : undefined
  return {
    type,
    title: labels.titles?.[type] ?? named ?? titleFor(type, description, labels),
    ...(description ? { description } : {}),
    app: appFor(type, labels),
    readOnly: schema.read_only === true,
    inputs,
    outputs: outs,
    ...(ASKS_PERSON.test(type) ? { asksPerson: true } : {}),
  }
}

/** The organization's whole registry, read through GET (`/api/workflows/types`, paged, and each `/schema`). */
export function registrySource(get: (path: string) => Promise<Json>): CatalogSource {
  return {
    async list() {
      const rows: CatalogRow[] = []
      for (let offset = 0; offset < 20_000; offset += 500) {
        const page = await get(`/api/workflows/types?limit=500&offset=${offset}`)
        for (const raw of (page.workflows ?? []) as Json[]) {
          const type = String(raw.name ?? '')
          if (type) rows.push({ type, description: typeof raw.description === 'string' ? raw.description : undefined, readOnly: raw.read_only === true, featured: raw.featured === true })
        }
        if (!page.has_more) break
      }
      return rows
    },
    async schema(type) {
      const schema = await get(`/api/workflows/types/${encodeURIComponent(type)}/schema`)
      return typeof schema.error === 'string' || !Array.isArray(schema.fields) ? null : schema
    },
  }
}

export class PlatformCatalog implements LiveCatalog {
  private readonly entries = new Map<string, CatalogEntry>()
  private readonly rows = new Map<string, CatalogRow>()
  private readonly loading = new Map<string, Promise<CatalogEntry | undefined>>()
  private readonly missing = new Set<string>()
  private readonly listeners = new Set<() => void>()
  version = 0
  listLoaded = false
  listError: string | null = null

  constructor(private readonly source: CatalogSource, private readonly labels: CatalogLabels = {}) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private bump() {
    this.version += 1
    for (const l of this.listeners) l()
  }

  get(type: string): CatalogEntry | undefined {
    const entry = this.entries.get(type)
    if (!entry && !this.missing.has(type)) void this.load(type)
    return entry
  }

  /** Whether the platform said it doesn't know (or won't show) this type. */
  isMissing(type: string): boolean {
    return this.missing.has(type)
  }

  apps(): string[] {
    return [...new Set([...this.rows.values()].map((row) => appFor(row.type, this.labels)))].sort((a, b) => a.localeCompare(b))
  }

  search(query: string, options: SearchOptions = {}): CatalogEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const out: Array<[CatalogEntry, number]> = []
    for (const row of this.rows.values()) {
      if (options.readOnly !== undefined && row.readOnly !== options.readOnly) continue
      if (options.app && appFor(row.type, this.labels) !== options.app) continue
      const entry = this.entries.get(row.type) ?? this.light(row)
      const title = entry.title.toLowerCase()
      const rest = `${entry.app} ${row.description ?? ''} ${row.type}`.toLowerCase()
      if (terms.length && !terms.every((t) => title.includes(t) || rest.includes(t))) continue
      const score = terms.filter((t) => title.includes(t)).length * 3 + terms.filter((t) => row.type.includes(t)).length + (row.featured ? 1 : 0)
      out.push([entry, score])
    }
    out.sort((a, b) => b[1] - a[1] || a[0].app.localeCompare(b[0].app) || a[0].title.localeCompare(b[0].title))
    return out.slice(0, terms.length ? 80 : options.app ? 1000 : 400).map(([e]) => e)
  }

  private light(row: CatalogRow): CatalogEntry {
    return { type: row.type, title: titleFor(row.type, row.description, this.labels), ...(row.description ? { description: row.description } : {}), app: appFor(row.type, this.labels), readOnly: row.readOnly, inputs: [], outputs: [], ...(ASKS_PERSON.test(row.type) ? { asksPerson: true } : {}) }
  }

  /** The list of types (names, descriptions) for search. Read once. */
  async loadList(): Promise<void> {
    if (this.listLoaded) return
    try {
      for (const row of await this.source.list()) this.rows.set(row.type, row)
      this.listLoaded = true
      this.listError = null
    } catch (error) {
      this.listError = error instanceof Error ? error.message : String(error)
    }
    this.bump()
  }

  /** Fetch one type's schema (once). */
  load(type: string): Promise<CatalogEntry | undefined> {
    const cached = this.entries.get(type)
    if (cached) return Promise.resolve(cached)
    let pending = this.loading.get(type)
    if (!pending) {
      pending = this.source.schema(type)
        .then((schema) => {
          if (!schema) { this.missing.add(type); return undefined }
          const entry = mapSchema(type, schema, this.labels)
          this.entries.set(type, entry)
          return entry
        })
        .catch(() => { this.missing.add(type); return undefined })
        .finally(() => { this.loading.delete(type); this.bump() })
      this.loading.set(type, pending)
    }
    return pending
  }

  /** Load several schemas; resolves when all have answered. */
  async ensure(types: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(types)].map((t) => this.load(t)))
  }

  /** For tests and fallbacks: put entries in directly. */
  seed(entries: CatalogEntry[]): void {
    for (const e of entries) {
      this.entries.set(e.type, e)
      this.rows.set(e.type, { type: e.type, description: e.description, readOnly: e.readOnly, featured: true })
    }
    this.bump()
  }
}
