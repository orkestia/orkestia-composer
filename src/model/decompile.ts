// Composition definition → recipe, so any saved composition opens in the
// builder. A definition the builder made carries `metadata.recipe` and reopens
// exactly; anything else is read layer by layer: conditions become "Only if"
// blocks, fan-outs "For each", loops "Repeat", compensate steps "undo".
// What the recipe can't express marks the recipe read-only, with the reason.
import type { Catalog, FieldType } from './catalog'
import { humanize, unknownEntry } from './catalog'
import { humanName } from './humanize'
import {
  canonicalJson, SERVER_CONTROLLED,
  type CompositionDefinition, type ConditionOp, type DefinitionCondition, type DefinitionStep, type InputMapping,
} from './definition'
import { FORMAT_TYPE, type RecipeMeta, type TreeNode } from './compile'
import { inferQuestions } from './infer'
import {
  slug, uid,
  type Block, type Condition, type ForEachBlock, type Recipe, type RecipeInput, type Ref, type Step, type UndoStep, type Value,
} from './recipe'

const STEP_KEYS = new Set(['name', 'workflow_type', 'input_mapping', 'condition', 'unrecoverable_on_failure', 'fan_out', 'metadata'])
const LAYER_KEYS = new Set(['name', 'steps', 'compensate', 'loop'])
const DEFINITION_KEYS = new Set(['name', 'description', 'version', 'inputs', 'layers', 'metadata'])
const FIELD_TYPES = new Set<FieldType>(['string', 'text', 'email', 'uuid', 'integer', 'float', 'boolean', 'datetime', 'list', 'dict', 'json'])

export interface DecompileOptions {
  /** Saved definitions of child compositions (multi-step "For each"), by name. */
  children?: Record<string, CompositionDefinition>
}

export function decompile(definition: CompositionDefinition, catalog: Catalog, options: DecompileOptions = {}): Recipe {
  return new Decompiler(definition, catalog, options).run()
}

class Decompiler {
  readonly readOnly: string[] = []
  readonly ids = new Map<string, string>()
  readonly steps = new Map<string, DefinitionStep>()
  readonly layerOf = new Map<string, number>()
  readonly textSteps = new Map<string, DefinitionStep>()
  readonly undo = new Map<string, UndoStep[]>()
  readonly meta: RecipeMeta | null

  constructor(readonly def: CompositionDefinition, readonly catalog: Catalog, readonly options: DecompileOptions) {
    const meta = (def.metadata?.recipe ?? null) as RecipeMeta | null
    this.meta = meta && meta.v === 1 && Array.isArray(meta.tree) ? meta : null
  }

  note(reason: string) {
    if (!this.readOnly.includes(reason)) this.readOnly.push(reason)
  }

