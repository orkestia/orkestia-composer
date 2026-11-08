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
