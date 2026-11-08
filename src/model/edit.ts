// Edits the diagram makes, as pure functions on the recipe — the same model the
// step builder edits, so switching between the two never loses anything.
// Wires on the diagram are the compiler's dependencies (compile.ts `deps`);
// drawing one adds an explicit "run after" (Step.after) unless the order
// already holds, and removing one undoes whatever made it, where it can.
import type { Catalog, CatalogEntry } from './catalog'
import { compile } from './compile'
import {
  allSteps, findBlock, insertBlocks, locate, mapRecipeRefs, mapSteps, newStep, refsOf, removeBlock, slug, stepNames, uid, uniqueName, updateBlock, walk,
  type Block, type Recipe, type Ref, type Step, type Value,
} from './recipe'

export type Where = { parent: string | null; index: number }

/** Every block id in reading order (steps and containers). */
export function readingOrder(recipe: Recipe): Map<string, number> {
  const out = new Map<string, number>()
  let n = 0
  walk(recipe.blocks, (b) => { out.set(b.id, n++) })
  return out
}

/** Direct dependencies between blocks, as the compiler sees them. */
export function dependencies(recipe: Recipe, catalog: Catalog): Array<{ from: string; to: string }> {
  return compile(recipe, catalog).deps
}

/** Whether `to` already waits (directly or through others) for `from`. */
export function waitsFor(deps: Array<{ from: string; to: string }>, from: string, to: string): boolean {
  const next = new Map<string, string[]>()
  for (const d of deps) next.set(d.from, [...(next.get(d.from) ?? []), d.to])
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length) {
    const at = stack.pop()!
    for (const n of next.get(at) ?? []) {
      if (n === to) return true
      if (!seen.has(n)) { seen.add(n); stack.push(n) }
    }
  }
  return false
}

/** The block ids a dependency on `id` lands on: itself, or for a container the steps inside. */
function stepsOf(recipe: Recipe, id: string): Step[] {
  const found = findBlock(recipe.blocks, id)
  if (!found) return []
  return found.block.kind === 'step' ? [found.block] : allSteps(found.block.blocks)
}

function changeSteps(recipe: Recipe, ids: Set<string>, change: (s: Step) => Step): Recipe {
  return { ...recipe, blocks: mapSteps(recipe.blocks, (s) => (ids.has(s.id) ? change(s) : s)) }
}

/** Move block `id` to just after `anchor`, in the anchor's container. */
export function placeAfter(recipe: Recipe, id: string, anchor: string): Recipe {
  if (id === anchor) return recipe
  const found = findBlock(recipe.blocks, id)
  if (!found || (found.block.kind !== 'step' && findBlock(found.block.blocks, anchor))) return recipe
  const without = removeBlock(recipe.blocks, id)
  const at = locate(without, anchor)
  if (!at) return recipe
  return { ...recipe, blocks: insertBlocks(without, at.parent, at.index + 1, [found.block]) }
}

/** Reading order follows the wire: when `to` is written before `from`, move it after. */
function keepReadingOrder(recipe: Recipe, from: string, to: string): Recipe {
  const order = readingOrder(recipe)
  const f = order.get(from)
  const t = order.get(to)
  if (f === undefined || t === undefined || t > f) return recipe
  const toBlock = findBlock(recipe.blocks, to)
  // A container never moves inside itself.
  if (toBlock && toBlock.block.kind !== 'step' && findBlock(toBlock.block.blocks, from)) return recipe
  return placeAfter(recipe, to, from)
}

/** Make `to` run after `from` (a wire drawn from one block to another). */
export function connect(recipe: Recipe, catalog: Catalog, from: string, to: string): Recipe {
  if (from === to || !findBlock(recipe.blocks, from) || !findBlock(recipe.blocks, to)) return recipe
  const ordered = keepReadingOrder(recipe, from, to)
  if (waitsFor(dependencies(ordered, catalog), from, to)) return ordered
  const targets = new Set(stepsOf(ordered, to).map((s) => s.id))
  return changeSteps(ordered, targets, (s) => ({ ...s, after: [...new Set([...(s.after ?? []), from])] }))
}

