import { describe, expect, it } from 'vitest'
import { sampleCatalog } from './__fixtures__/sampleCatalog'
import { confirmBigOrders } from './__fixtures__/samples'
import { check } from './check'
import { compile } from './compile'
import { canonicalJson, type CompositionDefinition } from './definition'
import { decompile } from './decompile'
import {
  addStep, connect, deleteBlocks, dependencies, disconnect, duplicateBlock, insertBetween, mapData, moveInto, parallelize, readingOrder, rewire, sequence, unmapData,
} from './edit'
import { buildDiagram, paintedEdges, INPUTS, RETURNS } from './graph'
import { History } from './history'
import { allSteps, emptyRecipe, findBlock, uid, type Recipe, type Step } from './recipe'

const cat = sampleCatalog

/** Layer index of each saved step name. */
function layers(recipe: Recipe): Map<string, number> {
  const out = new Map<string, number>()
  compile(recipe, cat).definition.layers.forEach((l, i) => l.steps.forEach((s) => out.set(s.name, i)))
  return out
}
const step = (r: Recipe, id: string) => findBlock(r.blocks, id)!.block as Step
const nameOf = (r: Recipe, id: string) => step(r, id).name

/** A workflow built from scratch on the diagram: two lookups, then two actions. */
function scratch(): Recipe {
  let r = emptyRecipe('Welcome a customer')
  r.inputs = [
    { id: 'i_org', name: 'organization_uuid', label: 'Organization', type: 'uuid', required: true, hidden: true },
    { id: 'i_email', name: 'customer_email', label: 'Customer email', type: 'email', required: true },
  ]
  const a = addStep(r, { type: 'shop.customer.find', title: 'Find the customer' }, { parent: null, index: 0 }); r = a.recipe
  const b = addStep(r, { type: 'shop.order.list', title: 'List orders' }, { parent: null, index: 1 }); r = b.recipe
  const c = addStep(r, { type: 'slack.message.send', title: 'Tell the team' }, { parent: null, index: 2 }); r = c.recipe
  const d = addStep(r, { type: 'aws.ses.send_email', title: 'Email the customer' }, { parent: null, index: 3 }); r = d.recipe
  r = mapData(r, { kind: 'input', name: 'customer_email' }, { step: a.id, field: 'email' })
  r = mapData(r, { kind: 'step', step: a.id, path: 'email' }, { step: d.id, field: 'to' })
  return Object.assign(r, { ids: { find: a.id, list: b.id, tell: c.id, email: d.id } }) as Recipe & { ids: Record<string, string> }
}

describe('diagram edits: insert between', () => {
  it('puts a new action between two actions, in order', () => {
    const r = confirmBigOrders()
    const { recipe, id } = insertBetween(r, cat, { type: 'slack.message.send', title: 'Tell the team' }, 's_confirm', 's_email')
    const at = layers(recipe)
    expect(at.get('confirm_the_order')!).toBeLessThan(at.get(nameOf(recipe, id))!)
    expect(at.get(nameOf(recipe, id))!).toBeLessThan(at.get('email_the_customer')!)
    const order = readingOrder(recipe)
    expect(order.get('s_confirm')!).toBeLessThan(order.get(id)!)
    expect(order.get(id)!).toBeLessThan(order.get('s_email')!)
    // Action order already holds: no explicit wire needed.
    expect(step(recipe, id).after).toBeUndefined()
  })

  it('keeps a lookup between its neighbours with explicit waits', () => {
    const r = confirmBigOrders()
    const { recipe, id } = insertBetween(r, cat, { type: 'shop.order.list', title: 'List orders' }, 's_confirm', 's_email')
    expect(step(recipe, id).after).toEqual(['s_confirm'])
    expect(step(recipe, 's_email').after).toEqual([id])
    const at = layers(recipe)
    expect(at.get('confirm_the_order')!).toBeLessThan(at.get(nameOf(recipe, id))!)
    expect(at.get(nameOf(recipe, id))!).toBeLessThan(at.get('email_the_customer')!)
    expect(compile(recipe, cat).problems).toEqual([])
  })

  it('inserts at the start and at the end', () => {
    const r = scratch() as Recipe & { ids: Record<string, string> }
    const first = insertBetween(r, cat, { type: 'control.time.now', title: 'Get the current time' }, null, r.ids.find)
    expect(first.recipe.blocks[0].id).toBe(first.id)
    const last = insertBetween(r, cat, { type: 'ticket.open', title: 'Open a ticket' }, r.ids.email, null)
    expect(last.recipe.blocks.at(-1)!.id).toBe(last.id)
    expect(dependencies(last.recipe, cat)).toContainEqual({ from: r.ids.email, to: last.id })
  })
})

