// The composition authoring dialect — exactly what the platform's `composition.save`
// accepts. Mirrors the `@orkestia/workflows` composition types, which are the
// reference contract: the wire key is `field`, an upstream step is
// `source: "step"`, and `object`/`list` carry refs nested inside a value.

export type InputMapping =
  | { source: 'input'; field: string }
  | { source: 'step'; step: string; field?: string }
  | { source: 'static'; value?: unknown }
  | { source: 'object'; fields: Record<string, InputMapping> }
  | { source: 'list'; items: InputMapping[] }

export type ConditionOp =
  | 'eq' | 'ne' | 'in' | 'not_in' | 'truthy' | 'falsy'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains' | 'regex'

export const UNARY_OPS: ReadonlySet<ConditionOp> = new Set<ConditionOp>(['truthy', 'falsy'])

export interface ConditionLeaf { step?: string; field: string; op: ConditionOp; value?: unknown }
export type DefinitionCondition =
  | ConditionLeaf
  | { all_of: DefinitionCondition[] }
  | { any_of: DefinitionCondition[] }
  | { not: DefinitionCondition }

export interface FanOut {
  source_step: string
  source_field: string
  as: string
  item_path?: string
  on_error?: 'fail' | 'continue'
}

export interface LoopConfig { max_iterations: number; break_when?: DefinitionCondition }

export interface DefinitionStep {
  name: string
  workflow_type: string
  input_mapping: Record<string, InputMapping>
  condition?: DefinitionCondition
  unrecoverable_on_failure?: boolean
  fan_out?: FanOut
  metadata?: Record<string, unknown>
}

export interface DefinitionLayer {
  name: string
  steps: DefinitionStep[]
  compensate?: DefinitionStep[]
  loop?: LoopConfig
  metadata?: Record<string, unknown>
}

export interface DefinitionInput {
  name: string
  type?: string
  required?: boolean
  description?: string
  source?: Record<string, unknown>
}

export interface CompositionDefinition {
  name: string
  description?: string
  version?: string | number
  inputs?: DefinitionInput[]
  layers: DefinitionLayer[]
  metadata?: Record<string, unknown>
}

/** Keys the engine fills itself; a builder never asks for them. */
export const SERVER_CONTROLLED = new Set(['organization_uuid', 'organization_id', 'actor'])

/** Sorted-key JSON, for "did this change?" comparisons and stable output. */
export function canonicalJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) sorted[k] = (v as Record<string, unknown>)[k]
      return sorted
    }
    return v
  }, space)
}

/**
 * What the platform puts where it hides a value when it shows a saved composition (a static
 * `Authorization` header, a token). A save that still carries it is refused
 * (`composition_hidden_value`): storing it would erase the real value.
 */
export const HIDDEN_MARKER = '<hidden>'

/** Whether a fixed value is, or holds anywhere inside it, the hidden-value marker. */
export function holdsHiddenMarker(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() === HIDDEN_MARKER
  if (Array.isArray(value)) return value.some(holdsHiddenMarker)
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(holdsHiddenMarker)
  return false
}

/**
 * Where a definition's fixed step inputs hold the hidden-value marker, as the platform names them
 * (`steps.<step>.input.<field>.<key>`). The same walk as the platform's save check: step and undo
 * inputs, through `object` and `list` mappings.
 */
export function hiddenValuePaths(definition: CompositionDefinition): string[] {
  const out: string[] = []
  const walkValue = (value: unknown, path: string) => {
    if (typeof value === 'string') { if (value.trim() === HIDDEN_MARKER) out.push(path) }
    else if (Array.isArray(value)) value.forEach((v, i) => walkValue(v, `${path}[${i}]`))
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value as Record<string, unknown>)) walkValue(v, `${path}.${k}`)
  }
  const walkMapping = (m: InputMapping, path: string) => {
    if (m.source === 'static') walkValue(m.value, path)
    else if (m.source === 'object') for (const [k, v] of Object.entries(m.fields)) walkMapping(v, `${path}.${k}`)
    else if (m.source === 'list') m.items.forEach((v, i) => walkMapping(v, `${path}[${i}]`))
  }
  for (const layer of definition.layers ?? []) {
    for (const step of [...(layer.steps ?? []), ...(layer.compensate ?? [])]) {
      for (const [param, m] of Object.entries(step.input_mapping ?? {})) walkMapping(m, `steps.${step.name}.input.${param}`)
    }
  }
  return out
}
