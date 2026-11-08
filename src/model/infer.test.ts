import { describe, expect, it } from 'vitest'
import { sampleCatalog } from './__fixtures__/sampleCatalog'
import { staticCatalog } from './catalog'
import { check } from './check'
import { compile } from './compile'
import { canonicalJson, type CompositionDefinition } from './definition'
import { decompile } from './decompile'
import { describeRecipe } from './describe'
import { foundSummary, guessType, savedInputs } from './infer'

// Like the live Market* / Ifood.sync workflows: run inputs read, none declared.
const market: CompositionDefinition = {
  name: 'market-order',
  layers: [
    {
      name: 'read',
      steps: [
        { name: 'get_order', workflow_type: 'shop.order.get', input_mapping: {
          organization_uuid: { source: 'input', field: 'organization_uuid' },
          order_id: { source: 'input', field: 'order_ref' },
        } },
        { name: 'find_customer', workflow_type: 'shop.customer.find', input_mapping: {
          email: { source: 'input', field: 'customer.email' },
          requested_by: { source: 'input', field: 'user_uuid' },
        } },
        { name: 'list', workflow_type: 'shop.order.list', input_mapping: { limit: { source: 'input', field: 'limit' } } },
      ],
    },
    {
      name: 'act',
      steps: [
        { name: 'reserve', workflow_type: 'shop.stock.reserve', condition: { field: 'limit', op: 'gt', value: 5 }, input_mapping: {
          sku: { source: 'static', value: 'A1' },
          quantity: { source: 'input', field: 'qty' },
        } },
        { name: 'each_order', workflow_type: 'shop.order.update-status',
          fan_out: { source_step: 'list', source_field: 'orders', as: 'order' },
          input_mapping: { order: { source: 'input', field: 'order' }, status: { source: 'static', value: 'paid' } } },
      ],
    },
  ],
  metadata: { output_mapping: { echo: { source: 'input', field: 'note' } } },
}

// The signed-in person, filled in by the platform (as #42's schemas mark it).
const catalog = staticCatalog([
  ...['shop.order.get', 'shop.order.list', 'shop.stock.reserve', 'shop.order.update-status'].map((t) => sampleCatalog.get(t)!),
  { ...sampleCatalog.get('shop.customer.find')!, inputs: [...sampleCatalog.get('shop.customer.find')!.inputs, { name: 'user_uuid', type: 'uuid', automatic: true, source: { kind: 'context', ref: 'user' } }] },
])

const found = (def = market) => decompile(def, catalog).inputs.filter((i) => i.found)

describe('questions found in a workflow', () => {
  it('infers what the steps read without declaring', () => {
    const byName = Object.fromEntries(found().map((i) => [i.name, i]))
    expect(Object.keys(byName).sort()).toEqual(['customer', 'limit', 'note', 'order_ref', 'qty'])
    expect(byName.order_ref).toMatchObject({ label: 'Order ref', type: 'string', required: true, found: true })
  })

  it('never infers data the platform fills in, nor a fan-out’s item', () => {
    const names = found().map((i) => i.name)
    expect(names).not.toContain('organization_uuid')
    expect(names).not.toContain('user_uuid')
    expect(names).not.toContain('order')
  })

  it('types them from use and from the step field they feed', () => {
    const byName = Object.fromEntries(found().map((i) => [i.name, i]))
    expect(byName.customer.type).toBe('dict') // read inside: customer.email
    expect(byName.limit.type).toBe('integer') // shop.order.list limit, and "limit > 5"
    expect(byName.qty).toMatchObject({ type: 'integer', required: false }) // required field, but its step runs only if…
    expect(byName.note).toMatchObject({ type: 'json', required: false }) // only returned
    expect(guessType(['uuid', 'string'])).toBe('string')
    expect(guessType(['uuid', 'email'])).toBe('string')
    expect(guessType(['integer', 'float'])).toBe('float')
    expect(guessType(['integer', 'boolean'])).toBe('json')
    expect(guessType([undefined, 'json'])).toBe('json')
  })

  it('changes nothing on open', () => {
    const recipe = decompile(market, catalog)
    const again = decompile(market, catalog)
    // Opening twice compiles the same: not "unsaved changes", nothing to save.
    expect(canonicalJson(compile(recipe, catalog).definition)).toBe(canonicalJson(compile(again, catalog).definition))
    // Left undeclared, the steps and inputs are exactly what was saved.
    const asWas = compile(recipe, catalog, { declareFound: false }).definition
    expect(asWas.inputs?.map((i) => i.name)).toBeUndefined()
    const mappings = (d: CompositionDefinition) => canonicalJson(Object.fromEntries(d.layers.flatMap((l) => l.steps).map((s) => [s.name, s.input_mapping])))
    expect(mappings(asWas)).toBe(mappings(compile(recipe, catalog).definition))
    expect(check(recipe, catalog).filter((p) => p.message.includes('removed')).map((p) => [p.field, p.message])).toEqual([])
  })

  it('declares them on the next save, unless the save summary says not to', () => {
    const recipe = decompile(market, catalog)
    const def = compile(recipe, catalog).definition
    expect(def.inputs).toEqual(expect.arrayContaining([
      { name: 'order_ref', type: 'string', required: true },
      { name: 'customer', type: 'dict', required: false },
      { name: 'limit', type: 'integer', required: false },
    ]))
    expect(foundSummary(recipe.inputs.filter((i) => i.found).length)).toBe('Will also declare 5 questions this workflow already used')
    expect(foundSummary(1)).toBe('Will also declare 1 question this workflow already used')
    expect(savedInputs(recipe.inputs, true).some((i) => i.found)).toBe(false)
    expect(savedInputs(recipe.inputs, false).filter((i) => i.found)).toHaveLength(5)
    // Once declared, reopening finds nothing new: they're ordinary questions.
    const reopened = decompile(def, catalog)
    expect(reopened.inputs.filter((i) => i.found)).toEqual([])
    expect(reopened.inputs.find((i) => i.name === 'order_ref')).toMatchObject({ label: 'Order ref', type: 'string', required: true })
    expect(describeRecipe(recipe, catalog)).toContain('Order ref (order_ref, string, required, found in this workflow: used but not declared yet)')
  })

  it('still warns about a question removed while editing', () => {
    const recipe = decompile(market, catalog)
    recipe.inputs = recipe.inputs.filter((i) => i.name !== 'order_ref')
    expect(check(recipe, catalog).map((p) => p.message)).toContain('Uses “Order ref”, a question that was removed')
  })
})