export type Kept = 'data' | 'condition' | 'order' | 'after' | 'list' | null

/**
 * Remove the wire `from → to`: drop an explicit "run after", and for two
 * actions in a row let the second run at the same time instead. Data a step
 * uses can't be cut this way: `kept` says why the wire stays.
 */
export function disconnect(recipe: Recipe, catalog: Catalog, from: string, to: string): { recipe: Recipe; kept: Kept } {
  const targets = new Set(stepsOf(recipe, to).map((s) => s.id))
  let next = changeSteps(recipe, targets, (s) => {
    if (!s.after?.includes(from)) return s
    const after = s.after.filter((x) => x !== from)
    const out: Step = { ...s, after }
    if (!after.length) delete out.after
    return out
  })
  const still = () => dependencies(next, catalog).some((d) => d.from === from && d.to === to)
  if (!still()) return { recipe: next, kept: null }
  const reason = whyWaits(next, catalog, from, to)
  if (reason === 'order') {
    const target = findBlock(next.blocks, to)?.block
    if (target?.kind === 'step') next = changeSteps(next, new Set([to]), (s) => ({ ...s, alongside: true }))
    if (!still()) return { recipe: next, kept: null }
  }
  return { recipe: next, kept: reason }
}

/** Why `to` waits for `from`: its data, a condition around it, or the order actions were written in. */
export function whyWaits(recipe: Recipe, _catalog: Catalog, from: string, to: string): Kept {
  const target = findBlock(recipe.blocks, to)
  if (!target) return null
  const fromSteps = new Set([from, ...stepsOf(recipe, from).map((s) => s.id)])
  const usesFrom = (ref: Ref) => ref.kind === 'step' && fromSteps.has(ref.step)
  const steps = target.block.kind === 'step' ? [target.block] : allSteps(target.block.blocks)
  if (steps.some((s) => s.after?.some((a) => fromSteps.has(a)))) return 'after'
  if (steps.some((s) => Object.values(s.fields).some((v) => refsOf(v).some(usesFrom)))) return 'data'
  if (target.block.kind === 'foreach' && target.block.list && usesFrom(target.block.list)) return 'list'
  for (const parent of target.scope.parents) {
    if (parent.kind === 'foreach' && parent.list && usesFrom(parent.list)) return 'list'
    if (parent.kind === 'if' && conditionUses(parent.condition, usesFrom)) return 'condition'
  }
  if (target.block.kind !== 'step') {
    let inner: Kept = null
    walk(target.block.blocks, (b) => {
      if (b.kind === 'foreach' && b.list && usesFrom(b.list)) inner = 'list'
      if (b.kind === 'if' && conditionUses(b.condition, usesFrom)) inner ??= 'condition'
    })
    if (inner) return inner
  }
  return 'order'
}

function conditionUses(c: import('./recipe').Condition, test: (r: Ref) => boolean): boolean {
  if (c.kind === 'compare') return !!c.left && test(c.left)
  if (c.kind === 'not') return conditionUses(c.item, test)
  return c.items.some((i) => conditionUses(i, test))
}

/** Drag the end of a wire somewhere else. */
export function rewire(recipe: Recipe, catalog: Catalog, old: { from: string; to: string }, next: { from: string; to: string }): { recipe: Recipe; kept: Kept } {
  const cut = disconnect(recipe, catalog, old.from, old.to)
  return { recipe: connect(cut.recipe, catalog, next.from, next.to), kept: cut.kept }
}

/** Where a new block goes so it reads between `from` and `to`. */
function slotBetween(recipe: Recipe, from: string | null, to: string | null): Where {
  const at = to ? locate(recipe.blocks, to) : null
  if (at) return at
  const after = from ? locate(recipe.blocks, from) : null
  if (after) return { parent: after.parent, index: after.index + 1 }
  return { parent: null, index: recipe.blocks.length }
}

