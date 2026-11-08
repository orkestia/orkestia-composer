// Golden round-trip over the example compositions in `__fixtures__/library`:
// decompile → compile must keep the definition, apart from what the compiler
// owns by design.
//
// The compiler owns layering: it re-levels steps by what they read (longest
// path), so layer names become `layer_N` and independent steps can share a
// layer. It also writes defaults out the same way every time (`required:
// false` on inputs, no `on_error: "fail"` on a fan-out). Everything else, the
// steps, their wiring, inputs, metadata and the definition's own version, must
// come back exactly; and compiling the result again must give the same bytes.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sampleCatalog } from './__fixtures__/sampleCatalog'
import { compile, conditionStepNames } from './compile'
import { canonicalJson, type CompositionDefinition, type DefinitionInput, type DefinitionStep, type InputMapping } from './definition'
import { decompile } from './decompile'

const dir = join(__dirname, '__fixtures__/library')
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()

/** A step mapping without `field` reads the whole result, same as `field: ""`. */
const canon = (value: unknown): string =>
  (canonicalJson(value, undefined) ?? 'undefined').replace(/"source":"step","step":"([^"]+)"}/g, '"field":"","source":"step","step":"$1"}')

const input = (i: DefinitionInput) => ({ required: false, ...i })

function step(s: DefinitionStep) {
  return s.fan_out ? { ...s, fan_out: { on_error: 'fail', ...s.fan_out } } : s
}

/** The definition with layering taken out: steps (and undo steps) by name, everything else as is. */
function semantic(def: CompositionDefinition) {
  const metadata = { ...(def.metadata ?? {}) }
  delete metadata.recipe
  const steps: Record<string, unknown> = {}
  const undo: Record<string, unknown> = {}
  for (const layer of def.layers) {
    for (const s of layer.steps) steps[s.name] = step(s)
    for (const s of layer.compensate ?? []) undo[s.name] = step(s)
  }
  return canon({
    name: def.name, description: def.description, version: def.version,
    inputs: (def.inputs ?? []).map(input), metadata, steps, undo,
  })
}

function reads(s: DefinitionStep): string[] {
  const out: string[] = []
  const visit = (m: InputMapping) => {
    if (m.source === 'step') out.push(m.step)
    if (m.source === 'object') Object.values(m.fields).forEach(visit)
    if (m.source === 'list') m.items.forEach(visit)
  }
  Object.values(s.input_mapping ?? {}).forEach(visit)
  if (s.condition) out.push(...conditionStepNames(s.condition))
  if (s.fan_out) out.push(s.fan_out.source_step)
  return out
}

describe('golden round-trip: the example composition library', () => {
  it('has fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5)
  })

  for (const file of fixtures) {
    const def = JSON.parse(readFileSync(join(dir, file), 'utf8')) as CompositionDefinition

    describe(file, () => {
      const recipe = decompile(def, sampleCatalog)
      const once = compile(recipe, sampleCatalog)

      it('opens editable, or says why not', () => {
        for (const reason of recipe.readOnly) expect(reason.length).toBeGreaterThan(0)
        expect(recipe.readOnly).toEqual([])
      })

      it('compiles without problems', () => {
        expect(once.problems).toEqual([])
      })

      it('keeps everything but the layering', () => {
        expect(semantic(once.definition)).toBe(semantic(def))
      })

      it('runs every step after what it reads', () => {
        const at = new Map<string, number>()
        once.definition.layers.forEach((l, i) => l.steps.forEach((s) => at.set(s.name, i)))
        for (const s of once.definition.layers.flatMap((l) => l.steps)) {
          for (const dep of reads(s)) if (at.has(dep)) expect(at.get(dep)!, `${s.name} reads ${dep}`).toBeLessThan(at.get(s.name)!)
        }
      })

      it('compiles to the same bytes the second time', () => {
        const twice = compile(decompile(once.definition, sampleCatalog), sampleCatalog).definition
        expect(canonicalJson(twice)).toBe(canonicalJson(once.definition))
      })
    })
  }
})

describe('definition-level settings', () => {
  const base: CompositionDefinition = {
    name: 'say-hello', version: '1.2.0',
    layers: [{ name: 'only', steps: [{ name: 'format', workflow_type: 'control.value.format', input_mapping: { template: { source: 'static', value: 'hello' } } }] }],
  }

  it('keeps the definition version', () => {
    const recipe = decompile(base, sampleCatalog)
    expect(recipe.version).toBe('1.2.0')
    expect(compile(recipe, sampleCatalog).definition.version).toBe('1.2.0')
  })

  it('opens read-only, with the reason, when the definition carries a setting the builder does not edit', () => {
    const recipe = decompile({ ...base, timeout_seconds: 30 } as CompositionDefinition, sampleCatalog)
    expect(recipe.readOnly).toEqual(['The workflow carries a setting the builder doesn’t edit (timeout_seconds)'])
  })
})
