// The embeddable editor: the list of compositions the caller may see, and the
// one open in it, as steps or as a diagram. Everything it reads and writes
// goes through `backend`; everything the surrounding app owns goes through
// `host` and the slots.
//
//   <CompositionEditor backend={backend} catalog={catalog} locale="pt-BR" />
import { useEffect, useRef } from 'react'
import { AssistantContext, type AssistantRender } from './AssistantPanel'
import type { ComposerHost, CompositionBackend, LiveCatalog } from './host'
import { setLocale, type Locale, type Messages } from './i18n'
import { IconsContext, setProviderMarks, type ComposerIcons, type ProviderMarkRender } from './icons'
import { Overlays } from './Overlays'
import { ToolbarTitleContext, type ToolbarTitleRender } from './primitives'
import { trackPointer } from './runtime'
import { createComposerStore, rebindComposerStore } from './store'
import { WorkflowsView } from './WorkflowsView'

export interface CompositionEditorProps {
  /** Where compositions, checks, runs and schedules come from. A new backend starts the editor fresh. */
  backend: CompositionBackend
  /** The steps the person can use (the full registry for members, the app's authoring catalog for end users). Default: `backend.catalog()`. */
  catalog?: LiveCatalog
  /** Dialogs, menus, notifications, storage and the scope drafts are kept under. */
  host?: ComposerHost
  /** `en` (default), `pt-BR` or `es`. */
  locale?: Locale
  /** Replace any string; keys are the English text. */
  messages?: Messages
  /** Replace any icon. */
  icons?: ComposerIcons
  /** Draw provider logos the host may show; null for providers without one. */
  providerMarks?: ProviderMarkRender
  /** Render a conversation that proposes changes; absent = no assistant. */
  renderAssistant?: AssistantRender
  /** Render the toolbar title (window chrome, breadcrumbs). */
  renderToolbarTitle?: ToolbarTitleRender
  className?: string
}

export function CompositionEditor({
  backend, catalog, host, locale = 'en', messages, icons, providerMarks, renderAssistant, renderToolbarTitle, className,
}: CompositionEditorProps) {
  // Bind before the first child renders: the store and t() read module state.
  const bound = useRef<CompositionBackend | null>(null)
  // Without a catalog, the backend's own (an app's authoring catalog, or the registry), when it has one.
  const steps = catalog ?? backend.catalog?.()
  if (bound.current !== backend) {
    createComposerStore({ backend, catalog: steps, host })
    bound.current = backend
  }
  setLocale(locale, messages)
  setProviderMarks(providerMarks ?? null)

  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    rebindComposerStore({ catalog: steps, host })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, host])
  useEffect(() => { trackPointer() }, [])

  return (
    <div className={`oc-composer${className ? ` ${className}` : ''}`} lang={locale} key={locale}>
      <IconsContext.Provider value={icons ?? {}}>
        <ToolbarTitleContext.Provider value={renderToolbarTitle ?? null}>
          <AssistantContext.Provider value={renderAssistant ?? null}>
            <WorkflowsView />
            <Overlays />
          </AssistantContext.Provider>
        </ToolbarTitleContext.Provider>
      </IconsContext.Provider>
    </div>
  )
}
