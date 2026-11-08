// The recipe: how a person describes a workflow — steps read top to bottom,
// data passed as chips, and a few wrapping blocks (only if / for each /
// repeat). Layers, mapping sources and step names are the compiler's business
// (compile.ts), never the person's.
import type { ConditionOp } from './definition'
import type { FieldType } from './catalog'

/** A piece of data a field can use. */
export type Ref =
  /** A "Starts with" answer; `path` reads inside it. */
  | { kind: 'input'; name: string; path?: string }
  /** An earlier step's result; `path` '' is the whole result. */
  | { kind: 'step'; step: string; path: string }
  /** The current item of an enclosing "For each". */
  | { kind: 'item'; loop: string; path: string }

export type Value =
  | { kind: 'empty' }
  | { kind: 'literal'; value: unknown }
  | { kind: 'ref'; ref: Ref }
  /** Words and chips mixed: "Approve order {Order › number}?" */
  | { kind: 'text'; parts: Array<string | Ref> }
  | { kind: 'object'; fields: Record<string, Value> }
  | { kind: 'list'; items: Value[] }

export type Condition =
  | { kind: 'compare'; left: Ref | null; op: ConditionOp; value?: unknown }
  | { kind: 'all' | 'any'; items: Condition[] }
  | { kind: 'not'; item: Condition }

export interface UndoStep {
  id: string
  name: string
  title: string
  workflowType: string
  fields: Record<string, Value>
}

export interface Step {
  kind: 'step'
  id: string
  /** Machine name in the saved definition; follows the title while `autoName`. */
  name: string
  autoName: boolean
  title: string
  workflowType: string
  fields: Record<string, Value>
  /** Rollback run if a later step fails (`compensate`). */
  undo: UndoStep[]
  /** A failure ends the run for good instead of rolling back (`unrecoverable_on_failure`). */
  stopOnFail: boolean
  /** Runs at the same time as the previous action instead of after it. */
  alongside: boolean
  /**
   * Steps (ids) this one waits for even though it uses none of their data —
   * drawn as a wire on the diagram ("run after"). Saved in metadata.recipe.
   */
  after?: string[]
  /** Kept verbatim from an opened definition. */
  metadata?: Record<string, unknown>
  /** Raw mappings kept verbatim (e.g. a fan-out field's placeholder value). */
  keep?: Record<string, import('./definition').InputMapping>
}

export interface IfBlock { kind: 'if'; id: string; condition: Condition; blocks: Block[] }
export interface ForEachBlock { kind: 'foreach'; id: string; list: Ref | null; as: string; onError: 'fail' | 'continue'; blocks: Block[] }
export interface RepeatBlock { kind: 'repeat'; id: string; max: number; until?: Condition; blocks: Block[] }
export type Block = Step | IfBlock | ForEachBlock | RepeatBlock
export type Container = IfBlock | ForEachBlock | RepeatBlock

export interface RecipeInput {
  id: string
  name: string
  label: string
  type: FieldType
  required: boolean
  description?: string
  /** Filled by the platform (organization, signed-in person): kept, never shown as a question. */
  hidden?: boolean
  /** Made here and not saved yet: its name follows the label. */
  autoName?: boolean
  /** Read by the workflow but never declared (inferred on open); the next save declares it. */
  found?: boolean
  source?: Record<string, unknown>
}

export interface ReturnValue { id: string; name: string; value: Value }

export type RunMode = 'manual' | 'app' | 'schedule'

export interface Recipe {
  /** Lineage name: what `composition.save` versions by. */
  name: string
  title: string
  description: string
  inputs: RecipeInput[]
  blocks: Block[]
  returns: ReturnValue[]
  /**
   * How it starts; `answers` are what a scheduled run passes for "Starts with".
   * A schedule runs every `everyMinutes`, or by `cron` (five fields) read in
   * `timezone` (an IANA name; UTC when absent) when `cron` is set.
   */
  runs: { mode: RunMode; everyMinutes: number; answers?: Record<string, unknown>; cron?: string; timezone?: string }
  /** Why this recipe can't be edited safely (opened from a definition the model can't express). */
  readOnly: string[]
  /** Definition metadata kept as is. */
  metadata: Record<string, unknown>
  /** The definition's own version label (`version`), kept as is. */
  version?: string | number
}