describe('diagram edits: connect and rewire', () => {
  it('drawing a wire makes the target run after the source and reads in that order', () => {
    const r = confirmBigOrders()
    const next = connect(r, cat, 's_confirm', 's_customer')
    expect(step(next, 's_customer').after).toEqual(['s_confirm'])
    const order = readingOrder(next)
    expect(order.get('s_customer')!).toBeGreaterThan(order.get('s_confirm')!)
    const at = layers(next)
    expect(at.get('find_the_customer')!).toBeGreaterThan(at.get('confirm_the_order')!)
  })

  it('a wire that already holds adds nothing', () => {
    const r = confirmBigOrders()
    expect(connect(r, cat, 's_order', 's_confirm')).toBe(r)
  })

  it('rewiring moves the wait to the new source', () => {
    const r = scratch() as Recipe & { ids: Record<string, string> }
    const wired = connect(r, cat, r.ids.list, r.ids.find)
    expect(step(wired, r.ids.find).after).toEqual([r.ids.list])
    const { recipe } = rewire(wired, cat, { from: r.ids.list, to: r.ids.find }, { from: r.ids.tell, to: r.ids.find })
    expect(step(recipe, r.ids.find).after).toEqual([r.ids.tell])
    const deps = dependencies(recipe, cat)
    expect(deps).toContainEqual({ from: r.ids.tell, to: r.ids.find })
    expect(deps).not.toContainEqual({ from: r.ids.list, to: r.ids.find })
  })

  it('cutting the wire between two actions lets them run together', () => {
    const r = confirmBigOrders()
    const { recipe, kept } = disconnect(r, cat, 's_confirm', 's_email')
    expect(kept).toBeNull()
    expect(step(recipe, 's_email').alongside).toBe(true)
    const at = layers(recipe)
    expect(at.get('email_the_customer')).toBe(at.get('confirm_the_order'))
  })

  it('a wire made by data stays, and says why', () => {
    const r = confirmBigOrders()
    const { recipe, kept } = disconnect(r, cat, 's_customer', 's_email')
    expect(kept).toBe('data')
    expect(dependencies(recipe, cat)).toContainEqual({ from: 's_customer', to: 's_email' })
  })

  it('a loop is shown on the canvas, not refused', () => {
    const r = scratch() as Recipe & { ids: Record<string, string> }
    const a = connect(r, cat, r.ids.find, r.ids.list)
    const loop = connect(a, cat, r.ids.list, r.ids.find)
    const problems = compile(loop, cat).problems.filter((p) => /wait on each other/.test(p.message))
    // Pinned to the two steps in the loop, named in plain words.
    expect(problems.map((p) => p.blockId).sort()).toEqual([r.ids.find, r.ids.list].sort())
    expect(problems[0].message).toMatch(/Find the customer|List orders/)
    expect(check(loop, cat).some((p) => p.severity === 'error' && /wait on each other/.test(p.message))).toBe(true)
  })
})

describe('diagram edits: parallelize and sequence', () => {
  it('runs two actions at the same time', () => {
    const r = confirmBigOrders()
    const { recipe, blocked } = parallelize(r, cat, ['s_email', 's_confirm'])
    expect(blocked).toEqual([])
    const at = layers(recipe)
    expect(at.get('email_the_customer')).toBe(at.get('confirm_the_order'))
    expect(step(recipe, 's_email').alongside).toBe(true)
    expect(step(recipe, 's_confirm').alongside).toBe(false)
  })

  it('reports steps that use each other’s data', () => {
    const r = confirmBigOrders()
    const { blocked } = parallelize(r, cat, ['s_customer', 's_email'])
    expect(blocked).toEqual(['s_email'])
  })

  it('puts two lookups one after the other', () => {
    const r = confirmBigOrders()
    expect(layers(r).get('find_the_customer')).toBe(layers(r).get('get_the_order'))
    const next = sequence(r, cat, ['s_order', 's_customer'])
    const at = layers(next)
    expect(at.get('get_the_order')!).toBeGreaterThan(at.get('find_the_customer')!)
  })
})

