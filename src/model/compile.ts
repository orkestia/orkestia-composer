// Recipe → composition definition (the authoring dialect `composition.save`
// takes). The person never sees what this produces unless they open "JSON".
//
// Ordering rules, the part people never have to think about:
//  - a step runs after every step whose data it uses (chips) or whose result
//    its "Only if" reads;
//  - actions (steps that change something) keep the order they were written
//    in, unless marked "at the same time as the previous step";
//  - lookups (read-only steps) run as early as their data allows.
// Layers are then the longest-path levels of that graph (layering.ts).
import type { Catalog, CatalogEntry, FieldType } from './catalog'
import { unknownEntry } from './catalog'
import {
  canonicalJson,
  type CompositionDefinition, type DefinitionCondition, type DefinitionInput, type DefinitionLayer,
  type DefinitionStep, type FanOut, type InputMapping, UNARY_OPS,
} from './definition'
import { assignLayers, CycleError, findCycle, type LayerRecord } from './layering'
import {
  allSteps, lineageSlug, refsOf, sameRef, slug, uniqueLineageSlug, uniqueName, walk,
  type Block, type Condition, type ForEachBlock, type Recipe, type RecipeInput, type Ref, type Step, type Value,
} from './recipe'

export const FORMAT_TYPE = 'control.value.format'
export const MAX_TEXT_CHIPS = 8

export interface CompileProblem { blockId?: string; field?: string; message: string }

export interface CompiledChild { name: string; definition: CompositionDefinition; recipe: Recipe }

export interface CompileResult {
  definition: CompositionDefinition
  /** Compositions a multi-step "For each" needs, saved before this one. */
  children: CompiledChild[]
  problems: CompileProblem[]
  /** Run order for people: each round's step titles (runs together). */
  rounds: Array<{ titles: string[]; ids: string[]; repeat?: number }>
  /** Saved step name → the recipe block it stands for (steps, For each, undo and text helpers). */
  owners: Record<string, string>
  /**
   * What waits for what, between recipe blocks (step ids, or a multi-step For
   * each's id): every reason a step runs after another — data, conditions,
   * the order actions were written in, explicit "run after". The diagram's wires.
   */
  deps: Array<{ from: string; to: string }>
}

interface Rec extends LayerRecord {
  step: DefinitionStep
  compensate: DefinitionStep[]
  title: string
  /** The recipe block this record stands for (a step, or a For each). */
  owner: string
}

interface Ctx {
  conds: DefinitionCondition[]
  /** "For each" blocks around the current step, outermost first. */
  loops: string[]
  groupId?: string
  loop?: { max_iterations: number; break_when?: DefinitionCondition }
}

/** What metadata.recipe stores so a saved definition reopens exactly as built. */
export type TreeNode =
  | string
  | { if: unknown; items: TreeNode[] }
  | { each: { list: unknown; as: string; onError: 'fail' | 'continue'; step: string; child?: string }; items: TreeNode[] }
  | { repeat: { max: number; until?: unknown }; items: TreeNode[] }

export interface RecipeMeta {
  v: 1
  title: string
  inputs: Record<string, string>
  steps: Record<string, { title: string; alongside?: boolean; after?: string[] }>
  tree: TreeNode[]
  runs: Recipe['runs']
}

export interface CompileOptions {
  /** Declare the questions found in this workflow (`found`) as inputs. Default true; false saves them as they were (undeclared). */
  declareFound?: boolean
  /**
   * How a For each child composition is named. `engine` (default): `<parent>--each-<as>`, what
   * member saves have always used, so recompiling keeps an existing child's lineage. `slug`: a
   * name the app backend's publish accepts (`<parent>-each-<as>`, single hyphens, ≤64 chars).
   */
  childNames?: 'engine' | 'slug'
}

export function compile(recipe: Recipe, catalog: Catalog, options: CompileOptions = {}): CompileResult {
  if (options.declareFound === false) recipe = { ...recipe, inputs: recipe.inputs.filter((i) => !i.found) }
  const c = new Compiler(recipe, catalog, options)
  return c.run()
}

