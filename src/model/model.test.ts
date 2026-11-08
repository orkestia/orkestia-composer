import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sampleCatalog } from './__fixtures__/sampleCatalog'
import { confirmBigOrders, libraryDefinitions } from './__fixtures__/samples'
import { check } from './check'
import { compile, conditionStepNames } from './compile'
import { staticCatalog } from './catalog'
import { availableData, describeRef } from './data'
import { canonicalJson, type CompositionDefinition, type DefinitionStep, type InputMapping } from './definition'
import { decompile } from './decompile'
import { allSteps, emptyRecipe, newStep, type Recipe } from './recipe'
import { fromEditText, toEditText } from './text'

const layerIndex = (def: CompositionDefinition) => {
  const out = new Map<string, number>()
  def.layers.forEach((l, i) => l.steps.forEach((s) => out.set(s.name, i)))
  return out
}

/** A step mapping without `field` reads the whole result, same as `field: ""`. */
const norm = (value: unknown): string => canonicalJson(value, undefined).replace(/"source":"step","step":"([^"]+)"}/g, '"field":"","source":"step","step":"$1"}')

function stepDeps(step: DefinitionStep): string[] {
  const out: string[] = []
  const visit = (m: InputMapping) => {
    if (m.source === 'step') out.push(m.step)
    if (m.source === 'object') Object.values(m.fields).forEach(visit)
    if (m.source === 'list') m.items.forEach(visit)
  }
  Object.values(step.input_mapping ?? {}).forEach(visit)
  if (step.condition) out.push(...conditionStepNames(step.condition))
  if (step.fan_out) out.push(step.fan_out.source_step)
  return out
}

/** Every step comes after everything it reads. */
function expectWellOrdered(def: CompositionDefinition) {
  const at = layerIndex(def)
  for (const layer of def.layers) {
    for (const step of layer.steps) {
      for (const dep of stepDeps(step)) {
        if (!at.has(dep)) continue
        expect(at.get(dep)!, `${step.name} reads ${dep}`).toBeLessThan(at.get(step.name)!)
      }
    }
  }
}

describe('compile: Confirm big orders', () => {
  const recipe = confirmBigOrders()
  const result = compile(recipe, sampleCatalog)
  const def = result.definition
  const steps = def.layers.flatMap((l) => l.steps)
  const byName = new Map(steps.map((s) => [s.name, s]))

  it('compiles without problems', () => {
    expect(result.problems).toEqual([])
    expect(check(recipe, sampleCatalog).filter((p) => p.severity === 'error').map((p) => p.message))
      .toEqual(['Connection needs a value', 'Connection needs a value'])
  })

  it('runs the two lookups together first', () => {
    expect(def.layers[0].steps.map((s) => s.name).sort()).toEqual(['find_the_customer', 'get_the_order'])
  })

  it('keeps actions in the order written and every read after its producer', () => {
    expectWellOrdered(def)
    const at = layerIndex(def)
    expect(at.get('ask_a_manager')!).toBeLessThan(at.get('each_item')!)
    expect(at.get('each_item')!).toBeLessThan(at.get('confirm_the_order')!)
    expect(at.get('confirm_the_order')!).toBeLessThan(at.get('email_the_customer')!)
  })

  it('turns "Only if" into a condition on the step', () => {
    expect(byName.get('ask_a_manager')!.condition).toEqual({ step: 'get_the_order', field: 'total', op: 'gt', value: 1000 })
    expect(byName.get('ask_a_manager')!.unrecoverable_on_failure).toBe(true)
  })

  it('turns text with chips into a hidden format step', () => {
    const prompt = byName.get('ask_a_manager')!.input_mapping.prompt
    expect(prompt).toEqual({ source: 'step', step: 'ask_a_manager__prompt', field: 'result' })
    const fmt = byName.get('ask_a_manager__prompt')!
    expect(fmt.workflow_type).toBe('control.value.format')
    expect(fmt.input_mapping.template).toEqual({ source: 'static', value: 'Approve order {0} for {1}?' })
    expect(fmt.input_mapping.arg0).toEqual({ source: 'step', step: 'get_the_order', field: 'number' })
    expect(fmt.condition).toEqual(byName.get('ask_a_manager')!.condition)
  })

  it('makes a multi-field For each its own composition, run per item', () => {
    expect(result.children).toHaveLength(1)
    const child = result.children[0]
    expect(child.name).toBe('confirm-big-orders--each-item')
    const each = byName.get('each_item')!
    expect(each.workflow_type).toBe('virtual.confirm-big-orders--each-item@latest')
    expect(each.fan_out).toEqual({ source_step: 'get_the_order', source_field: 'items', as: 'item' })
    expect(each.input_mapping).toEqual({ order_id: { source: 'input', field: 'order_id' } })
    const reserve = child.definition.layers[0].steps[0]
    expect(reserve.input_mapping.sku).toEqual({ source: 'input', field: 'item.sku' })
    expect(child.definition.layers[0].compensate?.[0].name).toBe('release_stock')
    expect(child.definition.inputs?.map((i) => i.name)).toEqual(['item', 'order_id'])
  })

  it('writes returns to metadata.output_mapping', () => {
    expect(def.metadata?.output_mapping).toEqual({
      status: { source: 'step', step: 'confirm_the_order', field: 'status' },
      email_id: { source: 'step', step: 'email_the_customer', field: 'message_id' },
    })
  })

  it('is byte-stable', () => {
    expect(canonicalJson(compile(confirmBigOrders(), sampleCatalog).definition)).toBe(canonicalJson(def))
  })

  it('reopens exactly what was built', () => {
    const children = Object.fromEntries(result.children.map((c) => [c.name, c.definition]))
    const reopened = decompile(def, sampleCatalog, { children })
    expect(reopened.readOnly).toEqual([])
    expect(reopened.blocks.map((b) => b.kind)).toEqual(['step', 'step', 'if', 'foreach', 'step', 'step'])
    const again = compile(reopened, sampleCatalog)
    expect(canonicalJson(again.definition)).toBe(canonicalJson(def))
    expect(canonicalJson(again.children.map((c) => c.definition))).toBe(canonicalJson(result.children.map((c) => c.definition)))
  })
})

