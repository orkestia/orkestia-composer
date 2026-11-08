// Questions a workflow already uses but never declared. Compositions made
// outside the builder often read run inputs (`{source: "input", field: "store"}`)
// without listing them in `inputs`; the engine passes whatever the run was
// started with. Opening one infers those as "Found in this workflow"
// questions, so they read as questions rather than ones that were removed,
// and the next save declares them.
import type { Catalog, FieldType } from './catalog'
import { compatible, humanize } from './catalog'
import { providedField } from './data'
import { refsOf, uid, walk, type Condition, type Recipe, type RecipeInput, type Ref, type Value } from './recipe'

interface Use { type?: FieldType; required?: boolean }

/**
 * The questions `recipe` reads but doesn't declare, typed from how they're used
 * and the step fields they feed. Never data the platform fills in (organization,
 * signed-in person), nor names in `exclude` (e.g. a fan-out's item).
 */
export function inferQuestions(recipe: Recipe, catalog: Catalog, exclude: ReadonlySet<string> = new Set()): RecipeInput[] {
  const uses = new Map<string, Use[]>()
  const declared = new Set(recipe.inputs.map((i) => i.name))
  const note = (ref: Ref, use: Use = {}) => {
    if (ref.kind !== 'input' || declared.has(ref.name) || exclude.has(ref.name)) return
    if (providedField(recipe, catalog, ref.name)) return
    // Reading inside it ("customer.name", "rows.0") makes it a record or a list.
    const inside = ref.path ? (/^\d+(\.|$)/.test(ref.path) ? 'list' : 'dict') : undefined
    const list = uses.get(ref.name) ?? []
    list.push(inside ? { type: inside } : use)
    uses.set(ref.name, list)
  }
  const value = (v: Value | undefined, use: Use) => {
    if (!v) return
    if (v.kind === 'ref') return note(v.ref, use)
    if (v.kind === 'text') {
      const refs = v.parts.filter((p): p is Ref => typeof p !== 'string')
      // A lone chip is the value itself; mixed with words it's text.
      if (refs.length === 1 && v.parts.length === 1) return note(refs[0], use)
      return refs.forEach((r) => note(r, { type: 'string' }))
    }
    refsOf(v).forEach((r) => note(r))
  }
  const condition = (c: Condition | undefined) => {
    if (!c) return
    if (c.kind === 'not') return condition(c.item)
    if (c.kind !== 'compare') return c.items.forEach(condition)
    if (!c.left) return
    const ordered = ['gt', 'gte', 'lt', 'lte'].includes(c.op)
    const v = c.value
    const type: FieldType | undefined = c.op === 'eq' || c.op === 'ne' || ordered
      ? typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'float') : typeof v === 'boolean' ? 'boolean' : typeof v === 'string' && !ordered ? 'string' : undefined
      : undefined
    note(c.left, { type })
  }

  walk(recipe.blocks, (block, scope) => {
    if (block.kind === 'step') {
      const spec = catalog.get(block.workflowType)
      // A step under "Only if" may not run, so what it needs isn't needed to start.
      const always = !scope.parents.some((p) => p.kind === 'if')
      for (const [name, v] of Object.entries(block.fields)) {
        const field = spec?.inputs.find((f) => f.name === name)
        value(v, { type: field?.type, required: always && !!field?.required && !field.hasDefault })
      }
      for (const undo of block.undo) {
        const uspec = catalog.get(undo.workflowType)
        for (const [name, v] of Object.entries(undo.fields)) value(v, { type: uspec?.inputs.find((f) => f.name === name)?.type })
      }
    } else if (block.kind === 'if') condition(block.condition)
    else if (block.kind === 'repeat') condition(block.until)
    else if (block.list) note(block.list, { type: 'list' })
  })
  for (const ret of recipe.returns) value(ret.value, {})

  return [...uses].map(([name, list]) => ({
    id: uid('i'),
    name,
    label: humanize(name),
    type: guessType(list.map((u) => u.type)),
    required: list.some((u) => u.required),
    found: true,
  }))
}

/** One type for every use: the shared one, the broader of two that fit together, else anything. */
export function guessType(types: Array<FieldType | undefined>): FieldType {
  const known = [...new Set(types.filter((t): t is FieldType => !!t && t !== 'json'))]
  if (!known.length) return 'json'
  if (known.length === 1) return known[0]
  if (!known.every((t) => compatible(t, known[0]))) return 'json'
  if (known.includes('float') || known.includes('integer')) return known.includes('float') ? 'float' : 'integer'
  // An ID here and an email there: both are text.
  return 'string'
}

/** What the save summary says about the found questions a save declares. */
export function foundSummary(count: number): string {
  return `Will also declare ${count} question${count === 1 ? '' : 's'} this workflow already used`
}

/** The recipe as saved: found questions are declared now, unless the save left them out. */
export function savedInputs(inputs: RecipeInput[], declareFound: boolean): RecipeInput[] {
  return inputs.map(({ autoName: _auto, found, ...i }) => (found && !declareFound ? { ...i, found } : i))
}