class Compiler {
  readonly problems: CompileProblem[] = []
  readonly records: Rec[] = []
  readonly children: CompiledChild[] = []
  readonly names = new Map<string, string>()
  readonly taken = new Set<string>()
  readonly groups = new Map<string, { name: string; loop: Ctx['loop'] }>()
  /** For each block → the saved step that runs it (its results are a list). */
  readonly loopStep = new Map<string, string>()
  /** Step → the For each blocks around it, outermost first. */
  readonly loopsOf = new Map<string, string[]>()
  readonly meta: RecipeMeta
  seq = 0
  /** Dependencies between the blocks of per-item children (their steps keep their recipe ids). */
  readonly childDeps: Array<{ from: string; to: string }> = []
  /** Actions the next action waits for, and what the last row of actions waited for. */
  lastActions: string[] = []
  actionBase: string[] = []

  constructor(readonly recipe: Recipe, readonly catalog: Catalog, readonly options: CompileOptions = {}) {
    this.meta = {
      v: 1, title: recipe.title, inputs: {}, steps: {}, tree: [], runs: recipe.runs,
    }
    for (const step of allSteps(recipe.blocks)) {
      const name = this.taken.has(step.name) ? uniqueName(step.name, this.taken) : step.name
      if (name !== step.name) this.problems.push({ blockId: step.id, message: `Two steps share the name "${step.name}"` })
      this.taken.add(name)
      this.names.set(step.id, name)
      for (const undo of step.undo) this.taken.add(undo.name)
    }
    walk(recipe.blocks, (block, scope) => {
      const loops = scope.parents.filter((p) => p.kind === 'foreach').map((p) => p.id)
      if (block.kind === 'step') this.loopsOf.set(block.id, loops)
      if (block.kind !== 'foreach') return
      const single = singleStepFanOut(block)
      if (single) { this.loopStep.set(block.id, this.names.get(single.step.id) ?? single.step.name); return }
      const name = uniqueName(`each_${slug(block.as || 'item')}`, this.taken)
      this.taken.add(name)
      this.loopStep.set(block.id, name)
    })
  }

  entry(type: string): CatalogEntry {
    return this.catalog.get(type) ?? unknownEntry(type)
  }

  run(): CompileResult {
    for (const input of this.recipe.inputs) this.meta.inputs[input.name] = input.label
    this.meta.tree = this.blocks(this.recipe.blocks, { conds: [], loops: [] })

    const outputMapping: Record<string, InputMapping> = {}
    for (const ret of this.recipe.returns) {
      if (!ret.name.trim()) continue
      const mapping = this.mapValue(ret.value, { conds: [], loops: [] }, `returns__${slug(ret.name)}`, ret.id, new Set())
      if (mapping) outputMapping[ret.name] = mapping
    }

    let ordered
    try {
      ordered = assignLayers(this.records)
    } catch (error) {
      // Say which steps wait on each other, on each of them (the diagram marks those boxes).
      const loop = error instanceof CycleError ? findCycle(this.records) : null
      if (loop?.length) {
        const byName = new Map(this.records.map((r) => [r.name, r]))
        const titles = loop.map((n) => byName.get(n)?.title ?? n)
        const message = `These steps wait on each other: ${[...titles, titles[0]].join(' → ')}`
        for (const owner of new Set(loop.map((n) => byName.get(n)?.owner).filter((o): o is string => !!o))) this.problems.push({ blockId: owner, message })
      } else this.problems.push({ message: error instanceof CycleError ? error.message : String(error) })
      ordered = this.records.map((r, i) => ({ level: i, groupId: r.groupId, steps: [r] }))
    }

    const layers: DefinitionLayer[] = ordered.map((layer, i) => {
      const group = layer.groupId ? this.groups.get(layer.groupId) : undefined
      const out: DefinitionLayer = { name: group?.name ?? `layer_${i + 1}`, steps: layer.steps.map((r) => r.step) }
      const compensate = layer.steps.flatMap((r) => r.compensate)
      if (compensate.length) out.compensate = compensate
      if (group?.loop) out.loop = group.loop
      return out
    })
    const rounds = ordered.map((layer) => ({
      titles: layer.steps.map((r) => r.title),
      ids: [...new Set(layer.steps.map((r) => r.owner))],
      ...(layer.groupId ? { repeat: this.groups.get(layer.groupId)?.loop?.max_iterations } : {}),
    }))

    const definition: CompositionDefinition = { name: this.recipe.name, layers }
    if (this.recipe.description.trim()) definition.description = this.recipe.description.trim()
    if (this.recipe.version !== undefined) definition.version = this.recipe.version
    const inputs = this.recipe.inputs.map(toDefinitionInput)
    if (inputs.length) definition.inputs = inputs
    const metadata: Record<string, unknown> = { ...this.recipe.metadata, recipe: this.meta }
    delete metadata.output_mapping
    if (Object.keys(outputMapping).length) metadata.output_mapping = outputMapping
    definition.metadata = metadata
    const owners: Record<string, string> = {}
    for (const r of this.records) {
      owners[r.name] = r.owner
      for (const c of r.compensate) owners[c.name] = r.owner
    }
    const bySeq = new Map(this.records.map((r) => [r.name, r]))
    const seen = new Set<string>()
    const deps: CompileResult['deps'] = []
    const push = (from: string, to: string) => {
      const k = `${from}>${to}`
      if (from === to || seen.has(k)) return
      seen.add(k)
      deps.push({ from, to })
    }
    for (const r of this.records) {
      for (const d of r.deps) {
        const dep = bySeq.get(d)
        // Inside a Repeat a later member's value is the previous round's: not an ordering edge.
        if (!dep || (r.groupId && dep.groupId === r.groupId && dep.seq > r.seq)) continue
        push(dep.owner, r.owner)
      }
    }
    for (const d of this.childDeps) push(d.from, d.to)
    return { definition, children: this.children, problems: this.problems, rounds, owners, deps }
  }