describe('diagram edits: data mapping', () => {
  it('drags an output into an input', () => {
    const r = scratch() as Recipe & { ids: Record<string, string> }
    const next = mapData(r, { kind: 'step', step: r.ids.find, path: 'name' }, { step: r.ids.tell, field: 'text' })
    expect(step(next, r.ids.tell).fields.text).toEqual({ kind: 'ref', ref: { kind: 'step', step: r.ids.find, path: 'name' } })
    const def = compile(next, cat).definition
    const tell = def.layers.flatMap((l) => l.steps).find((s) => s.name === nameOf(next, r.ids.tell))!
    expect(tell.input_mapping.text).toEqual({ source: 'step', step: nameOf(next, r.ids.find), field: 'name' })
    expect(unmapData(next, { step: r.ids.tell, field: 'text' })).toEqual(r)
  })

  it('moves the consumer after the producer when it was written before', () => {
    const r = scratch() as Recipe & { ids: Record<string, string> }
    const next = mapData(r, { kind: 'step', step: r.ids.list, path: 'count' }, { step: r.ids.find, field: 'email' })
    const order = readingOrder(next)
    expect(order.get(r.ids.find)!).toBeGreaterThan(order.get(r.ids.list)!)
    expect(check(next, cat).filter((p) => /comes later/.test(p.message))).toEqual([])
  })
})

describe('diagram edits: delete, duplicate, undo', () => {
  it('deletes a step and undo brings it back exactly', () => {
    const r = connect(confirmBigOrders(), cat, 's_confirm', 's_customer')
    const history = new History<Recipe>()
    history.record(r, 1000)
    const deleted = deleteBlocks(r, ['s_confirm'])
    expect(findBlock(deleted.blocks, 's_confirm')).toBeNull()
    expect(step(deleted, 's_customer').after).toBeUndefined()
    // The return that used it now points at a removed step: shown, not dropped.
    expect(check(deleted, cat).some((p) => p.message === 'Uses a step that was removed')).toBe(true)
    const back = history.undo(deleted)
    expect(back).toBe(r)
    expect(history.redo(back!)).toBe(deleted)
  })

  it('deletes a container with its steps', () => {
    const r = confirmBigOrders()
    const each = r.blocks.find((b) => b.kind === 'foreach')!
    const next = deleteBlocks(r, [each.id])
    expect(allSteps(next.blocks).some((s) => s.id === 's_reserve')).toBe(false)
  })

  it('quick edits undo together, sealed ones apart', () => {
    const h = new History<number>()
    h.record(1, 1000); h.record(2, 1100); h.record(3, 5000)
    expect(h.undo(4)).toBe(3)
    expect(h.undo(3)).toBe(1)
    expect(h.canUndo).toBe(false)
  })

  it('duplicates a step right after it', () => {
    const r = confirmBigOrders()
    const out = duplicateBlock(r, 's_email')!
    const copy = step(out.recipe, out.id)
    expect(copy.name).not.toBe('email_the_customer')
    expect(readingOrder(out.recipe).get(out.id)).toBe(readingOrder(out.recipe).get('s_email')! + 1)
    expect(compile(out.recipe, cat).problems).toEqual([])
  })

  it('duplicates a For each with its inner data following the copy', () => {
    const r = confirmBigOrders()
    const each = r.blocks.find((b) => b.kind === 'foreach')!
    const out = duplicateBlock(r, each.id)!
    const copy = findBlock(out.recipe.blocks, out.id)!.block
    expect(copy.kind).toBe('foreach')
    const inner = allSteps((copy as Extract<typeof copy, { kind: 'foreach' }>).blocks)[0]
    expect(inner.fields.sku).toEqual({ kind: 'ref', ref: { kind: 'item', loop: out.id, path: 'sku' } })
  })

  it('moves a step into a block and back out', () => {
    const r = confirmBigOrders()
    const ifId = r.blocks.find((b) => b.kind === 'if')!.id
    const inside = moveInto(r, 's_email', ifId)
    expect(findBlock(inside.blocks, 's_email')!.scope.parents.map((p) => p.id)).toEqual([ifId])
    const out = moveInto(inside, 's_email', null)
    expect(findBlock(out.blocks, 's_email')!.scope.parents).toEqual([])
  })
})

