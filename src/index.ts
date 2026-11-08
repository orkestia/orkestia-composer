// @orkestia/composer — an embeddable editor for Orkestia compositions.
//
//   import { CompositionEditor, liveCatalog } from '@orkestia/composer'
//   import '@xyflow/react/dist/style.css'
//   import '@orkestia/composer/style.css'
//
// The pure composition model (recipes, compile, decompile, checks) is also
// available on its own as `@orkestia/composer/model`.

export { CompositionEditor, type CompositionEditorProps } from './ui/CompositionEditor'
export { createComposerStore, rebindComposerStore, type ComposerStore, type ComposerStoreOptions } from './ui/store'
export {
  liveCatalog,
  type AssistantSlotProps,
  type ComposerHost,
  type ComposerStorage,
  type CompositionBackend,
  type CompositionRow,
  type Dependents,
  type FieldDecision,
  type HistoryRow,
  type InspectorStep,
  type Json,
  type Lineage,
  type ListFacts,
  type LiveCatalog,
  type MenuSpec,
  type PublishInput,
  type PublishPending,
  type PublishReceipt,
  type RunInspector,
  type RunRow,
  type RunState,
  type SaveOptions,
  type SaveResult,
  type Schedule,
  type ScheduleBackend,
  type SchedulePatch,
  type ToastAction,
  type ToastKind,
  type ValidateResult,
} from './ui/host'
export type { AssistantRender, AssistantFocus } from './ui/AssistantPanel'
export type { ToolbarTitleRender } from './ui/primitives'
export type { ComposerIcons, IconName, IconProps, IconSize, ProviderMarkRender } from './ui/icons'
export { CATALOGS, type Locale, type Messages } from './ui/i18n'
export type { Catalog, CatalogEntry, CatalogField, FieldType } from './model/catalog'
export { staticCatalog } from './model/catalog'
export type { CompositionDefinition } from './model/definition'
export * from './backends'
export { CadenceFields, PlannedRuns, viewerTimeZone, type CadenceFieldsProps, type PlannedRunsProps } from './ui/schedule'
export {
  MIN_APP_SCHEDULE_MINUTES, cadenceProblem, minGapSeconds, nextAfter, nextOccurrences, parseSchedule, plannedRuns, runsCadence,
  ScheduleExpressionError, type Cadence, type CadenceProblem,
} from './model/schedule'
