// Steps that run another saved workflow (`virtual.<id>@<n>`, an ORN): find
// that workflow — in this organization's list, else on the platform by its
// type — and read it as a recipe so the diagram can open it inline. Reads
// only; cached for the window.
import { t } from '../i18n'
import { useSyncExternalStore } from 'react'
import type { CompositionDefinition } from '../../model/definition'
import { decompile } from '../../model/decompile'
import type { Recipe } from '../../model/recipe'
import { api, builder, catalog } from '../store'

export interface Nested {
  status: 'loading' | 'ready' | 'error'
  recipe?: Recipe
  /** The organization's workflow it is, when it's one of theirs (can be opened and edited). */
  entryKey?: string
  title?: string
  error?: string
}

export function runsWorkflow(type: string): boolean {
  return type.startsWith('virtual.') || type.startsWith('orn:')
}

/** The builder entry a step's type points at, if it's one of this organization's workflows. */
export function entryFor(type: string): string | null {
  const entries = builder.state.entries
  const byVersion = entries.find((e) => e.versionTypes.includes(type) || e.head?.workflow_type === type || e.head?.orn === type || e.head?.orn_pinned === type || e.live?.orn === type)
  if (byVersion) return byVersion.key
  const latest = /^virtual\.(.+)@latest$/.exec(type)
  if (latest && entries.some((e) => e.key === latest[1])) return latest[1]
  return null
}

const cache = new Map<string, Nested>()
const listeners = new Set<() => void>()
let version = 0
const bump = () => { version++; for (const l of listeners) l() }

function steps(def: CompositionDefinition): string[] {
  return (def.layers ?? []).flatMap((l) => [...(l.steps ?? []), ...(l.compensate ?? [])].map((s) => s.workflow_type))
}

async function load(type: string): Promise<void> {
  const key = entryFor(type)
  const entry = key ? builder.state.entries.find((e) => e.key === key) : null
  let title = entry?.title
  try {
    let def: CompositionDefinition | null = null
    if (entry?.recipe) {
      cache.set(type, { status: 'ready', recipe: entry.recipe, entryKey: entry.key, title: entry.title })
      return bump()
    }
    const row = entry?.head && entry.head.workflow_type === type ? await api.get(entry.head.composition_uuid) : await api.byType(type)
    def = (row?.definition as CompositionDefinition | undefined) ?? null
    if (!def) throw new Error(t('This workflow isn’t one you can open here'))
    title ??= ((def.metadata?.recipe as { title?: string } | undefined)?.title) ?? row?.name
    await Promise.race([catalog.ensure(steps(def)), new Promise((r) => setTimeout(r, 8000))])
    cache.set(type, { status: 'ready', recipe: decompile(def, catalog), entryKey: key ?? undefined, title })
  } catch (error) {
    cache.set(type, { status: 'error', error: error instanceof Error ? error.message : String(error), entryKey: key ?? undefined, title })
  }
  bump()
}

export function nestedFor(type: string): Nested {
  const hit = cache.get(type)
  if (hit) return hit
  const loading: Nested = { status: 'loading', entryKey: entryFor(type) ?? undefined }
  cache.set(type, loading)
  void load(type)
  return loading
}

/** Re-render when nested workflows finish loading. */
export function useNestedVersion(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => version)
}