  run(): Recipe {
    const layers = Array.isArray(this.def.layers) ? this.def.layers : []
    layers.forEach((layer, li) => {
      for (const key of Object.keys(layer)) if (!LAYER_KEYS.has(key)) this.note(`A stage carries a setting the builder doesn’t edit (${key})`)
      for (const step of layer.steps ?? []) {
        if (isTextStep(step)) { this.textSteps.set(step.name, step); continue }
        this.steps.set(step.name, step)
        this.layerOf.set(step.name, li)
        this.ids.set(step.name, uid('s'))
        for (const key of Object.keys(step)) if (!STEP_KEYS.has(key)) this.note(`Step “${step.name}” has a setting the builder doesn’t edit (${key})`)
      }
    })
    // Undo steps: marked by the builder, or the stage's compensate given to its last step.
    layers.forEach((layer) => {
      for (const comp of layer.compensate ?? []) {
        const marker = builderMeta(comp)
        const owner = typeof marker.undo_of === 'string' && this.steps.has(marker.undo_of)
          ? marker.undo_of
          : layer.steps.filter((s) => !isTextStep(s)).at(-1)?.name
        if (!owner) { this.note('A rollback step has no step to belong to'); continue }
        const list = this.undo.get(owner) ?? []
        list.push({
          id: uid('u'), name: comp.name, title: typeof marker.title === 'string' ? marker.title : this.title(comp),
          workflowType: comp.workflow_type, fields: this.fields(comp.input_mapping),
        })
        this.undo.set(owner, list)
      }
    })

    const inputs = (this.def.inputs ?? []).map((input): RecipeInput => ({
      id: uid('i'),
      name: input.name,
      label: this.meta?.inputs[input.name] ?? humanize(input.name),
      type: FIELD_TYPES.has(input.type as FieldType) ? (input.type as FieldType) : 'json',
      required: input.required ?? false,
      ...(input.description ? { description: input.description } : {}),
      ...(SERVER_CONTROLLED.has(input.name) || input.source?.kind === 'context' ? { hidden: true } : {}),
      ...(input.source ? { source: input.source } : {}),
    }))

    const blocks = this.meta ? this.fromTree(this.meta.tree) : this.fromLayers()
    const placed = new Set<string>()
    const mark = (bs: Block[]) => bs.forEach((b) => (b.kind === 'step' ? placed.add(b.name) : mark(b.blocks)))
    mark(blocks)
    for (const name of this.steps.keys()) {
      if (placed.has(name) || this.consumedByEach.has(name)) continue
      this.note('Some steps were added outside the builder')
      blocks.push(this.step(name))
    }

    this.resolveAfter(blocks)
    const metadata = { ...(this.def.metadata ?? {}) }
    const outputMapping = metadata.output_mapping as Record<string, InputMapping> | undefined
    delete metadata.recipe
    delete metadata.output_mapping
    const title = this.meta?.title ?? humanize(this.def.name)
    const recipe: Recipe = {
      name: this.def.name,
      title,
      description: this.def.description ?? '',
      inputs,
      blocks,
      returns: Object.entries(outputMapping ?? {}).map(([name, mapping]) => ({ id: uid('r'), name, value: this.value(mapping) })),
      runs: this.meta?.runs ?? { mode: 'manual', everyMinutes: 60 },
      readOnly: this.readOnly,
      metadata,
      ...(this.def.version !== undefined ? { version: this.def.version } : {}),
    }
    for (const key of Object.keys(this.def)) if (!DEFINITION_KEYS.has(key)) this.note(`The workflow carries a setting the builder doesn’t edit (${key})`)
    // Read but never declared: questions found in this workflow (a fan-out's item isn't one).
    const items = new Set(layers.flatMap((l) => l.steps.flatMap((s) => (s.fan_out?.as ? [s.fan_out.as] : []))))
    for (const found of inferQuestions(recipe, this.catalog, items)) inputs.push({ ...found, label: this.meta?.inputs[found.name] ?? found.label })
    return recipe
  }

  readonly consumedByEach = new Set<string>()

  // ---- Builder-made: the stored tree ----

  fromTree(tree: TreeNode[]): Block[] {
    const out: Block[] = []
    for (const node of tree) {
      if (typeof node === 'string') {
        if (this.steps.has(node)) out.push(this.step(node))
        continue
      }
      if ('if' in node) {
        out.push({ kind: 'if', id: uid('c'), condition: this.conditionFromMeta(node.if), blocks: this.fromTree(node.items) })
      } else if ('repeat' in node) {
        out.push({
          kind: 'repeat', id: uid('c'), max: node.repeat.max,
          ...(node.repeat.until ? { until: this.conditionFromMeta(node.repeat.until) } : {}),
          blocks: this.fromTree(node.items),
        })
      } else {
        out.push(this.eachFromTree(node))
      }
    }
    return out
  }