  // ---- Blocks ----

  blocks(blocks: Block[], ctx: Ctx): TreeNode[] {
    const tree: TreeNode[] = []
    for (const block of blocks) {
      if (block.kind === 'step') {
        this.step(block, ctx)
        tree.push(this.names.get(block.id) ?? block.name)
      } else if (block.kind === 'if') {
        const cond = this.condition(block.condition, block.id)
        const items = this.blocks(block.blocks, cond ? { ...ctx, conds: [...ctx.conds, cond] } : ctx)
        tree.push({ if: this.conditionMeta(block.condition), items })
      } else if (block.kind === 'repeat') {
        if (ctx.groupId) {
          this.problems.push({ blockId: block.id, message: 'A Repeat can’t be inside another Repeat' })
          tree.push(...this.blocks(block.blocks, ctx))
          continue
        }
        const loop = { max_iterations: block.max, ...(block.until ? { break_when: this.condition(block.until, block.id) ?? undefined } : {}) }
        if (!loop.break_when) delete loop.break_when
        const name = uniqueName(`repeat_${this.groups.size + 1}`, new Set([...this.groups.values()].map((g) => g.name)))
        this.groups.set(block.id, { name, loop })
        // The whole repeat follows the actions before it; its own actions run together each round.
        const base = this.lastActions
        const before = this.records.length
        const items = this.blocks(block.blocks, { ...ctx, groupId: block.id, loop })
        const members = this.records.slice(before).filter((r) => r.groupId === block.id)
        const actions = members.filter((r) => !this.entry(r.step.workflow_type).readOnly).map((r) => r.name)
        for (const r of members) for (const d of base) r.deps.add(d)
        if (actions.length) { this.actionBase = base; this.lastActions = actions }
        tree.push({ repeat: { max: block.max, ...(block.until ? { until: this.conditionMeta(block.until) } : {}) }, items })
      } else {
        tree.push(this.forEach(block, ctx))
      }
    }
    return tree
  }

