import { describe, expect, it } from 'vitest'
import { sampleCatalog } from './__fixtures__/sampleCatalog'
import { confirmBigOrders } from './__fixtures__/samples'
import { compile } from './compile'
import { decompile } from './decompile'
import { allSteps, LINEAGE_SLUG_MAX, lineageSlug, uniqueLineageSlug, type Block, type ForEachBlock, type Recipe } from './recipe'

/** The platform's slug rule: what an app publish accepts. */
const VALID_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const isValidSlug = (s: string) => s.length > 0 && s.length <= LINEAGE_SLUG_MAX && VALID_SLUG.test(s)

const eachStep = (r: ReturnType<typeof compile>) => r.definition.layers.flatMap((l) => l.steps).find((s) => s.name === 'each_item')!

describe('For each child names', () => {
  it('keeps the member name by default, so a saved child keeps its lineage', () => {
    const result = compile(confirmBigOrders(), sampleCatalog)
    expect(result.children.map((c) => c.name)).toEqual(['confirm-big-orders--each-item'])
    expect(isValidSlug(result.children[0].name)).toBe(false)
  })

  it('names children with a slug the app publish accepts', () => {
    const result = compile(confirmBigOrders(), sampleCatalog, { childNames: 'slug' })
    expect(result.children.map((c) => c.name)).toEqual(['confirm-big-orders-each-item'])
    expect(eachStep(result).workflow_type).toBe('virtual.confirm-big-orders-each-item@latest')
    expect(result.children.every((c) => isValidSlug(c.name))).toBe(true)
  })

  it('reopens a slug-named child from its saved definition', () => {
    const result = compile(confirmBigOrders(), sampleCatalog, { childNames: 'slug' })
    const children = Object.fromEntries(result.children.map((c) => [c.name, c.definition]))
    const back = decompile(result.definition, sampleCatalog, { children })
    const loop = back.blocks.find((b): b is ForEachBlock => b.kind === 'foreach')!
    const original = confirmBigOrders().blocks.find((b): b is ForEachBlock => b.kind === 'foreach')!
    expect(allSteps(loop.blocks).map((s) => s.workflowType)).toEqual(allSteps(original.blocks).map((s) => s.workflowType))
    expect(compile({ ...back, name: 'confirm-big-orders' }, sampleCatalog, { childNames: 'slug' }).children.map((c) => c.name))
      .toEqual(['confirm-big-orders-each-item'])
  })

  it('names a second loop over the same item with -2, still a valid slug', () => {
    const recipe = confirmBigOrders()
    const loop = recipe.blocks.find((b): b is ForEachBlock => b.kind === 'foreach')!
    const twice: Recipe = { ...recipe, blocks: [...recipe.blocks, cloneBlock(loop, 'again')] }
    const result = compile(twice, sampleCatalog, { childNames: 'slug' })
    expect(result.problems).toEqual([])
    const names = result.children.map((c) => c.name)
    expect(names).toEqual(['confirm-big-orders-each-item', 'confirm-big-orders-each-item-2'])
    for (const n of names) expect(isValidSlug(n), n).toBe(true)
    // The member naming does the same with its own suffix, unchanged.
    expect(compile(twice, sampleCatalog).children.map((c) => c.name)).toEqual(['confirm-big-orders--each-item', 'confirm-big-orders--each-item_2'])
  })

  it('stays within the slug length for a long parent name', () => {
    const recipe = { ...confirmBigOrders(), name: 'a-really-long-workflow-name-that-goes-on-and-on-and-on-forever' }
    const [child] = compile(recipe, sampleCatalog, { childNames: 'slug' }).children
    expect(isValidSlug(child.name)).toBe(true)
  })
})

describe('lineage slugs', () => {
  it('folds accents and symbols into single hyphens', () => {
    expect(lineageSlug('Nota fiscal → WhatsApp')).toBe('nota-fiscal-whatsapp')
    expect(lineageSlug('a__b--c')).toBe('a-b-c')
    expect(lineageSlug('***')).toBe('workflow')
    expect(lineageSlug('x'.repeat(70) + '-y')).toBe('x'.repeat(64))
    expect(lineageSlug('ab-'.repeat(30))).toMatch(VALID_SLUG)
  })

  it('makes a taken name unique with -2, -3 and stays valid', () => {
    expect(uniqueLineageSlug('rotina', new Set())).toBe('rotina')
    expect(uniqueLineageSlug('rotina', new Set(['rotina']))).toBe('rotina-2')
    expect(uniqueLineageSlug('rotina', new Set(['rotina', 'rotina-2']))).toBe('rotina-3')
    const long = 'x'.repeat(64)
    const next = uniqueLineageSlug(long, new Set([long]))
    expect(next).toBe(`${'x'.repeat(62)}-2`)
    expect(isValidSlug(next)).toBe(true)
  })
})

/** A copy of a block with fresh ids (and every reference inside it remapped) and suffixed step names. */
function cloneBlock(block: Block, suffix: string): Block {
  const ids: string[] = []
  const collect = (b: Block) => { ids.push(b.id); if (b.kind !== 'step') for (const c of b.blocks) collect(c) }
  collect(block)
  let json = JSON.stringify(block)
  for (const id of ids) json = json.split(`"${id}"`).join(`"${id}-${suffix}"`)
  const copy = JSON.parse(json) as Block
  for (const s of allSteps([copy])) { s.name = `${s.name}_${suffix}`; s.autoName = false }
  return copy
}
