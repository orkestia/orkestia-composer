// The data a field can use at a given point of the recipe — what the chip
// picker lists — and the words a chip shows.
import type { Catalog, CatalogField, FieldType } from './catalog'
import { fieldLabel, humanize, unknownEntry } from './catalog'
import { SERVER_CONTROLLED } from './definition'

/** "customer_email" → "customer email": how a field reads inside a chip. */
export function words(name: string): string {
  return name.replace(/[_.-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase()
}
import { allSteps, walk, type Block, type ForEachBlock, type Recipe, type Ref, type Step } from './recipe'

export interface ChipOption {
  ref: Ref
  /** "Order › total" — unique within one listing. */
  label: string
  /** Where it comes from, for grouping: "Starts with", "2 · Get the order". */
  group: string
  type: FieldType
  /** A list of every round's result (data from inside a For each). */
  list?: boolean
}

function fieldsOf(catalog: Catalog, step: Step): CatalogField[] {
  return (catalog.get(step.workflowType) ?? unknownEntry(step.workflowType)).outputs
}

/** Steps in reading order with their 1-based number. */
export function numbered(blocks: Block[]): Map<string, number> {
  const out = new Map<string, number>()
  allSteps(blocks).forEach((s, i) => out.set(s.id, i + 1))
  return out
}

/** For each blocks around a block id, outermost first. */
export function loopsAround(blocks: Block[], id: string): ForEachBlock[] {
  let found: ForEachBlock[] = []
  walk(blocks, (block, scope) => {
    if (block.id === id) found = scope.parents.filter((p): p is ForEachBlock => p.kind === 'foreach')
  })
  return found
}

/** Where data the platform fills in shows: in the picker, on chips, for the assistant. */
export const PROVIDED = 'Filled in by Orkestia'

/**
 * Data the platform fills in from who runs the workflow (the organization, the
 * signed-in person): always there whether or not the workflow declares it, and
 * never a question. The organization always; hidden inputs; and any field a
 * step's schema marks `source.kind: "context"`.
 */
export function providedData(recipe: Recipe, catalog: Catalog): CatalogField[] {
  const out = new Map<string, CatalogField>([['organization_uuid', { name: 'organization_uuid', type: 'uuid' }]])
  for (const input of recipe.inputs) if (input.hidden && !out.has(input.name)) out.set(input.name, { name: input.name, type: input.type })
  for (const step of allSteps(recipe.blocks)) {
    for (const f of catalog.get(step.workflowType)?.inputs ?? []) {
      if (f.source?.kind === 'context' && !out.has(f.name)) out.set(f.name, { name: f.name, type: f.type })
    }
  }
  return [...out.values()]
}

/** The provided field an input ref reads, unless the recipe asks a question by that name. */
export function providedField(recipe: Recipe, catalog: Catalog, name: string): CatalogField | undefined {
  if (recipe.inputs.some((i) => i.name === name && !i.hidden)) return undefined
  return providedData(recipe, catalog).find((f) => f.name === name)
    ?? (SERVER_CONTROLLED.has(name) ? { name, type: name === 'actor' ? 'json' : 'uuid' } : undefined)
}

/**
 * What a step (or block) at `atId` may use: the "Starts with" answers, the
 * results of steps written before it, and the current item of each For each
 * it sits in. `atId` null = the end ("Returns").
 */
export function availableData(recipe: Recipe, catalog: Catalog, atId: string | null): ChipOption[] {
  const out: ChipOption[] = []
  for (const input of recipe.inputs) {
    if (input.hidden) continue
    out.push({ ref: { kind: 'input', name: input.name }, label: input.label || humanize(input.name), group: 'Starts with', type: input.type })
  }
  for (const f of providedData(recipe, catalog)) {
    if (recipe.inputs.some((i) => i.name === f.name && !i.hidden)) continue
    out.push({ ref: { kind: 'input', name: f.name }, label: `${PROVIDED} › ${fieldLabel(f.name)}`, group: PROVIDED, type: f.type })
  }
  const numbers = numbered(recipe.blocks)
  const loopsHere = atId ? loopsAround(recipe.blocks, atId).map((l) => l.id) : []
  let reached = false
  walk(recipe.blocks, (block, scope) => {
    if (reached) return
    if (block.id === atId) { reached = true; return }
    if (block.kind !== 'step') return
    const outsideLoop = scope.parents.some((p) => p.kind === 'foreach' && !loopsHere.includes(p.id))
    const group = `${numbers.get(block.id)} · ${block.title}`
    const fields = fieldsOf(catalog, block)
    out.push({ ref: { kind: 'step', step: block.id, path: '' }, label: `${block.title} › whole result`, group, type: outsideLoop ? 'list' : 'json', ...(outsideLoop ? { list: true } : {}) })
    if (outsideLoop) return
    for (const f of fields) {
      out.push({ ref: { kind: 'step', step: block.id, path: f.name }, label: `${block.title} › ${words(f.name)}`, group, type: f.type })
    }
  })
  if (atId) {
    for (const loop of loopsAround(recipe.blocks, atId)) {
      const as = loop.as || 'item'
      const group = `Each ${as}`
      out.push({ ref: { kind: 'item', loop: loop.id, path: '' }, label: humanize(as), group, type: 'json' })
      for (const f of itemFields(recipe, catalog, loop)) {
        out.push({ ref: { kind: 'item', loop: loop.id, path: f.name }, label: `${humanize(as)} › ${words(f.name)}`, group, type: f.type })
      }
    }
  }
  return dedupeLabels(out)
}

/** The fields of one item of a For each's list, when the list's producer declares them. */
export function itemFields(recipe: Recipe, catalog: Catalog, loop: ForEachBlock): CatalogField[] {
  const list = loop.list
  if (!list || list.kind !== 'step') return []
  const step = allSteps(recipe.blocks).find((s) => s.id === list.step)
  if (!step) return []
  return fieldsOf(catalog, step).find((f) => f.name === list.path)?.fields ?? []
}

function dedupeLabels(options: ChipOption[]): ChipOption[] {
  const seen = new Map<string, number>()
  return options.map((o) => {
    const n = (seen.get(o.label) ?? 0) + 1
    seen.set(o.label, n)
    return n > 1 ? { ...o, label: `${o.label} (${n})` } : o
  })
}

/** Words for a chip, resolved against the current recipe even when it isn't "available". */
export function describeRef(recipe: Recipe, catalog: Catalog, ref: Ref): { label: string; type: FieldType; missing?: boolean } {
  if (ref.kind === 'input') {
    const provided = providedField(recipe, catalog, ref.name)
    if (provided) return { label: `${PROVIDED} › ${fieldLabel(provided.name)}${ref.path ? ` › ${words(ref.path)}` : ''}`, type: ref.path ? 'json' : provided.type }
    const input = recipe.inputs.find((i) => i.name === ref.name)
    if (!input) return { label: humanize(ref.name), type: 'json', missing: true }
    return { label: ref.path ? `${input.label} › ${words(ref.path)}` : input.label, type: ref.path ? 'json' : input.type }
  }
  if (ref.kind === 'step') {
    const step = allSteps(recipe.blocks).find((s) => s.id === ref.step)
    if (!step) return { label: 'Removed step', type: 'json', missing: true }
    if (!ref.path) return { label: `${step.title} › whole result`, type: 'json' }
    const field = fieldsOf(catalog, step).find((f) => f.name === ref.path)
    return { label: `${step.title} › ${words(ref.path)}`, type: field?.type ?? 'json' }
  }
  let loop: ForEachBlock | null = null
  walk(recipe.blocks, (b) => { if (b.id === ref.loop && b.kind === 'foreach') loop = b })
  const found = loop as ForEachBlock | null
  if (!found) return { label: 'Item', type: 'json', missing: true }
  const as = humanize(found.as || 'item')
  if (!ref.path) return { label: as, type: 'json' }
  const field = itemFields(recipe, catalog, found).find((f) => f.name === ref.path)
  return { label: `${as} › ${words(ref.path)}`, type: field?.type ?? 'json' }
}