describe('diagram edit → compile → decompile', () => {
  const roundTrip = (recipe: Recipe) => {
    const result = compile(recipe, cat)
    const children = Object.fromEntries(result.children.map((c) => [c.name, c.definition])) as Record<string, CompositionDefinition>
    const reopened = decompile(result.definition, cat, { children })
    const again = compile(reopened, cat)
    return { result, reopened, again }
  }

  it('keeps every diagram edit through a save and reopen', () => {
    let r = confirmBigOrders()
    r = insertBetween(r, cat, { type: 'shop.order.list', title: 'List orders' }, 's_confirm', 's_email').recipe
    r = connect(r, cat, 's_customer', 's_order')
    r = parallelize(r, cat, ['s_confirm', 's_email']).recipe
    r = mapData(r, { kind: 'step', step: 's_order', path: 'number' }, { step: 's_confirm', field: 'note' })
    const { result, reopened, again } = roundTrip(r)
    expect(result.problems).toEqual([])
    expect(canonicalJson(again.definition)).toBe(canonicalJson(result.definition))
    expect(canonicalJson(again.children.map((c) => c.definition))).toBe(canonicalJson(result.children.map((c) => c.definition)))
    const customer = allSteps(reopened.blocks).find((s) => s.name === 'find_the_customer')!
    const order = allSteps(reopened.blocks).find((s) => s.name === 'get_the_order')!
    expect(order.after).toEqual([customer.id])
    expect(allSteps(reopened.blocks).find((s) => s.name === 'email_the_customer')!.alongside).toBe(true)
  })

  it('keeps a wait on a step outside a multi-step For each', () => {
    let r = confirmBigOrders()
    const each = r.blocks.find((b) => b.kind === 'foreach')!
    r = addStep(r, { type: 'slack.message.send', title: 'Note the item' }, { parent: each.id, index: 1 }).recipe
    const inner = allSteps((findBlock(r.blocks, each.id)!.block as Extract<typeof each, { kind: 'foreach' }>).blocks)
    expect(inner).toHaveLength(2)
    r = connect(r, cat, 's_customer', inner[1].id)
    const { result, reopened, again } = roundTrip(r)
    expect(result.children).toHaveLength(1)
    expect(canonicalJson(again.definition)).toBe(canonicalJson(result.definition))
    const reopenedInner = allSteps(reopened.blocks).find((s) => s.name === inner[1].name)!
    const customer = allSteps(reopened.blocks).find((s) => s.name === 'find_the_customer')!
    expect(reopenedInner.after).toEqual([customer.id])
  })

  it('a workflow built from scratch on the diagram reopens the same', () => {
    const r = scratch() as Recipe & { ids: Record<string, string> }
    let next = sequence(r, cat, [r.ids.find, r.ids.list])
    next = insertBetween(next, cat, { type: 'control.time.now', title: 'Get the current time' }, r.ids.tell, r.ids.email).recipe
    const { result, again } = roundTrip(next)
    expect(canonicalJson(again.definition)).toBe(canonicalJson(result.definition))
  })
})

