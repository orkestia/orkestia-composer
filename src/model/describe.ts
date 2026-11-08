// A recipe as plain text for the assistant: the steps in order, where each
// field's value comes from, and the wrapping blocks. Includes unsaved edits,
// so the assistant can answer about what is on screen without a tool call.
import type { Catalog } from './catalog'
import { describeRef } from './data'
import type { Block, Condition, Recipe, Value } from './recipe'

const OPS: Record<string, string> = {
  eq: 'is', ne: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains', not_contains: 'does not contain',
  in: 'is one of', not_in: 'is none of', truthy: 'is filled in', falsy: 'is empty', regex: 'matches',
}

export function describeRecipe(recipe: Recipe, catalog: Catalog, limit = 8000): string {
  const label = (v: Value): string => {
    switch (v.kind) {
      case 'empty': return '(empty)'
      case 'literal': return JSON.stringify(v.value)
      case 'ref': return `{${describeRef(recipe, catalog, v.ref).label}}`
      case 'text': return JSON.stringify(v.parts.map((p) => (typeof p === 'string' ? p : `{${describeRef(recipe, catalog, p).label}}`)).join(''))
      case 'object': return `{ ${Object.entries(v.fields).map(([k, x]) => `${k}: ${label(x)}`).join(', ')} }`
      case 'list': return `[ ${v.items.map(label).join(', ')} ]`
    }
  }
  const cond = (c: Condition): string => {
    if (c.kind === 'compare') return `${c.left ? describeRef(recipe, catalog, c.left).label : '?'} ${OPS[c.op] ?? c.op}${c.op === 'truthy' || c.op === 'falsy' ? '' : ` ${JSON.stringify(c.value)}`}`
    if (c.kind === 'not') return `not (${cond(c.item)})`
    return c.items.map(cond).join(c.kind === 'all' ? ' and ' : ' or ')
  }
  const lines: string[] = []
  let n = 0
  const walk = (blocks: Block[], indent: string) => {
    for (const b of blocks) {
      if (b.kind === 'step') {
        n += 1
        const fields = Object.entries(b.fields).filter(([, v]) => v.kind !== 'empty').map(([k, v]) => `${k} ← ${label(v)}`)
        const flags = [b.stopOnFail ? 'stops everything if it fails' : '', b.alongside ? 'runs alongside the previous step' : '', b.undo.length ? `undo: ${b.undo.map((u) => u.title).join(', ')}` : ''].filter(Boolean)
        lines.push(`${indent}${n}. ${b.title} [${b.workflowType}, step name ${b.name}]${fields.length ? ` — ${fields.join('; ')}` : ''}${flags.length ? ` (${flags.join('; ')})` : ''}`)
      } else if (b.kind === 'if') {
        lines.push(`${indent}Only if ${cond(b.condition)}:`)
        walk(b.blocks, `${indent}  `)
      } else if (b.kind === 'foreach') {
        lines.push(`${indent}For each ${b.as} in ${b.list ? describeRef(recipe, catalog, b.list).label : '?'}${b.onError === 'continue' ? ' (skip ones that fail)' : ''}:`)
        walk(b.blocks, `${indent}  `)
      } else {
        lines.push(`${indent}Repeat up to ${b.max} times${b.until ? `, stop when ${cond(b.until)}` : ''}:`)
        walk(b.blocks, `${indent}  `)
      }
    }
  }
  const asked = recipe.inputs.filter((i) => !i.hidden)
  if (asked.length) lines.push(`Starts with: ${asked.map((i) => `${i.label || i.name} (${i.name}, ${i.type}${i.required ? ', required' : ''}${i.found ? ', found in this workflow: used but not declared yet' : ''})`).join('; ')}`)
  lines.push(`Runs: ${recipe.runs.mode === 'schedule' ? (typeof recipe.runs.cron === 'string' ? `on the schedule '${recipe.runs.cron.trim()}' (${recipe.runs.timezone || 'UTC'})` : `every ${recipe.runs.everyMinutes} minutes`) : recipe.runs.mode === 'app' ? 'from an app' : 'when started'}`)
  lines.push('Steps:')
  walk(recipe.blocks, '  ')
  if (!recipe.blocks.length) lines.push('  (none yet)')
  if (recipe.returns.length) lines.push(`Returns: ${recipe.returns.map((r) => `${r.name} ← ${label(r.value)}`).join('; ')}`)
  const text = lines.join('\n')
  return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text
}