  step(step: Step, ctx: Ctx, extra?: { fanOut?: FanOut; skipFields?: Set<string> }): Rec {
    const name = this.names.get(step.id) ?? step.name
    const entry = this.entry(step.workflowType)
    const deps = new Set<string>()
    const mapping: Record<string, InputMapping> = {}
    for (const [param, raw] of Object.entries(step.keep ?? {})) mapping[param] = raw
    for (const [param, value] of Object.entries(step.fields)) {
      if (extra?.skipFields?.has(param)) continue
      const m = this.mapValue(value, ctx, `${name}__${slug(param)}`, step.id, deps, param)
      if (m) mapping[param] = m
    }
    for (const cond of ctx.conds) for (const d of conditionStepNames(cond)) deps.add(d)
    const afterNames: string[] = []
    for (const id of step.after ?? []) {
      const names = this.afterNames(id, ctx)
      if (!names) { this.problems.push({ blockId: step.id, message: 'Waits for a step that no longer exists' }); continue }
      for (const n of names) { deps.add(n); if (!afterNames.includes(n)) afterNames.push(n) }
    }
    const out: DefinitionStep = { name, workflow_type: step.workflowType, input_mapping: mapping }
    const condition = combine(ctx.conds)
    if (condition) out.condition = condition
    if (step.stopOnFail) out.unrecoverable_on_failure = true
    if (extra?.fanOut) { out.fan_out = extra.fanOut; deps.add(extra.fanOut.source_step) }
    if (step.metadata && Object.keys(step.metadata).length) out.metadata = step.metadata

    if (!entry.readOnly && !ctx.groupId) {
      if (step.alongside) {
        for (const d of this.actionBase) deps.add(d)
        this.lastActions = [...this.lastActions, name]
      } else {
        for (const d of this.lastActions) deps.add(d)
        this.actionBase = this.lastActions
        this.lastActions = [name]
      }
    }

    const compensate = step.undo.map((undo) => {
      const undoMapping: Record<string, InputMapping> = {}
      for (const [param, value] of Object.entries(undo.fields)) {
        const m = this.mapValue(value, ctx, `${undo.name}__${slug(param)}`, step.id, new Set(), param, true)
        if (m) undoMapping[param] = m
      }
      return { name: undo.name, workflow_type: undo.workflowType, input_mapping: undoMapping, metadata: { builder: { undo_of: name, title: undo.title } } }
    })

    const owner = step.id.endsWith(':each') ? step.id.slice(0, -':each'.length) : step.id
    const rec: Rec = { name, deps, seq: this.seq++, groupId: ctx.groupId, step: out, compensate, title: step.title, owner }
    this.records.push(rec)
    const afterMeta = (step.after ?? []).map((id) => this.names.get(id)).filter((n): n is string => !!n)
    this.meta.steps[name] = { title: step.title, ...(step.alongside ? { alongside: true } : {}), ...(afterMeta.length ? { after: afterMeta } : {}) }
    return rec
  }

  /** The saved steps an explicit "run after" on block `id` waits for; null when it's gone. */
  afterNames(id: string, ctx: Ctx): string[] | null {
    const found = findIn(this.recipe.blocks, id)
    if (!found) return null
    if (found.kind === 'step') {
      const outside = (this.loopsOf.get(id) ?? []).find((loop) => !ctx.loops.includes(loop))
      if (outside) return [this.loopStep.get(outside)!]
      const name = this.names.get(id)
      return name ? [name] : null
    }
    if (found.kind === 'foreach' && !ctx.loops.includes(found.id)) return [this.loopStep.get(found.id)!]
    return [...new Set(found.blocks.flatMap((b) => this.afterNames(b.id, ctx) ?? []))]
  }