describe('the diagram graph', () => {
  it('draws steps, blocks, answers and returns, with run-order wires', () => {
    const r = confirmBigOrders()
    const d = buildDiagram(r, cat)
    const ids = d.nodes.map((n) => n.id)
    expect(ids).toContain(INPUTS)
    expect(ids).toContain(RETURNS)
    expect(d.nodes.find((n) => n.id === 's_reserve')!.parent).toBe(r.blocks.find((b) => b.kind === 'foreach')!.id)
    const wires = d.edges.filter((e) => !e.layoutOnly)
    expect(wires).toContainEqual(expect.objectContaining({ from: 's_confirm', to: 's_email', kind: 'order' }))
    // Implied wires are left out: confirm waits for the order through the For each.
    expect(wires.some((e) => e.from === 's_order' && e.to === 's_confirm')).toBe(false)
  })

  it('marks explicit waits and data wires with their fields', () => {
    const r = connect(confirmBigOrders(), cat, 's_confirm', 's_customer')
    const d = buildDiagram(r, cat, { data: true })
    expect(d.edges).toContainEqual(expect.objectContaining({ from: 's_confirm', to: 's_customer', kind: 'after' }))
    expect(d.edges).toContainEqual(expect.objectContaining({ from: 's_customer', to: 's_email', kind: 'data', fromPort: 'out:email', toPort: 'in:to' }))
    expect(d.edges).toContainEqual(expect.objectContaining({ from: INPUTS, fromPort: 'out:order_id', to: 's_order', toPort: 'in:order_id' }))
  })

  it('collapses a block into one box and drills into it', () => {
    const r = confirmBigOrders()
    const each = r.blocks.find((b) => b.kind === 'foreach')!
    const collapsed = buildDiagram(r, cat, { collapsed: new Set([each.id]) })
    expect(collapsed.nodes.some((n) => n.id === 's_reserve')).toBe(false)
    expect(collapsed.rep.get('s_reserve')).toBe(each.id)
    expect(collapsed.nodes.find((n) => n.id === each.id)!.collapsed).toBe(true)
    const drilled = buildDiagram(r, cat, { root: each.id })
    expect(drilled.nodes.filter((n) => n.kind === 'step').map((n) => n.id)).toEqual(['s_reserve'])
  })

  it('keeps the start and end hints out of a large diagram', () => {
    const hint = { id: 'l', from: INPUTS, to: 'a', kind: 'order' as const, layoutOnly: true }
    const wire = { id: 'a', from: 'a', to: 'b', kind: 'order' as const }
    expect(paintedEdges([wire, hint], 10).map((e) => e.id)).toEqual(['a', 'l'])
    expect(paintedEdges([wire, hint], 41).map((e) => e.id)).toEqual(['a'])
  })

  it('opens another workflow inline under its step, read-only', () => {
    let r = emptyRecipe('Parent')
    const host = { kind: 'step', id: uid('s'), name: 'run_child', autoName: false, title: 'Run child', workflowType: 'virtual.abc@1', fields: {}, undo: [], stopOnFail: false, alongside: false } as Step
    r = { ...r, blocks: [host] }
    const child = confirmBigOrders()
    const d = buildDiagram(r, cat, { nested: { [host.id]: child } })
    expect(d.nodes.find((n) => n.id === host.id)!.expanded).toBe(true)
    const inner = d.nodes.filter((n) => n.nested?.host === host.id)
    expect(inner.length).toBeGreaterThan(4)
    expect(d.edges.some((e) => e.from === `${host.id}::s_confirm` && e.to === `${host.id}::s_email`)).toBe(true)
  })
})

describe('opening definitions made elsewhere', () => {
  const def = (name: string): CompositionDefinition => ({ name: 'x', layers: [{ name: 'l1', steps: [{ name, workflow_type: 'shop.order.get', input_mapping: {} }] }] })
  it('titles a step by its own name when that says more than the catalog', () => {
    const r = decompile(def('read_ticket_number'), cat)
    expect(allSteps(r.blocks)[0].title).toBe('Read ticket number')
    // Its saved name never follows the title: renaming it must not rename the step.
    expect(allSteps(r.blocks)[0].autoName).toBe(false)
  })
  it('keeps the catalog title for placeholder names', () => {
    expect(allSteps(decompile(def('s1'), cat).blocks)[0].title).toBe('Get an order')
    expect(allSteps(decompile(def('get_an_order'), cat).blocks)[0].title).toBe('Get an order')
  })
  it('accepts any path of the item inside its own For each', () => {
    const r = confirmBigOrders()
    const each = r.blocks.find((b) => b.kind === 'foreach')!
    const next = mapData(r, { kind: 'item', loop: each.id, path: '0' }, { step: 's_reserve', field: 'order_id' })
    expect(check(next, cat).filter((p) => /only exists inside its For each/.test(p.message))).toEqual([])
  })
})
