// What the builder needs to know about a workflow type, whatever serves it:
// sample data in the prototype, `GET /api/workflows/types…/schema` later.

export type FieldType =
  | 'string' | 'text' | 'email' | 'uuid' | 'integer' | 'float' | 'boolean'
  | 'datetime' | 'list' | 'dict' | 'json'

export interface CatalogField {
  name: string
  type: FieldType
  required?: boolean
  description?: string
  /** Fixed choices, shown as a menu. */
  options?: string[]
  /** Filled by the platform (organization, signed-in person): never asked. */
  automatic?: boolean
  sensitive?: boolean
  /** Shape of one item (lists) or of the value (dicts), when known. */
  fields?: CatalogField[]
  /** The schema gives it a default, so leaving it out is fine. */
  hasDefault?: boolean
  /** Where the platform looks its choices up (connections, channels…): offers a picker. */
  source?: { kind: string; ref?: string }
}

export interface CatalogEntry {
  type: string
  /** Short imperative label: "Send an email". */
  title: string
  description?: string
  /** App or area the type belongs to, for grouping: "Slack", "Tickets". */
  app: string
  /** Reads only: safe to run early, alongside other steps. */
  readOnly: boolean
  inputs: CatalogField[]
  outputs: CatalogField[]
  /** Waits for a person (approval, decision). */
  asksPerson?: boolean
}

export interface SearchOptions {
  /** Only this app's steps. */
  app?: string
  /** Only steps that read (true) or only steps that change things (false). */
  readOnly?: boolean
}

export interface Catalog {
  get(type: string): CatalogEntry | undefined
  search(query: string, options?: SearchOptions): CatalogEntry[]
  /** Apps that have steps, for narrowing a search. */
  apps?(): string[]
  /** True once the source said it doesn't know the type (absent = can't tell). */
  isMissing?(type: string): boolean
}

/** "send_release_status" → "Send release status". */
export function humanize(name: string): string {
  const spaced = name.replace(/[_.-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim()
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1).toLowerCase() : name
}

/** A field name as a label: "connection_uuid" → "Connection", "order_id" → "Order ID". */
export function fieldLabel(name: string): string {
  const trimmed = name.replace(/_uuid$/, '') || name
  return humanize(trimmed).replace(/\b(id|url|ts)\b/gi, (w) => w.toUpperCase())
}

/** An entry for a type the catalog doesn't know: generic, conservative. */
export function unknownEntry(type: string): CatalogEntry {
  const nested = type.startsWith('virtual.')
  const last = nested ? 'Run another workflow' : humanize(type.split('.').slice(-2).reverse().join(' '))
  return {
    type,
    title: last,
    app: nested ? 'Workflows' : humanize(type.split('.')[0] ?? 'Other'),
    readOnly: false,
    inputs: [],
    outputs: [],
  }
}

/** Whether a value of type `from` can feed a field of type `to`. */
export function compatible(from: FieldType | undefined, to: FieldType | undefined): boolean {
  if (!from || !to || from === 'json' || to === 'json') return true
  const norm = (t: FieldType): string => (t === 'uuid' || t === 'email' || t === 'text' || t === 'datetime' ? 'string' : t === 'float' ? 'integer' : t)
  return norm(from) === norm(to)
}

export function staticCatalog(entries: CatalogEntry[]): Catalog {
  const byType = new Map(entries.map((e) => [e.type, e]))
  return {
    get: (type) => byType.get(type),
    apps: () => [...new Set(entries.map((e) => e.app))].sort(),
    search: (query, options = {}) => {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
      const pool = entries.filter((e) => (!options.app || e.app === options.app) && (options.readOnly === undefined || e.readOnly === options.readOnly))
      if (!terms.length) return pool
      const score = (e: CatalogEntry) => {
        const title = e.title.toLowerCase()
        const rest = `${e.app} ${e.description ?? ''} ${e.type} ${e.inputs.map((f) => f.name).join(' ')}`.toLowerCase()
        if (!terms.every((t) => title.includes(t) || rest.includes(t))) return -1
        return terms.filter((t) => title.includes(t)).length * 2 + (e.app.toLowerCase().includes(terms[0]) ? 1 : 0)
      }
      return pool.map((e) => [e, score(e)] as const).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).map(([e]) => e)
    },
  }
}