  forEach(block: ForEachBlock, ctx: Ctx): TreeNode {
    const list = block.list
    const as = block.as.trim() || 'item'
    if (!list || list.kind !== 'step') {
      this.problems.push({ blockId: block.id, message: list ? 'For each needs a list made by an earlier step' : 'Pick the list to go through' })
    }
    if (ctx.groupId) this.problems.push({ blockId: block.id, message: 'A For each can’t be inside a Repeat' })
    const source = list?.kind === 'step' ? { source_step: this.names.get(list.step) ?? list.step, source_field: list.path } : null
    if (source && !source.source_field) this.problems.push({ blockId: block.id, message: 'Pick which list inside that result to go through' })

    const single = singleStepFanOut(block)
    if (single) {
      const step = single.step
      const fanOut: FanOut = {
        source_step: source?.source_step ?? '', source_field: source?.source_field ?? '', as: single.param ?? slug(as),
        ...(single.path ? { item_path: single.path } : {}),
        ...(block.onError === 'continue' ? { on_error: 'continue' as const } : {}),
      }
      this.step(step, { ...ctx, loops: [...ctx.loops, block.id] }, { fanOut, skipFields: single.param ? new Set([single.param]) : undefined })
      const name = this.names.get(step.id) ?? step.name
      return { each: { list: list ? this.refMeta(list) : null, as, onError: block.onError, step: name }, items: [name] }
    }

    // Several steps per item: they become their own composition, run once per item.
    const siblings = new Set(this.children.map((c) => c.name))
    const childName = this.options.childNames === 'slug'
      ? uniqueLineageSlug(lineageSlug(`${this.recipe.name}-each-${as}`), siblings)
      : uniqueName(`${this.recipe.name}--each-${slug(as)}`.replace(/_/g, '-'), siblings)
    const { recipe: child, args } = childRecipe(this.recipe, block, childName)
    const compiled = compile(child, this.catalog, { childNames: this.options.childNames })
    this.childDeps.push(...compiled.deps)
    this.children.push(...compiled.children, { name: childName, definition: compiled.definition, recipe: child })
    for (const p of compiled.problems) this.problems.push({ ...p, blockId: p.blockId ?? block.id })

    const outer: Step = {
      kind: 'step', id: `${block.id}:each`, name: this.loopStep.get(block.id) ?? `each_${slug(as)}`, autoName: false,
      title: `For each ${as}`, workflowType: `virtual.${childName}@latest`, fields: {}, undo: [], stopOnFail: false, alongside: false,
      metadata: { builder: { each: childName } },
    }
    this.names.set(outer.id, outer.name)
    for (const [inputName, ref] of args) outer.fields[inputName] = { kind: 'ref', ref }
    // Inner steps that wait for something outside: the per-item run waits for it.
    const inner = new Set(allSteps(block.blocks).map((s) => s.id))
    const outsideAfter = [...new Set(allSteps(block.blocks).flatMap((s) => (s.after ?? []).filter((id) => !inner.has(id) && !containsBlock(block, id))))]
    if (outsideAfter.length) outer.after = outsideAfter
    // Which inner step waited for what outside, so it reopens on that step.
    for (const s of allSteps(block.blocks)) {
      const outside = (s.after ?? []).filter((id) => !inner.has(id) && !containsBlock(block, id)).map((id) => this.names.get(id) ?? this.loopStep.get(id)).filter((n): n is string => !!n)
      const name = this.names.get(s.id)
      if (outside.length && name) this.meta.steps[name] = { ...(this.meta.steps[name] ?? { title: s.title }), after: outside }
    }
    const fanOut: FanOut = {
      source_step: source?.source_step ?? '', source_field: source?.source_field ?? '', as: 'item',
      ...(block.onError === 'continue' ? { on_error: 'continue' as const } : {}),
    }
    // Reads only when every inner step does: then it may run as early as its data allows.
    const innerReadOnly = allSteps(block.blocks).every((s) => this.entry(s.workflowType).readOnly)
    const rec = this.step(outer, ctx, { fanOut })
    if (innerReadOnly) this.unorder(rec)
    return { each: { list: list ? this.refMeta(list) : null, as, onError: block.onError, step: outer.name, child: childName }, items: compiled.definition.metadata ? (compiled.definition.metadata.recipe as RecipeMeta).tree : [] }
  }

  /** Undo the action ordering for a record that turned out to only read. */
  unorder(rec: Rec): void {
    this.lastActions = this.actionBase
    for (const d of this.actionBase) rec.deps.delete(d)
  }

  // ---- Values ----