describe('ordering', () => {
  it('lets an action run alongside the previous one', () => {
    const r = emptyRecipe('Notify')
    const taken = new Set<string>()
    const a = newStep('slack.message.send', 'Tell sales', taken); taken.add(a.name)
    const b = newStep('aws.ses.send_email', 'Tell the customer', taken); taken.add(b.name)
    r.blocks = [a, { ...b, alongside: true }]
    expect(compile(r, sampleCatalog).definition.layers.map((l) => l.steps.length)).toEqual([2])
    r.blocks = [a, b]
    expect(compile(r, sampleCatalog).definition.layers.map((l) => l.steps.length)).toEqual([1, 1])
  })

  it('fans one step out directly when the item feeds one field', () => {
    const r = emptyRecipe('Each order')
    const list = { ...newStep('shop.order.list', 'List new orders', new Set()), id: 'list' }
    const each = { kind: 'foreach' as const, id: 'loop', list: { kind: 'step' as const, step: 'list', path: 'orders' }, as: 'order', onError: 'continue' as const, blocks: [
      { ...newStep('shop.order.get', 'Get the order', new Set()), fields: { order_id: { kind: 'ref' as const, ref: { kind: 'item' as const, loop: 'loop', path: 'order_id' } } } },
    ] }
    r.blocks = [list, each]
    const res = compile(r, sampleCatalog)
    expect(res.children).toEqual([])
    const get = res.definition.layers[1].steps[0]
    expect(get.fan_out).toEqual({ source_step: 'list_new_orders', source_field: 'orders', as: 'order_id', item_path: 'order_id', on_error: 'continue' })
    expect(get.input_mapping.order_id).toBeUndefined()
    const reopened = decompile(res.definition, sampleCatalog)
    expect(canonicalJson(compile(reopened, sampleCatalog).definition)).toBe(canonicalJson(res.definition))
  })
})

