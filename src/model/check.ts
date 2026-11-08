// Problems in plain words, pinned to the step or block they belong to. Local
// checks only: the platform's own validation (composition.validate) joins in
// once the builder is wired to it.
import type { Catalog, FieldType } from './catalog'
import { compatible, fieldLabel, unknownEntry } from './catalog'
import { SERVER_CONTROLLED } from './definition'
import { availableData, describeRef, loopsAround } from './data'
import { compile, MAX_TEXT_CHIPS } from './compile'
import {
  allSteps, conditionRefs, refsOf, sameRef, walk,
  type Block, type Condition, type Recipe, type Ref, type Value,
} from './recipe'

export type Severity = 'error' | 'warning' | 'note'

/** A one-click repair the platform suggested: read `field` of step `at` from `producer`'s `path`. */
export interface Fix { at: string; field: string; producer: string; path: string; label: string }

export interface Problem {
  /** Step or block id; absent for the whole workflow. */
  at?: string
  /** Field name on a step, when the problem is one field. */
  field?: string
  severity: Severity
  message: string
  fix?: Fix
  /** Found by the platform's validation rather than here. */
  source?: 'platform'
}

export function check(recipe: Recipe, catalog: Catalog): Problem[] {
  const problems: Problem[] = []
  const add = (p: Problem) => { if (!problems.some((q) => q.at === p.at && q.field === p.field && q.message === p.message)) problems.push(p) }

  if (!recipe.title.trim()) add({ severity: 'error', message: 'Give the workflow a name' })
  if (!recipe.blocks.length) add({ severity: 'note', message: 'Add a first step' })
  const names = recipe.inputs.map((i) => i.name)
  for (const input of recipe.inputs) {
    if (!input.hidden && !input.label.trim()) add({ severity: 'error', message: 'A “Starts with” question has no name' })
    if (names.filter((n) => n === input.name).length > 1) add({ severity: 'error', message: `Two questions are called “${input.label}”` })
  }

  const usable = (at: string | null, ref: Ref) => availableData(recipe, catalog, at).some((o) => sameRef(o.ref, ref))
  const order = new Map<string, number>()
  let n = 0
  walk(recipe.blocks, (b) => { order.set(b.id, n++) })
  /** `step` is written before block `at` (null = the end) and isn't `at` itself. */
  const comesBefore = (step: string, at: string | null) => {
    const s = order.get(step)
    if (s === undefined) return false
    if (at === null || !order.has(at)) return true
    const a = order.get(at)!
    return s < a
  }
  const checkRef = (at: string, ref: Ref, field: string | undefined, want: FieldType | undefined) => {
    const d = describeRef(recipe, catalog, ref)
    if (d.missing) {
      add({ at, field, severity: 'error', message: ref.kind === 'input' ? `Uses “${d.label}”, a question that was removed` : 'Uses a step that was removed' })
      return
    }
    // Answers exist from the start; a step result exists once that step has run.
    if (ref.kind === 'step' && !comesBefore(ref.step, at)) {
      add({ at, field, severity: 'error', message: `Uses “${d.label}”, which comes later` })
      return
    }
    // The item exists anywhere inside its own For each, whatever path inside it is read.
    if (ref.kind === 'item' && !loopsAround(recipe.blocks, at).some((l) => l.id === ref.loop) && !usable(at, ref)) {
      add({ at, field, severity: 'error', message: `“${d.label}” only exists inside its For each` })
      return
    }
    if (ref.kind === 'step' && ref.path) {
      const producer = allSteps(recipe.blocks).find((s) => s.id === ref.step)
      const outputs = producer ? catalog.get(producer.workflowType)?.outputs : undefined
      const head = ref.path.split('.')[0]
      if (outputs?.length && !outputs.some((o) => o.name === head)) {
        add({ at, field, severity: 'note', message: `“${head}” isn’t among the listed results of “${producer!.title}”` })
      }
    }
    const option = availableData(recipe, catalog, at).find((o) => sameRef(o.ref, ref))
    const have = option?.type ?? d.type
    if (want && !compatible(have, want)) {
      add({ at, field, severity: 'warning', message: `“${d.label}” is ${article(have)}, but ${field ? fieldLabel(field).toLowerCase() : 'this'} needs ${article(want)}` })
    }
  }

  walk(recipe.blocks, (block, scope) => {
    const inIf = scope.parents.filter((p) => p.kind === 'if')
    if (block.kind === 'step') {
      const entry = catalog.get(block.workflowType)
      if (!entry && (catalog.isMissing?.(block.workflowType) ?? true)) add({ at: block.id, severity: 'note', message: 'Not in the catalog, so its fields can’t be checked' })
      const spec = entry ?? unknownEntry(block.workflowType)
      const ownLoopItem = (scope.parents.filter((p) => p.kind === 'foreach').at(-1)) ?? null
      for (const f of spec.inputs) {
        if (!f.required || f.automatic || SERVER_CONTROLLED.has(f.name)) continue
        const v = block.fields[f.name]
        if (!v || v.kind === 'empty' || (v.kind === 'literal' && (v.value === '' || v.value === null || v.value === undefined))) {
          // A one-step For each fills this field with the item.
          if (ownLoopItem && block.fields[f.name]?.kind === 'ref') continue
          add({ at: block.id, field: f.name, severity: 'error', message: `${fieldLabel(f.name)} needs a value` })
        }
      }
      for (const [field, value] of Object.entries(block.fields)) {
        const spec2 = spec.inputs.find((f) => f.name === field)
        checkValue(block.id, field, value, spec2?.type)
      }
      for (const undo of block.undo) {
        for (const [field, value] of Object.entries(undo.fields)) checkValue(block.id, field, value, undefined)
      }
      // Results from inside a For each are a list of every round; with several steps per round, each entry is that round's whole result.
      for (const ref of Object.values(block.fields).flatMap(refsOf)) {
        if (ref.kind !== 'step') continue
        let loop: Block | null = null
        walk(recipe.blocks, (b, s) => {
          if (b.id !== ref.step) return
          loop = [...s.parents].reverse().find((p) => p.kind === 'foreach' && !scope.parents.some((q) => q.id === p.id)) ?? null
        })
        const l = loop as Block | null
        if (l && l.kind === 'foreach') {
          const several = allSteps(l.blocks).length > 1
          add({ at: block.id, severity: 'warning', message: several
            ? `Gets a list with every round’s full result of “For each ${l.as}”, not just “${describeRef(recipe, catalog, ref).label}”`
            : `Gets a list: one “${describeRef(recipe, catalog, ref).label.split(' › ')[0]}” result per ${l.as}` })
        }
      }
      // Data from inside an "Only if" the step isn't in may be empty.
      for (const ref of Object.values(block.fields).flatMap(refsOf)) {
        if (ref.kind !== 'step') continue
        let target: { parents: string[] } | null = null
        walk(recipe.blocks, (b, s) => { if (b.id === ref.step) target = { parents: s.parents.filter((p) => p.kind === 'if').map((p) => p.id) } })
        const t = target as { parents: string[] } | null
        if (t && t.parents.some((id) => !inIf.some((p) => p.id === id))) {
          add({ at: block.id, severity: 'warning', message: `Uses “${describeRef(recipe, catalog, ref).label}”, which only runs under a condition — it may be empty` })
        }
      }
    } else if (block.kind === 'if') {
      if (!block.blocks.length) add({ at: block.id, severity: 'warning', message: 'Nothing happens under this condition yet' })
      checkCondition(block.id, block.condition)
    } else if (block.kind === 'foreach') {
      if (!block.blocks.length) add({ at: block.id, severity: 'error', message: 'Add the steps to repeat for each item' })
      if (!block.list) add({ at: block.id, severity: 'error', message: 'Pick the list to go through' })
      else if (block.list.kind !== 'step') add({ at: block.id, severity: 'error', message: 'Go through a list made by an earlier step' })
      else checkRef(block.id, block.list, undefined, 'list')
      if (scope.parents.some((p) => p.kind === 'repeat')) add({ at: block.id, severity: 'error', message: 'A For each can’t be inside a Repeat' })
    } else {
      if (!block.blocks.length) add({ at: block.id, severity: 'error', message: 'Add the steps to repeat' })
      if (!(block.max >= 1 && block.max <= 100)) add({ at: block.id, severity: 'error', message: 'Repeat between 1 and 100 times' })
      if (scope.parents.some((p) => p.kind === 'repeat')) add({ at: block.id, severity: 'error', message: 'A Repeat can’t be inside another Repeat' })
      if (block.until) checkCondition(block.id, block.until)
    }
  })

  const seenReturns = new Set<string>()
  for (const ret of recipe.returns) {
    if (!ret.name.trim()) add({ at: ret.id, severity: 'error', message: 'A returned value has no name' })
    else if (seenReturns.has(ret.name)) add({ at: ret.id, severity: 'error', message: `“${ret.name}” is returned twice` })
    seenReturns.add(ret.name)
    for (const ref of refsOf(ret.value)) checkRef(ret.id, ref, undefined, undefined)
  }

  for (const p of compile(recipe, catalog).problems) {
    if (!problems.some((q) => q.at === p.blockId && q.message === p.message)) add({ at: p.blockId, field: p.field, severity: 'error', message: p.message })
  }
  return problems

  function checkValue(at: string, field: string, value: Value, want: FieldType | undefined) {
    if (value.kind === 'text') {
      const refs = value.parts.filter((p): p is Ref => typeof p !== 'string')
      if (refs.length > 1 || value.parts.length > 1) {
        if (want && !compatible('string', want)) add({ at, field, severity: 'error', message: `${fieldLabel(field)} can’t mix words and data — pick one piece of data` })
        if (refs.length > MAX_TEXT_CHIPS) add({ at, field, severity: 'error', message: `Use at most ${MAX_TEXT_CHIPS} pieces of data in one text` })
      }
      for (const ref of refs) checkRef(at, ref, field, refs.length === 1 && value.parts.length === 1 ? want : undefined)
      return
    }
    if (value.kind === 'ref') return checkRef(at, value.ref, field, want)
    for (const ref of refsOf(value)) checkRef(at, ref, field, undefined)
  }

  function checkCondition(at: string, condition: Condition) {
    const refs = conditionRefs(condition)
    const leaves: Condition[] = []
    const collect = (c: Condition): void => { if (c.kind === 'compare') leaves.push(c); else if (c.kind === 'not') collect(c.item); else c.items.forEach(collect) }
    collect(condition)
    if (leaves.some((c) => c.kind === 'compare' && !c.left)) add({ at, severity: 'error', message: 'Finish the condition: pick what to check' })
    for (const ref of refs) {
      if (ref.kind === 'item') add({ at, severity: 'error', message: 'A condition can’t check the current item of a For each' })
      else checkRef(at, ref, undefined, undefined)
    }
  }
}

function article(type: FieldType): string {
  const words: Record<FieldType, string> = {
    string: 'text', text: 'text', email: 'an email address', uuid: 'an ID', integer: 'a number', float: 'a number',
    boolean: 'yes/no', datetime: 'a date', list: 'a list', dict: 'a record', json: 'any value',
  }
  return words[type]
}