  mapValue(value: Value, ctx: Ctx, textName: string, blockId: string, deps: Set<string>, field?: string, compensating = false): InputMapping | undefined {
    switch (value.kind) {
      case 'empty': return undefined
      case 'literal': return { source: 'static', value: value.value }
      case 'ref': return this.mapRef(value.ref, ctx, deps, blockId, field)
      case 'object': {
        const fields: Record<string, InputMapping> = {}
        for (const [k, v] of Object.entries(value.fields)) {
          const m = this.mapValue(v, ctx, `${textName}_${slug(k)}`, blockId, deps, field, compensating)
          if (m) fields[k] = m
        }
        return Object.values(fields).every((m) => m.source === 'static')
          ? { source: 'static', value: Object.fromEntries(Object.entries(fields).map(([k, m]) => [k, (m as { value?: unknown }).value])) }
          : { source: 'object', fields }
      }
      case 'list': {
        const items = value.items.map((v, i) => this.mapValue(v, ctx, `${textName}_${i + 1}`, blockId, deps, field, compensating) ?? { source: 'static' as const, value: null })
        return items.every((m) => m.source === 'static')
          ? { source: 'static', value: items.map((m) => (m as { value?: unknown }).value) }
          : { source: 'list', items }
      }
      case 'text': {
        const refs = value.parts.filter((p): p is Ref => typeof p !== 'string')
        if (!refs.length) return { source: 'static', value: value.parts.join('') }
        if (refs.length === 1 && value.parts.length === 1) return this.mapRef(refs[0], ctx, deps, blockId, field)
        if (refs.length > MAX_TEXT_CHIPS) {
          this.problems.push({ blockId, field, message: `Text can mix in at most ${MAX_TEXT_CHIPS} pieces of data` })
        }
        // A hidden "format text" step builds the string; the field reads its result.
        const name = uniqueName(textName, this.taken)
        this.taken.add(name)
        const textDeps = new Set<string>()
        let template = ''
        const mapping: Record<string, InputMapping> = {}
        let i = 0
        for (const part of value.parts) {
          if (typeof part === 'string') { template += part.replace(/[{}]/g, (b) => b + b); continue }
          const m = this.mapRef(part, ctx, textDeps, blockId, field)
          if (m && i < MAX_TEXT_CHIPS) mapping[`arg${i}`] = m
          template += `{${i}}`
          i++
        }
        const step: DefinitionStep = {
          name, workflow_type: FORMAT_TYPE,
          input_mapping: { template: { source: 'static', value: template }, ...mapping },
          metadata: { builder: { text: true } },
        }
        const condition = combine(ctx.conds)
        if (condition) step.condition = condition
        for (const cond of ctx.conds) for (const d of conditionStepNames(cond)) textDeps.add(d)
        if (compensating) {
          this.problems.push({ blockId, field, message: 'An undo step can’t mix words and data; use a single piece of data' })
          return { source: 'static', value: template }
        }
        const ownerTitle = allSteps(this.recipe.blocks).find((s) => s.id === blockId)?.title
        this.records.push({ name, deps: textDeps, seq: this.seq++, groupId: ctx.groupId, step, compensate: [], title: ownerTitle ? `Write the text for “${ownerTitle}”` : 'Write the returned text', owner: blockId })
        deps.add(name)
        return { source: 'step', step: name, field: 'result' }
      }
    }
  }

  mapRef(ref: Ref, ctx: Ctx, deps: Set<string>, blockId?: string, field?: string): InputMapping | undefined {
    if (ref.kind === 'input') return { source: 'input', field: ref.path ? `${ref.name}.${ref.path}` : ref.name }
    if (ref.kind === 'step') {
      // From outside a For each, a step inside it means the list of every round's result.
      const outside = (this.loopsOf.get(ref.step) ?? []).find((loop) => !ctx.loops.includes(loop))
      if (outside) {
        const list = this.loopStep.get(outside)!
        deps.add(list)
        return { source: 'step', step: list, field: '' }
      }
      const name = this.names.get(ref.step)
      if (!name) {
        this.problems.push({ blockId, field, message: 'Uses a step that no longer exists' })
        return undefined
      }
      deps.add(name)
      return { source: 'step', step: name, field: ref.path }
    }
    this.problems.push({ blockId, field, message: 'The current item can only be used inside its For each' })
    return undefined
  }

  // ---- Conditions ----