  eachFromTree(node: Extract<TreeNode, { each: unknown }>): ForEachBlock {
    const id = uid('c')
    const each = node.each
    const block: ForEachBlock = { kind: 'foreach', id, list: this.refFromMeta(each.list), as: each.as, onError: each.onError, blocks: [] }
    const outer = this.steps.get(each.step)
    if (!each.child) {
      // One step, fanned out: its injected field reads the item.
      const step = this.step(each.step)
      const fan = outer?.fan_out
      if (fan) {
        const raw = outer?.input_mapping?.[fan.as]
        if (raw) step.keep = { ...step.keep, [fan.as]: raw }
        step.fields[fan.as] = { kind: 'ref', ref: { kind: 'item', loop: id, path: fan.item_path ?? '' } }
      }
      block.blocks = [step]
      return block
    }
    this.consumedByEach.add(each.step)
    this.eachIds.set(each.step, id)
    const childDef = this.options.children?.[each.child]
    if (!childDef || !outer) {
      this.note(`The steps repeated for each ${each.as} are saved separately (${each.child}) and weren’t loaded`)
      block.blocks = [this.step(each.step)]
      this.consumedByEach.delete(each.step)
      this.eachIds.delete(each.step)
      return block
    }
    // Rebuild the inner steps from the child, mapping its inputs back to outside data.
    const child = decompile(childDef, this.catalog, this.options)
    for (const reason of child.readOnly) this.note(reason)
    const args = new Map<string, Value>()
    for (const [param, mapping] of Object.entries(outer.input_mapping ?? {})) args.set(param, this.value(mapping))
    const back = (ref: Ref): Ref | Value => {
      if (ref.kind !== 'input') return ref
      if (ref.name === 'item') return { kind: 'item', loop: id, path: ref.path ?? '' }
      const outside = args.get(ref.name)
      if (outside?.kind === 'ref') {
        const r = outside.ref
        const path = [r.path, ref.path].filter(Boolean).join('.')
        if (r.kind === 'input') return { kind: 'input', name: r.name, ...(path ? { path } : {}) }
        return { ...r, path }
      }
      return ref
    }
    block.blocks = rewriteBlocks(child.blocks, back)
    // Inner steps that waited for something outside the loop (kept in this definition's notes).
    const visit = (bs: Block[]) => bs.forEach((b) => {
      if (b.kind !== 'step') return visit(b.blocks)
      const outside = this.meta?.steps[b.name]?.after
      if (outside?.length) this.pendingAfter.set(b, outside)
    })
    visit(block.blocks)
    return block
  }

  // ---- Anything else: layer by layer ----

  fromLayers(): Block[] {
    const out: Block[] = []
    const layers = this.def.layers ?? []
    let lastLayer = -1
    let lastWasAction = false
    layers.forEach((layer, li) => {
      const steps = (layer.steps ?? []).filter((s) => !isTextStep(s))
      const made: Block[] = []
      for (const s of steps) {
        const step = this.step(s.name)
        const action = !(this.catalog.get(s.workflow_type)?.readOnly ?? false)
        if (action && lastWasAction && lastLayer === li) step.alongside = true
        if (action) { lastWasAction = true; lastLayer = li }
        let block: Block = step
        if (s.fan_out) {
          const id = uid('c')
          const raw = s.input_mapping?.[s.fan_out.as]
          if (raw) step.keep = { ...step.keep, [s.fan_out.as]: raw }
          step.fields[s.fan_out.as] = { kind: 'ref', ref: { kind: 'item', loop: id, path: s.fan_out.item_path ?? '' } }
          block = {
            kind: 'foreach', id, list: this.stepRef(s.fan_out.source_step, s.fan_out.source_field),
            as: s.fan_out.as, onError: s.fan_out.on_error === 'continue' ? 'continue' : 'fail', blocks: [step],
          }
        }
        if (s.condition && !layer.loop) block = this.wrapIf(block, s.condition)
        made.push(block)
      }
      if (layer.loop) {
        const inner = steps.map((s, i) => (s.condition ? this.wrapIf(made[i], s.condition) : made[i]))
        out.push({
          kind: 'repeat', id: uid('c'), max: layer.loop.max_iterations,
          ...(layer.loop.break_when ? { until: this.conditionFromDefinition(layer.loop.break_when) } : {}),
          blocks: inner,
        })
        return
      }
      for (const block of made) pushMerging(out, block)
    })
    return out
  }

  wrapIf(block: Block, condition: DefinitionCondition): Block {
    return { kind: 'if', id: uid('c'), condition: this.conditionFromDefinition(condition), blocks: [block] }
  }

  // ---- Pieces ----

