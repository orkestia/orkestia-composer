// The platform shows a saved composition with its hidden values replaced by a placeholder; a save
// that still carries it is refused. The editor says so on the field before anyone saves.
import { describe, expect, it } from 'vitest'
import { sampleCatalog } from './__fixtures__/sampleCatalog'
import { check } from './check'
import { compile } from './compile'
import { HIDDEN_MARKER, hiddenValuePaths, holdsHiddenMarker, type CompositionDefinition } from './definition'
import { decompile } from './decompile'
import { emptyRecipe, newStep, type Recipe, type Value } from './recipe'

function withField(value: Value, undoValue?: Value): { recipe: Recipe; id: string } {
  const step = newStep('shop.order.get', 'Get the order', new Set())
  step.fields.order_id = value
  if (undoValue) step.undo.push({ id: 'u1', name: 'undo_it', title: 'Undo it', workflowType: 'shop.order.get', fields: { order_id: undoValue } })
  return { recipe: { ...emptyRecipe('Orders'), blocks: [step] }, id: step.id }
}

const hiddenProblems = (recipe: Recipe) => check(recipe, sampleCatalog).filter((p) => p.message.includes('hides'))

describe('hidden values', () => {
  it('finds the marker in a fixed value, inside a record and in an undo step', () => {
    for (const value of [
      { kind: 'literal', value: HIDDEN_MARKER },
      { kind: 'literal', value: { headers: { Authorization: ` ${HIDDEN_MARKER} ` } } },
      { kind: 'object', fields: { token: { kind: 'text', parts: [HIDDEN_MARKER] } } },
      { kind: 'text', parts: ['<hid', 'den>'] },
      { kind: 'list', items: [{ kind: 'literal', value: 'a' }, { kind: 'literal', value: HIDDEN_MARKER }] },
    ] as Value[]) {
      const { recipe, id } = withField(value)
      expect(hiddenProblems(recipe)).toEqual([expect.objectContaining({ at: id, field: 'order_id', severity: 'error' })])
    }
    const { recipe } = withField({ kind: 'literal', value: '42' }, { kind: 'literal', value: HIDDEN_MARKER })
    expect(hiddenProblems(recipe)).toHaveLength(1)
    expect(hiddenProblems(recipe)[0].message).toContain('Undo it')
  })

  it('leaves real values, and words around the marker, alone', () => {
    for (const value of [
      { kind: 'literal', value: 'Bearer abc' },
      { kind: 'text', parts: ['Order ', HIDDEN_MARKER, { kind: 'input', name: 'n' }] },
      { kind: 'literal', value: null },
    ] as Value[]) expect(hiddenProblems(withField(value).recipe)).toEqual([])
  })

  it('reads the marker on a definition the way the platform’s save check does', () => {
    const definition: CompositionDefinition = {
      name: 'call', layers: [{
        name: 'l0',
        steps: [{ name: 'post', workflow_type: 'control.http.request', input_mapping: {
          headers: { source: 'object', fields: { Authorization: { source: 'static', value: HIDDEN_MARKER } } },
          body: { source: 'static', value: { items: ['x', HIDDEN_MARKER] } },
          url: { source: 'input', field: 'url' },
        } }],
        compensate: [{ name: 'undo_post', workflow_type: 'control.http.request', input_mapping: { token: { source: 'list', items: [{ source: 'static', value: HIDDEN_MARKER }] } } }],
      }],
    }
    expect(hiddenValuePaths(definition)).toEqual([
      'steps.post.input.headers.Authorization',
      'steps.post.input.body.items[1]',
      'steps.undo_post.input.token[0]',
    ])
    expect(holdsHiddenMarker({ a: [1, { b: HIDDEN_MARKER }] })).toBe(true)
    expect(holdsHiddenMarker('<hidden> value')).toBe(false)
  })

  it('flags a definition opened with the marker, and clears once the value is typed again', () => {
    const { recipe } = withField({ kind: 'literal', value: HIDDEN_MARKER })
    const opened = decompile(compile(recipe, sampleCatalog).definition, sampleCatalog)
    expect(hiddenProblems(opened)).toHaveLength(1)
    const step = opened.blocks[0]
    if (step.kind !== 'step') throw new Error('expected a step')
    step.fields.order_id = { kind: 'literal', value: 'A-1001' }
    expect(hiddenProblems(opened)).toEqual([])
  })
})