  condition(condition: Condition, blockId: string): DefinitionCondition | null {
    if (condition.kind === 'compare') {
      const left = condition.left
      if (!left) { this.problems.push({ blockId, message: 'Finish the condition: pick what to check' }); return null }
      let leaf: DefinitionCondition
      if (left.kind === 'input') leaf = { field: left.path ? `${left.name}.${left.path}` : left.name, op: condition.op }
      else if (left.kind === 'step') {
        const step = this.names.get(left.step)
        if (!step) { this.problems.push({ blockId, message: 'The condition uses a step that no longer exists' }); return null }
        leaf = { step, field: left.path, op: condition.op }
      } else {
        this.problems.push({ blockId, message: 'A condition can’t check the current item of a For each' })
        return null
      }
      if (!UNARY_OPS.has(condition.op)) leaf.value = condition.value
      return leaf
    }
    if (condition.kind === 'not') {
      const inner = this.condition(condition.item, blockId)
      return inner ? { not: inner } : null
    }
    const items = condition.items.map((c) => this.condition(c, blockId)).filter((c): c is DefinitionCondition => !!c)
    if (!items.length) return null
    if (items.length === 1) return items[0]
    return condition.kind === 'all' ? { all_of: items } : { any_of: items }
  }

  refMeta(ref: Ref): unknown {
    if (ref.kind === 'step') return { step: this.names.get(ref.step) ?? ref.step, path: ref.path }
    return ref
  }

  conditionMeta(condition: Condition): unknown {
    if (condition.kind === 'compare') return { ...condition, left: condition.left ? this.refMeta(condition.left) : null }
    if (condition.kind === 'not') return { kind: 'not', item: this.conditionMeta(condition.item) }
    return { kind: condition.kind, items: condition.items.map((c) => this.conditionMeta(c)) }
  }
}

function findIn(blocks: Block[], id: string): Block | null {
  for (const b of blocks) {
    if (b.id === id) return b
    if (b.kind !== 'step') { const inner = findIn(b.blocks, id); if (inner) return inner }
  }
  return null
}

function containsBlock(block: Block, id: string): boolean {
  return block.kind !== 'step' && !!findIn(block.blocks, id)
}

function combine(conds: DefinitionCondition[]): DefinitionCondition | undefined {
  if (!conds.length) return undefined
  return conds.length === 1 ? conds[0] : { all_of: conds }
}

export function conditionStepNames(cond: DefinitionCondition): string[] {
  if ('all_of' in cond) return cond.all_of.flatMap(conditionStepNames)
  if ('any_of' in cond) return cond.any_of.flatMap(conditionStepNames)
  if ('not' in cond) return conditionStepNames(cond.not)
  return cond.step ? [cond.step] : []
}

function toDefinitionInput(input: RecipeInput): DefinitionInput {
  const out: DefinitionInput = { name: input.name, type: input.type === 'text' ? 'string' : input.type, required: input.required }
  if (input.description) out.description = input.description
  if (input.source) out.source = input.source
  return out
}

/**
 * A For each over ONE step whose item feeds exactly one field whole: that is
 * the engine's own fan-out (the item is injected under that field's name).
 */
function singleStepFanOut(block: ForEachBlock): { step: Step; param?: string; path?: string } | null {
  if (block.blocks.length !== 1 || block.blocks[0].kind !== 'step') return null
  const step = block.blocks[0]
  const own = (r: Ref) => r.kind === 'item' && r.loop === block.id
  let param: string | undefined
  let path: string | undefined
  for (const [field, value] of Object.entries(step.fields)) {
    const refs = refsOf(value).filter(own)
    if (!refs.length) continue
    if (param !== undefined || value.kind !== 'ref') return null
    param = field
    path = (value.ref as Extract<Ref, { kind: 'item' }>).path || undefined
  }
  if (step.undo.some((u) => Object.values(u.fields).some((v) => refsOf(v).some(own)))) return null
  return { step, param, path }
}

/**
 * The steps of a multi-step For each as their own recipe. Data from outside
 * becomes the child's inputs (passed by the outer step), the item becomes
 * input `item`.
 */