  step(name: string): Step {
    const def = this.steps.get(name)!
    const meta = this.meta?.steps[name]
    const title = meta?.title ?? this.title(def)
    const metadata = { ...(def.metadata ?? {}) }
    delete metadata.builder
    const made: Step = {
      kind: 'step', id: this.ids.get(name) ?? uid('s'), name, autoName: !!meta && slug(title) === name, title,
      workflowType: def.workflow_type, fields: this.fields(def.input_mapping),
      undo: this.undo.get(name) ?? [], stopOnFail: !!def.unrecoverable_on_failure, alongside: !!meta?.alongside,
      ...(meta?.after?.length ? { after: [...meta.after] } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    }
    this.ownSteps.add(made)
    return made
  }

  /** Steps this decompiler made (not a child's): their `after` still holds saved names. */
  readonly ownSteps = new WeakSet<Step>()
  /** A multi-step For each's saved step name → its block id. */
  readonly eachIds = new Map<string, string>()
  /** Inner steps of a multi-step For each and the outside steps (saved names) they wait for. */
  readonly pendingAfter = new Map<Step, string[]>()

  /** "Run after" names → block ids, once every block exists. */
  resolveAfter(blocks: Block[]): void {
    for (const b of blocks) {
      if (b.kind !== 'step') { this.resolveAfter(b.blocks); continue }
      const pending = this.pendingAfter.get(b)
      if (pending) {
        const ids = pending.map((n) => this.eachIds.get(n) ?? this.ids.get(n)).filter((id): id is string => !!id)
        if (ids.length) b.after = [...new Set([...(b.after ?? []), ...ids])]
        continue
      }
      if (!b.after || !this.ownSteps.has(b)) continue
      b.after = b.after.map((n) => this.eachIds.get(n) ?? this.ids.get(n)).filter((id): id is string => !!id)
      if (!b.after.length) delete b.after
    }
  }

  title(def: DefinitionStep): string {
    // A step's own name says what it is for here ("read ticket number"); the
    // catalog's title says what kind of step it is ("Read a value"). Prefer the
    // name unless it's a placeholder or just the catalog title again.
    const entry = this.catalog.get(def.workflow_type)
    const named = humanName(def.name)
    const meaningful = /[a-z]{2,}[_\-. ][a-z]{2,}/i.test(def.name) && !/^(step|layer|node|s)[_-]?\d+$/i.test(def.name) && (!entry || slug(entry.title) !== slug(def.name))
    if (meaningful) return named
    if (entry) return entry.title
    return named || unknownEntry(def.workflow_type).title
  }

  fields(mapping: Record<string, InputMapping> | undefined): Record<string, Value> {
    const out: Record<string, Value> = {}
    for (const [param, m] of Object.entries(mapping ?? {})) out[param] = this.value(m)
    return out
  }

  value(mapping: InputMapping): Value {
    switch (mapping.source) {
      case 'static': return { kind: 'literal', value: mapping.value }
      case 'input': return { kind: 'ref', ref: inputRef(mapping.field) }
      case 'step': {
        const text = this.textSteps.get(mapping.step)
        if (text && (mapping.field ?? '') === 'result') return this.textValue(text)
        return { kind: 'ref', ref: this.stepRef(mapping.step, mapping.field ?? '') }
      }
      case 'object': return { kind: 'object', fields: Object.fromEntries(Object.entries(mapping.fields).map(([k, v]) => [k, this.value(v)])) }
      case 'list': return { kind: 'list', items: mapping.items.map((m) => this.value(m)) }
      default:
        this.note('A field uses a data source the builder doesn’t know')
        return { kind: 'literal', value: mapping }
    }
  }

  textValue(step: DefinitionStep): Value {
    const tmpl = step.input_mapping.template
    const template = tmpl?.source === 'static' && typeof tmpl.value === 'string' ? tmpl.value : ''
    const parts: Array<string | Ref> = []
    let buffer = ''
    for (let i = 0; i < template.length; i++) {
      const ch = template[i]
      if ((ch === '{' || ch === '}') && template[i + 1] === ch) { buffer += ch; i++; continue }
      const hole = ch === '{' ? /^\{(\d+)\}/.exec(template.slice(i)) : null
      if (hole) {
        if (buffer) { parts.push(buffer); buffer = '' }
        const value = this.value(step.input_mapping[`arg${hole[1]}`] ?? { source: 'static', value: '' })
        if (value.kind === 'ref') parts.push(value.ref)
        else if (value.kind === 'literal') parts.push(String(value.value ?? ''))
        i += hole[0].length - 1
        continue
      }
      buffer += ch
    }
    if (buffer) parts.push(buffer)
    return { kind: 'text', parts }
  }

  stepRef(name: string, path: string): Ref {
    const id = this.ids.get(name)
    if (!id) this.note(`Uses a step that isn’t in this workflow (${name})`)
    return { kind: 'step', step: id ?? name, path }
  }

  refFromMeta(raw: unknown): Ref | null {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (typeof r.step === 'string') return this.stepRef(r.step, typeof r.path === 'string' ? r.path : '')
    if (r.kind === 'input' && typeof r.name === 'string') return { kind: 'input', name: r.name, ...(typeof r.path === 'string' && r.path ? { path: r.path } : {}) }
    return null
  }

  conditionFromMeta(raw: unknown): Condition {
    const c = (raw ?? {}) as Record<string, unknown>
    if (c.kind === 'not') return { kind: 'not', item: this.conditionFromMeta(c.item) }
    if (c.kind === 'all' || c.kind === 'any') return { kind: c.kind, items: (c.items as unknown[] ?? []).map((i) => this.conditionFromMeta(i)) }
    return { kind: 'compare', left: this.refFromMeta(c.left), op: (c.op as ConditionOp | undefined) ?? 'truthy', ...('value' in c ? { value: c.value } : {}) }
  }

  conditionFromDefinition(cond: DefinitionCondition): Condition {
    if ('all_of' in cond) return { kind: 'all', items: cond.all_of.map((c) => this.conditionFromDefinition(c)) }
    if ('any_of' in cond) return { kind: 'any', items: cond.any_of.map((c) => this.conditionFromDefinition(c)) }
    if ('not' in cond) return { kind: 'not', item: this.conditionFromDefinition(cond.not) }
    const left = cond.step ? this.stepRef(cond.step, cond.field) : inputRef(cond.field)
    return { kind: 'compare', left, op: cond.op, ...(cond.value !== undefined ? { value: cond.value } : {}) }
  }
}

function inputRef(field: string): Ref {
  const [name, ...rest] = field.split('.')
  return { kind: 'input', name, ...(rest.length ? { path: rest.join('.') } : {}) }
}

function isTextStep(step: DefinitionStep): boolean {
  return step.workflow_type === FORMAT_TYPE && builderMeta(step).text === true
}

function builderMeta(step: DefinitionStep): Record<string, unknown> {
  const b = step.metadata?.builder
  return b && typeof b === 'object' ? (b as Record<string, unknown>) : {}
}

/** Consecutive steps under the same condition share one "Only if". */
function pushMerging(out: Block[], block: Block) {
  const last = out.at(-1)
  if (block.kind === 'if' && last?.kind === 'if' && canonicalJson(last.condition) === canonicalJson(block.condition)) {
    last.blocks.push(...block.blocks)
    return
  }
  out.push(block)
}


function rewriteBlocks(blocks: Block[], back: (ref: Ref) => Ref | Value): Block[] {
  const ref = (r: Ref): Value => {
    const v = back(r)
    return 'kind' in v && (v.kind === 'input' || v.kind === 'step' || v.kind === 'item') ? { kind: 'ref', ref: v as Ref } : (v as Value)
  }
  const value = (v: Value): Value => {
    switch (v.kind) {
      case 'ref': return ref(v.ref)
      case 'text': return { kind: 'text', parts: v.parts.map((p) => { if (typeof p === 'string') return p; const r = ref(p); return r.kind === 'ref' ? r.ref : '' }) }
      case 'object': return { kind: 'object', fields: Object.fromEntries(Object.entries(v.fields).map(([k, x]) => [k, value(x)])) }
      case 'list': return { kind: 'list', items: v.items.map(value) }
      default: return v
    }
  }
  const cond = (c: Condition): Condition => {
    if (c.kind === 'compare') { const l = c.left ? ref(c.left) : null; return { ...c, left: l?.kind === 'ref' ? l.ref : null } }
    if (c.kind === 'not') return { kind: 'not', item: cond(c.item) }
    return { kind: c.kind, items: c.items.map(cond) }
  }
  return blocks.map((b): Block => {
    if (b.kind === 'step') return { ...b, fields: Object.fromEntries(Object.entries(b.fields).map(([k, v]) => [k, value(v)])), undo: b.undo.map((u) => ({ ...u, fields: Object.fromEntries(Object.entries(u.fields).map(([k, v]) => [k, value(v)])) })) }
    if (b.kind === 'if') return { ...b, condition: cond(b.condition), blocks: rewriteBlocks(b.blocks, back) }
    if (b.kind === 'repeat') return { ...b, ...(b.until ? { until: cond(b.until) } : {}), blocks: rewriteBlocks(b.blocks, back) }
    const list = b.list ? ref(b.list) : null
    return { ...b, list: list?.kind === 'ref' ? list.ref : null, blocks: rewriteBlocks(b.blocks, back) }
  })
}