describe('chips', () => {
  const recipe = confirmBigOrders()
  it('offers only what comes before', () => {
    const labels = availableData(recipe, sampleCatalog, 's_order').map((o) => o.label)
    expect(labels).toContain('Customer email')
    expect(labels).toContain('Find the customer › name')
    expect(labels.some((l) => l.startsWith('Get the order'))).toBe(false)
  })

  it('offers the item inside a For each, and its fields', () => {
    const labels = availableData(recipe, sampleCatalog, 's_reserve').map((o) => o.label)
    expect(labels).toContain('Item › sku')
  })

  it('round-trips the edit text', () => {
    const options = availableData(recipe, sampleCatalog, 's_email')
    const step = allSteps(recipe.blocks).find((s) => s.id === 's_email')!
    const label = (ref: Parameters<typeof toEditText>[1] extends (r: infer R) => string ? R : never) => options.find((o) => JSON.stringify(o.ref) === JSON.stringify(ref))!.label
    const text = toEditText(step.fields.subject, label)
    expect(text).toBe('Your order {Get the order › number} is confirmed')
    expect(fromEditText(text, options, 'string')).toEqual(step.fields.subject)
    expect(fromEditText('{Customer email}', options, 'email')).toEqual({ kind: 'ref', ref: { kind: 'input', name: 'customer_email' } })
    expect(fromEditText('42', options, 'integer')).toEqual({ kind: 'literal', value: 42 })
    expect(fromEditText('{not a chip}', options, 'string')).toEqual({ kind: 'literal', value: '{not a chip}' })
  })
})

describe('checks', () => {
  it('flags data used before it exists', () => {
    const r: Recipe = confirmBigOrders()
    const [customer, order] = r.blocks
    r.blocks = [{ ...customer, ...(customer.kind === 'step' ? { fields: { email: { kind: 'ref', ref: { kind: 'step', step: 's_order', path: 'customer_email' } } } } : {}) } as typeof customer, order, ...r.blocks.slice(2)]
    const messages = check(r, sampleCatalog).map((p) => p.message)
    expect(messages).toContain('Uses “Get the order › customer email”, which comes later')
  })
})

describe('library compositions open', () => {
  for (const def of libraryDefinitions) {
    it(def.name, () => {
      const recipe = decompile(def, sampleCatalog)
      const again = compile(recipe, sampleCatalog).definition
      expectWellOrdered(again)
      const names = (d: CompositionDefinition) => d.layers.flatMap((l) => l.steps.map((s) => s.name)).sort()
      expect(names(again).filter((n) => !n.includes('__'))).toEqual(names(def))
      const original = new Map(def.layers.flatMap((l) => l.steps).map((s) => [s.name, s]))
      for (const step of again.layers.flatMap((l) => l.steps)) {
        const was = original.get(step.name)!
        expect(norm(step.input_mapping)).toBe(norm(was.input_mapping))
        expect(canonicalJson(step.condition ?? null)).toBe(canonicalJson(was.condition ?? null))
        expect(canonicalJson(step.fan_out ?? null)).toBe(canonicalJson(was.fan_out ?? null))
      }
    })
  }

  // A whole folder of compositions (one `<name>/definition.json` each), when COMPOSER_LIBRARY_DIR points at one.
  const dir = process.env.COMPOSER_LIBRARY_DIR ?? ''
  it.runIf(!!dir && existsSync(dir))('every composition in COMPOSER_LIBRARY_DIR keeps its steps and wiring', () => {
    let checked = 0
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, 'definition.json')
      if (!existsSync(file)) continue
      const def = JSON.parse(readFileSync(file, 'utf8')) as CompositionDefinition
      const recipe = decompile(def, sampleCatalog)
      const again = compile(recipe, sampleCatalog).definition
      expectWellOrdered(again)
      const original = new Map(def.layers.flatMap((l) => [...l.steps, ...(l.compensate ?? [])]).map((s) => [s.name, s]))
      for (const step of again.layers.flatMap((l) => l.steps)) {
        const was = original.get(step.name)
        expect(was, `${def.name}: ${step.name}`).toBeDefined()
        expect(norm(step.input_mapping), `${def.name}: ${step.name}`).toBe(norm(was!.input_mapping))
      }
      expect(again.layers.flatMap((l) => l.steps).length, def.name).toBe(def.layers.flatMap((l) => l.steps).length)
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })
})

describe('renaming a question', () => {
  it('rewrites everything that uses it', async () => {
    const { renameInput } = await import('./recipe')
    const r = renameInput(confirmBigOrders(), 'customer_email', 'email')
    expect(r.inputs.map((i) => i.name)).toContain('email')
    const step = allSteps(r.blocks).find((s) => s.id === 's_customer')!
    expect(step.fields.email).toEqual({ kind: 'ref', ref: { kind: 'input', name: 'email' } })
    expect(check(r, sampleCatalog).filter((p) => p.severity === 'error')).toHaveLength(2)
  })

  it('accepts the hidden organization answer anywhere', () => {
    const r = confirmBigOrders()
    const step = allSteps(r.blocks).find((s) => s.id === 's_order')!
    step.fields.organization_uuid = { kind: 'ref', ref: { kind: 'input', name: 'organization_uuid' } }
    expect(check(r, sampleCatalog).some((p) => p.message.includes('comes later'))).toBe(false)
  })
})