export function childRecipe(parent: Recipe, block: ForEachBlock, childName: string): { recipe: Recipe; args: Array<[string, Ref]> } {
  const inner = new Set(allSteps(block.blocks).map((s) => s.id))
  const args: Array<[string, Ref]> = []
  const inputs: RecipeInput[] = [{ id: 'item', name: 'item', label: block.as || 'Item', type: 'json', required: true }]
  const parentInputs = new Map(parent.inputs.map((i) => [i.name, i]))
  const parentSteps = new Map(allSteps(parent.blocks).map((s) => [s.id, s]))
  const taken = new Set(['item'])

  const rewrite = (ref: Ref): Ref => {
    if (ref.kind === 'item' && ref.loop === block.id) return { kind: 'input', name: 'item', ...(ref.path ? { path: ref.path } : {}) }
    if (ref.kind === 'step' && inner.has(ref.step)) return ref
    // Outside data: pass the whole input/result in once, read the path inside.
    const whole: Ref = ref.kind === 'input' ? { kind: 'input', name: ref.name } : ref.kind === 'step' ? { kind: 'step', step: ref.step, path: '' } : { kind: 'item', loop: ref.loop, path: '' }
    let entry = args.find(([, r]) => sameRef(r, whole))
    if (!entry) {
      const base = ref.kind === 'input' ? ref.name : ref.kind === 'step' ? (parentSteps.get(ref.step)?.name ?? 'value') : 'parent_item'
      const name = uniqueName(slug(base), taken)
      taken.add(name)
      entry = [name, whole]
      args.push(entry)
      const label = ref.kind === 'input' ? (parentInputs.get(ref.name)?.label ?? ref.name) : ref.kind === 'step' ? (parentSteps.get(ref.step)?.title ?? name) : 'Outer item'
      const type: FieldType = ref.kind === 'input' ? (parentInputs.get(ref.name)?.type ?? 'json') : 'json'
      inputs.push({ id: name, name, label, type, required: false })
    }
    return { kind: 'input', name: entry[0], ...(ref.path ? { path: ref.path } : {}) }
  }

  const mapRefs = (value: Value): Value => {
    switch (value.kind) {
      case 'ref': return { kind: 'ref', ref: rewrite(value.ref) }
      case 'text': return { kind: 'text', parts: value.parts.map((p) => (typeof p === 'string' ? p : rewrite(p))) }
      case 'object': return { kind: 'object', fields: Object.fromEntries(Object.entries(value.fields).map(([k, v]) => [k, mapRefs(v)])) }
      case 'list': return { kind: 'list', items: value.items.map(mapRefs) }
      default: return value
    }
  }
  const mapCondition = (c: Condition): Condition => {
    if (c.kind === 'compare') return { ...c, left: c.left ? rewrite(c.left) : null }
    if (c.kind === 'not') return { kind: 'not', item: mapCondition(c.item) }
    return { kind: c.kind, items: c.items.map(mapCondition) }
  }
  const mapBlocks = (blocks: Block[]): Block[] => blocks.map((b): Block => {
    if (b.kind === 'step') {
      const after = (b.after ?? []).filter((id) => containsBlock(block, id))
      return {
        ...b,
        ...(b.after ? { after } : {}),
        fields: Object.fromEntries(Object.entries(b.fields).map(([k, v]) => [k, mapRefs(v)])),
        undo: b.undo.map((u) => ({ ...u, fields: Object.fromEntries(Object.entries(u.fields).map(([k, v]) => [k, mapRefs(v)])) })),
      }
    }
    if (b.kind === 'if') return { ...b, condition: mapCondition(b.condition), blocks: mapBlocks(b.blocks) }
    if (b.kind === 'repeat') return { ...b, ...(b.until ? { until: mapCondition(b.until) } : {}), blocks: mapBlocks(b.blocks) }
    return { ...b, list: b.list ? rewrite(b.list) : null, blocks: mapBlocks(b.blocks) }
  })

  const blocks = mapBlocks(block.blocks)
  return {
    recipe: {
      name: childName, title: `${parent.title} — each ${block.as || 'item'}`, description: `Runs once per ${block.as || 'item'} for “${parent.title}”.`,
      inputs, blocks, returns: [], runs: { mode: 'manual', everyMinutes: 60 }, readOnly: [], metadata: { builder: { each_of: parent.name } },
    },
    args,
  }
}

/** Stable text for change detection. */
export function definitionKey(definition: CompositionDefinition): string {
  return canonicalJson(definition)
}