let counter = 0
export function uid(prefix = 'b'): string {
  counter += 1
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** "Find the customer!" → "find_the_customer". */
export function slug(text: string, fallback = 'step'): string {
  const s = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
  return s || fallback
}

export const EMPTY: Value = { kind: 'empty' }

export function newStep(workflowType: string, title: string, taken: Set<string>): Step {
  return {
    kind: 'step', id: uid('s'), name: uniqueName(slug(title), taken), autoName: true, title, workflowType,
    fields: {}, undo: [], stopOnFail: false, alongside: false,
  }
}

export function uniqueName(base: string, taken: Set<string>, separator = '_'): string {
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}${separator}${i}`
  return name
}

/** Longest lineage slug an app backend accepts (the platform's `SLUG_MAX_LENGTH`). */
export const LINEAGE_SLUG_MAX = 64

/**
 * A lineage name an app backend accepts: lowercase `a-z0-9` words joined by single
 * hyphens, at most {@link LINEAGE_SLUG_MAX} characters (the platform's `is_valid_slug`).
 */
export function lineageSlug(text: string, fallback = 'workflow', max = LINEAGE_SLUG_MAX): string {
  const s = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '')
  return s || fallback
}

/** {@link uniqueName} for lineage slugs: `name-2`, `name-3`, … and still within {@link LINEAGE_SLUG_MAX}. */
export function uniqueLineageSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const suffix = `-${i}`
    const name = `${lineageSlug(base, 'workflow', LINEAGE_SLUG_MAX - suffix.length)}${suffix}`
    if (!taken.has(name)) return name
  }
}

export function emptyRecipe(title = 'Untitled workflow'): Recipe {
  return {
    name: slug(title, 'workflow').replace(/_/g, '-'), title, description: '',
    inputs: [], blocks: [], returns: [], runs: { mode: 'manual', everyMinutes: 60 }, readOnly: [], metadata: {},
  }
}

// ---- Walking ----

export interface Scope {
  /** Enclosing blocks, outermost first. */
  parents: Container[]
}

export function walk(blocks: Block[], visit: (block: Block, scope: Scope) => void, scope: Scope = { parents: [] }): void {
  for (const block of blocks) {
    visit(block, scope)
    if (block.kind !== 'step') walk(block.blocks, visit, { parents: [...scope.parents, block] })
  }
}

/** Every step in reading order. */
export function allSteps(blocks: Block[]): Step[] {
  const out: Step[] = []
  walk(blocks, (b) => { if (b.kind === 'step') out.push(b) })
  return out
}

export function findBlock(blocks: Block[], id: string): { block: Block; scope: Scope } | null {
  let found: { block: Block; scope: Scope } | null = null
  walk(blocks, (block, scope) => { if (!found && block.id === id) found = { block, scope } })
  return found
}

export function stepNames(recipe: Recipe): Set<string> {
  const names = new Set<string>()
  for (const s of allSteps(recipe.blocks)) {
    names.add(s.name)
    for (const u of s.undo) names.add(u.name)
  }
  return names
}

/** Refs inside a value, in order. */
export function refsOf(value: Value | undefined): Ref[] {
  if (!value) return []
  switch (value.kind) {
    case 'ref': return [value.ref]
    case 'text': return value.parts.filter((p): p is Ref => typeof p !== 'string')
    case 'object': return Object.values(value.fields).flatMap(refsOf)
    case 'list': return value.items.flatMap(refsOf)
    default: return []
  }
}

export function conditionRefs(condition: Condition | undefined): Ref[] {
  if (!condition) return []
  if (condition.kind === 'compare') return condition.left ? [condition.left] : []
  if (condition.kind === 'not') return conditionRefs(condition.item)
  return condition.items.flatMap(conditionRefs)
}

export function sameRef(a: Ref, b: Ref): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'input' && b.kind === 'input') return a.name === b.name && (a.path ?? '') === (b.path ?? '')
  if (a.kind === 'step' && b.kind === 'step') return a.step === b.step && a.path === b.path
  if (a.kind === 'item' && b.kind === 'item') return a.loop === b.loop && a.path === b.path
  return false
}

// ---- Immutable edits ----

/** Every data reference in the recipe passed through `fn`. */
export function mapRecipeRefs(recipe: Recipe, fn: (ref: Ref) => Ref): Recipe {
  const value = (v: Value): Value => {
    switch (v.kind) {
      case 'ref': return { kind: 'ref', ref: fn(v.ref) }
      case 'text': return { kind: 'text', parts: v.parts.map((p) => (typeof p === 'string' ? p : fn(p))) }
      case 'object': return { kind: 'object', fields: Object.fromEntries(Object.entries(v.fields).map(([k, x]) => [k, value(x)])) }
      case 'list': return { kind: 'list', items: v.items.map(value) }
      default: return v
    }
  }
  const fields = (f: Record<string, Value>) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, value(v)]))
  const cond = (c: Condition): Condition => {
    if (c.kind === 'compare') return { ...c, left: c.left ? fn(c.left) : null }
    if (c.kind === 'not') return { kind: 'not', item: cond(c.item) }
    return { kind: c.kind, items: c.items.map(cond) }
  }
  const blocks = (bs: Block[]): Block[] => bs.map((b): Block => {
    if (b.kind === 'step') return { ...b, fields: fields(b.fields), undo: b.undo.map((u) => ({ ...u, fields: fields(u.fields) })) }
    if (b.kind === 'if') return { ...b, condition: cond(b.condition), blocks: blocks(b.blocks) }
    if (b.kind === 'repeat') return { ...b, ...(b.until ? { until: cond(b.until) } : {}), blocks: blocks(b.blocks) }
    return { ...b, list: b.list ? fn(b.list) : null, blocks: blocks(b.blocks) }
  })
  return { ...recipe, blocks: blocks(recipe.blocks), returns: recipe.returns.map((r) => ({ ...r, value: value(r.value) })) }
}

/** Rename a "Starts with" answer and everything that uses it. */
export function renameInput(recipe: Recipe, from: string, to: string): Recipe {
  const renamed = mapRecipeRefs(recipe, (ref) => (ref.kind === 'input' && ref.name === from ? { ...ref, name: to } : ref))
  return { ...renamed, inputs: renamed.inputs.map((i) => (i.name === from ? { ...i, name: to } : i)) }
}

/** Replace a block (by id) anywhere in the tree. */
export function updateBlock(blocks: Block[], id: string, change: (block: Block) => Block | null): Block[] {
  const out: Block[] = []
  for (const block of blocks) {
    if (block.id === id) {
      const next = change(block)
      if (next) out.push(next)
      continue
    }
    out.push(block.kind === 'step' ? block : { ...block, blocks: updateBlock(block.blocks, id, change) })
  }
  return out
}

/** Insert blocks into `parent` (null = top level) at `index`. */
export function insertBlocks(blocks: Block[], parent: string | null, index: number, items: Block[]): Block[] {
  if (parent === null) return [...blocks.slice(0, index), ...items, ...blocks.slice(index)]
  return blocks.map((block) => {
    if (block.kind === 'step') return block
    if (block.id === parent) return { ...block, blocks: [...block.blocks.slice(0, index), ...items, ...block.blocks.slice(index)] }
    return { ...block, blocks: insertBlocks(block.blocks, parent, index, items) }
  })
}

export function removeBlock(blocks: Block[], id: string): Block[] {
  return updateBlock(blocks, id, () => null)
}

/** Every step passed through `fn` (containers keep their shape). */
export function mapSteps(blocks: Block[], fn: (step: Step) => Step): Block[] {
  return blocks.map((b) => (b.kind === 'step' ? fn(b) : { ...b, blocks: mapSteps(b.blocks, fn) }))
}

/** Where a block sits: its parent container id (null = top) and index. */
export function locate(blocks: Block[], id: string, parent: string | null = null): { parent: string | null; index: number } | null {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.id === id) return { parent, index: i }
    if (block.kind !== 'step') {
      const inner = locate(block.blocks, id, block.id)
      if (inner) return inner
    }
  }
  return null
}

/** Move a block up/down among its siblings. */
export function moveBlock(blocks: Block[], id: string, delta: -1 | 1): Block[] {
  const at = locate(blocks, id)
  if (!at) return blocks
  const found = findBlock(blocks, id)
  if (!found) return blocks
  const siblings = at.parent === null ? blocks : (findBlock(blocks, at.parent)?.block as Container).blocks
  const target = at.index + delta
  if (target < 0 || target >= siblings.length) return blocks
  const without = removeBlock(blocks, id)
  return insertBlocks(without, at.parent, target, [found.block])
}