/** Add a step from the catalog at a place in the recipe. */
export function addStep(recipe: Recipe, entry: Pick<CatalogEntry, 'type' | 'title'>, where: Where): { recipe: Recipe; id: string } {
  const step = newStep(entry.type, entry.title, stepNames(recipe))
  return { recipe: { ...recipe, blocks: insertBlocks(recipe.blocks, where.parent, where.index, [step]) }, id: step.id }
}

/** "+" on a wire: a new step that runs after `from` and before `to` (either may be the start or the end). */
export function insertBetween(recipe: Recipe, catalog: Catalog, entry: Pick<CatalogEntry, 'type' | 'title'>, from: string | null, to: string | null): { recipe: Recipe; id: string } {
  const added = addStep(recipe, entry, slotBetween(recipe, from, to))
  let next = added.recipe
  const id = added.id
  if (from) {
    const deps = dependencies(next, catalog)
    if (!waitsFor(deps, from, id)) next = changeSteps(next, new Set([id]), (s) => ({ ...s, after: [from] }))
  }
  if (to) {
    const deps = dependencies(next, catalog)
    if (!waitsFor(deps, id, to)) {
      const targets = new Set(stepsOf(next, to).map((s) => s.id))
      next = changeSteps(next, targets, (s) => ({ ...s, after: [...new Set([...(s.after ?? []).filter((a) => a !== from), id])] }))
    }
  }
  return { recipe: next, id }
}

/**
 * Run these steps at the same time. They are put next to each other (in the
 * first one's container), lose the "run after" between them, and actions are
 * marked to run alongside the one before. Steps that use each other's data
 * can't: `blocked` lists them.
 */
export function parallelize(recipe: Recipe, catalog: Catalog, ids: string[]): { recipe: Recipe; blocked: string[] } {
  const order = readingOrder(recipe)
  const chosen = [...new Set(ids)].filter((id) => findBlock(recipe.blocks, id)?.block.kind === 'step').sort((a, b) => (order.get(a)! - order.get(b)!))
  if (chosen.length < 2) return { recipe, blocked: [] }
  let next = recipe
  for (let i = 1; i < chosen.length; i++) next = placeAfter(next, chosen[i], chosen[i - 1])
  const set = new Set(chosen)
  next = changeSteps(next, set, (s) => {
    const after = (s.after ?? []).filter((a) => !set.has(a))
    const out: Step = { ...s, after, alongside: s.id !== chosen[0] && !(catalog.get(s.workflowType)?.readOnly ?? false) }
    if (!after.length) delete out.after
    return out
  })
  const deps = dependencies(next, catalog)
  const blocked = chosen.filter((to) => chosen.some((from) => from !== to && deps.some((d) => d.from === from && d.to === to)))
  return { recipe: next, blocked }
}

/** Run these steps one after another, in reading order. */
export function sequence(recipe: Recipe, catalog: Catalog, ids: string[]): Recipe {
  const order = readingOrder(recipe)
  const chosen = [...new Set(ids)].filter((id) => findBlock(recipe.blocks, id)).sort((a, b) => (order.get(a)! - order.get(b)!))
  let next = changeSteps(recipe, new Set(chosen), (s) => ({ ...s, alongside: false }))
  for (let i = 1; i < chosen.length; i++) {
    const deps = dependencies(next, catalog)
    if (!waitsFor(deps, chosen[i - 1], chosen[i])) next = connect(next, catalog, chosen[i - 1], chosen[i])
  }
  return next
}

/** Feed a step's field from an earlier result or a "Starts with" answer (drag output → input). */
export function mapData(recipe: Recipe, source: Ref, target: { step: string; field: string }): Recipe {
  const found = findBlock(recipe.blocks, target.step)
  if (!found || found.block.kind !== 'step') return recipe
  if (source.kind === 'step' && source.step === target.step) return recipe
  let next: Recipe = { ...recipe, blocks: updateBlock(recipe.blocks, target.step, (b) => (b.kind === 'step' ? { ...b, fields: { ...b.fields, [target.field]: { kind: 'ref', ref: source } } } : b)) }
  if (source.kind === 'step') next = keepReadingOrder(next, source.step, target.step)
  return next
}

