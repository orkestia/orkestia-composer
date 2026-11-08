// The editor on the in-memory fixture backend, to look at and click through:
// `pnpm dev`. Switch the locale, the theme, read-only mode and a stand-in assistant.
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import '../src/ui/styles.css'
import { CompositionEditor, type AssistantRender, type Locale } from '../src'
import { createFixtureBackend, fixtureCatalog, sampleCompositions } from '../src/ui/fixtures'

/** A stand-in for a host's assistant: proposes the open composition with its first round only. */
const assistant: AssistantRender = ({ definition, lineage, onPropose }) => (
  <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <p>Stand-in assistant for “{lineage.title}”.</p>
    <button type="button" disabled={!definition} onClick={() => definition && onPropose({ ...definition, layers: definition.layers.slice(0, 1) })}>
      Propose a shorter version
    </button>
  </div>
)

function Harness() {
  const [locale, setLocale] = useState<Locale>('pt-BR')
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [readOnly, setReadOnly] = useState(false)
  const [withAssistant, setWithAssistant] = useState(true)
  // A new backend starts the editor fresh: only when read-only mode changes.
  const backend = useMemo(() => createFixtureBackend({
    definitions: sampleCompositions(),
    kind: 'app',
    capabilities: readOnly ? { publish: false, run: true } : { publish: true, run: true },
  }), [readOnly])
  const host = useMemo(() => ({ scopeKey: 'harness' }), [])
  // On <html>, so menus, dialogs and toasts (rendered at the end of <body>) follow it too.
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  return (
    <div className="harness">
      <div className="harness-bar">
        <label>Locale <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
          <option value="pt-BR">pt-BR</option><option value="en">en</option><option value="es">es</option>
        </select></label>
        <label>Theme <select value={theme} onChange={(e) => setTheme(e.target.value as 'light' | 'dark')}>
          <option value="light">light</option><option value="dark">dark</option>
        </select></label>
        <label><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> Read-only (no publish)</label>
        <label><input type="checkbox" checked={withAssistant} onChange={(e) => setWithAssistant(e.target.checked)} /> Assistant</label>
      </div>
      <div className="harness-editor">
        <CompositionEditor backend={backend} catalog={fixtureCatalog} host={host} locale={locale} renderAssistant={withAssistant ? assistant : undefined} />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>)
