import { createContext, useContext } from 'react'
import type { Catalog, CatalogEntry } from '../model/catalog'
import type { Problem } from '../model/check'
import type { Recipe } from '../model/recipe'
import type { Fix } from './findings'
import type { InspectorStep } from './host'

export interface EditorApi {
  recipe: Recipe
  catalog: Catalog
  problems: Problem[]
  readOnly: boolean
  /** Step number in reading order. */
  numbers: Map<string, number>
  /** Per block: how it went in the run shown (live or opened from history). */
  runSteps: Record<string, InspectorStep['status']>
  runFailures: Record<string, string>
  /** The finished run's output, by step name, to show what each step returned. */
  runOutput: Record<string, unknown> | null
  applyFix: (fix: Fix) => void
  /** Type of the step a field belongs to, for platform pickers. */
  fieldOptions: (workflowType: string, partial: Record<string, unknown>) => Promise<Array<{ field: string; status: string; options?: Array<{ value: unknown; label: string }> }>>
  update: (change: (recipe: Recipe) => Recipe) => void
  pickStep: (anchor: HTMLElement | null, onPick: (entry: CatalogEntry) => void, filter?: (entry: CatalogEntry) => boolean) => void
}

export const EditorContext = createContext<EditorApi | null>(null)

export function useEditor(): EditorApi {
  const api = useContext(EditorContext)
  if (!api) throw new Error('useEditor outside the recipe editor')
  return api
}