describe('data the platform fills in', () => {
  // As many live workflows do: read the organization without declaring it.
  const live: CompositionDefinition = {
    name: 'order-lookup',
    inputs: [{ name: 'order_id', type: 'string', required: true }],
    layers: [{
      name: 'get',
      steps: [{
        name: 'get_order', workflow_type: 'shop.order.get',
        input_mapping: {
          organization_uuid: { source: 'input', field: 'organization_uuid' },
          order_id: { source: 'input', field: 'order_id' },
          requested_by: { source: 'input', field: 'user_uuid' },
        },
      }],
    }],
  }
  // A schema that marks the signed-in person as filled in from the context.
  const withUser = staticCatalog([{
    ...sampleCatalog.get('shop.order.get')!,
    inputs: [...sampleCatalog.get('shop.order.get')!.inputs, { name: 'user_uuid', type: 'uuid', automatic: true, source: { kind: 'context', ref: 'user' } }],
  }])

  it('never counts the organization or a context field as a removed question', () => {
    const recipe = decompile(live, withUser)
    const problems = check(recipe, withUser)
    expect(problems.filter((p) => p.message.includes('removed'))).toEqual([])
    expect(problems.filter((p) => p.severity === 'error')).toEqual([])
  })

  it('shows them as filled in by Orkestia', async () => {
    const { describeRecipe } = await import('./describe')
    const recipe = decompile(live, withUser)
    const step = allSteps(recipe.blocks)[0]
    const provided = availableData(recipe, withUser, step.id).filter((o) => o.group === 'Filled in by Orkestia')
    expect(provided.map((o) => o.label)).toEqual(['Filled in by Orkestia › Organization', 'Filled in by Orkestia › User'])
    expect(provided[0].ref).toEqual({ kind: 'input', name: 'organization_uuid' })
    expect(describeRef(recipe, withUser, { kind: 'input', name: 'organization_uuid' })).toEqual({ label: 'Filled in by Orkestia › Organization', type: 'uuid' })
    expect(describeRecipe(recipe, withUser)).toContain('organization_uuid ← {Filled in by Orkestia › Organization}')
    expect(describeRecipe(recipe, withUser)).toContain('Starts with: Order id (order_id, string, required)')
  })

  it('still flags a question that was really removed', () => {
    const recipe = decompile(live, withUser)
    recipe.inputs = recipe.inputs.filter((i) => i.name !== 'order_id')
    expect(check(recipe, withUser).map((p) => p.message)).toContain('Uses “Order id”, a question that was removed')
    // Without the schema saying so, an undeclared name is a question found in the workflow.
    const plain = decompile(live, sampleCatalog)
    expect(plain.inputs.find((i) => i.name === 'user_uuid')?.found).toBe(true)
    expect(plain.inputs.some((i) => i.name === 'organization_uuid')).toBe(false)
  })

  it('never asks a declared context input as a question', () => {
    const recipe = decompile({ ...live, inputs: [...live.inputs!, { name: 'user_uuid', type: 'uuid', required: true, source: { kind: 'context', ref: 'user' } }] }, sampleCatalog)
    expect(recipe.inputs.find((i) => i.name === 'user_uuid')?.hidden).toBe(true)
    expect(check(recipe, sampleCatalog).filter((p) => p.severity === 'error')).toEqual([])
  })
})

describe('outline for the assistant', () => {
  it('reads the recipe as text', async () => {
    const { describeRecipe } = await import('./describe')
    const text = describeRecipe(confirmBigOrders(), sampleCatalog)
    expect(text).toContain('Starts with: Order (order_id, string, required); Customer email (customer_email, email, required)')
    expect(text).toContain('Only if Get the order › total > 1000:')
    expect(text).toContain('For each item in Get the order › items:')
    expect(text).toContain('prompt ← "Approve order {Get the order › number} for {Find the customer › name}?"')
  })
})