/** Clear a field (the data wire into it goes away). */
export function unmapData(recipe: Recipe, target: { step: string; field: string }): Recipe {
  return { ...recipe, blocks: updateBlock(recipe.blocks, target.step, (b) => {
    if (b.kind !== 'step') return b
    const fields = { ...b.fields }
    delete fields[target.field]
    return { ...b, fields }
  }) }
}

/** Delete blocks (with what's inside). Data that used them shows as "Removed step" until fixed. */
export function deleteBlocks(recipe: Recipe, ids: string[]): Recipe {
  let blocks = recipe.blocks
  const gone = new Set<string>()
  for (const id of ids) {
    const found = findBlock(blocks, id)
    if (!found) continue
    gone.add(id)
    if (found.block.kind !== 'step') walk(found.block.blocks, (b) => gone.add(b.id))
    blocks = removeBlock(blocks, id)
  }
  blocks = mapSteps(blocks, (s) => {
    if (!s.after?.some((a) => gone.has(a))) return s
    const after = s.after.filter((a) => !gone.has(a))
    const out: Step = { ...s, after }
    if (!after.length) delete out.after
    return out
  })
  return { ...recipe, blocks }
}

/** A copy of a block right after it: new ids and names; data between copied steps follows the copy. */
export function duplicateBlock(recipe: Recipe, id: string): { recipe: Recipe; id: string } | null {
  const found = findBlock(recipe.blocks, id)
  const at = locate(recipe.blocks, id)
  if (!found || !at) return null
  const taken = stepNames(recipe)
  const ids = new Map<string, string>()
  const copy = (b: Block): Block => {
    const nid = uid(b.kind === 'step' ? 's' : 'c')
    ids.set(b.id, nid)
    if (b.kind === 'step') {
      const name = uniqueName(b.autoName ? slug(`${b.title} copy`) : b.name, taken)
      taken.add(name)
      const s: Step = { ...structuredClone(b), id: nid, name, title: found.block === b ? `${b.title} (copy)` : b.title, undo: [] }
      return s
    }
    return { ...structuredClone(b), id: nid, blocks: b.blocks.map(copy) } as Block
  }
  const made = copy(found.block)
  // Refs and waits between copied blocks point at the copies.
  const remapRef = (r: Ref): Ref => (r.kind === 'step' && ids.has(r.step) ? { ...r, step: ids.get(r.step)! } : r.kind === 'item' && ids.has(r.loop) ? { ...r, loop: ids.get(r.loop)! } : r)
  const holder = mapRecipeRefs({ ...recipe, blocks: [made], returns: [] }, remapRef)
  const fixed = mapSteps(holder.blocks, (s) => (s.after ? { ...s, after: s.after.map((a) => ids.get(a) ?? a) } : s))[0]
  return { recipe: { ...recipe, blocks: insertBlocks(recipe.blocks, at.parent, at.index + 1, [fixed]) }, id: fixed.id }
}

/** Move a block into a container (at its end), or to the top level. */
export function moveInto(recipe: Recipe, id: string, container: string | null): Recipe {
  const found = findBlock(recipe.blocks, id)
  if (!found || id === container) return recipe
  if (container && found.block.kind !== 'step' && findBlock(found.block.blocks, container)) return recipe
  const without = removeBlock(recipe.blocks, id)
  const target = container ? findBlock(without, container)?.block : null
  if (container && (!target || target.kind === 'step')) return recipe
  const index = target && target.kind !== 'step' ? target.blocks.length : without.length
  return { ...recipe, blocks: insertBlocks(without, container, index, [found.block]) }
}

/** Set one field of a step. */
export function setField(recipe: Recipe, step: string, field: string, value: Value): Recipe {
  return { ...recipe, blocks: updateBlock(recipe.blocks, step, (b) => (b.kind === 'step' ? { ...b, fields: { ...b.fields, [field]: value } } : b)) }
}
