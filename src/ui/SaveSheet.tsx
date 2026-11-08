// What saving will do, shown before it happens when there's something to say:
// who still uses the saved versions, and questions found in this workflow that
// the save declares (untick to keep them undeclared).
import { t, plural } from './i18n'
import { useState } from 'react'
import { foundSummary } from '../model/infer'
import type { RecipeInput } from '../model/recipe'
import type { Dependents } from './host'

/** Before saving: who still uses the saved versions, and questions found in this workflow that the save declares. */
export function SaveSheet({ deps, found, version, onCancel, onSave }: { deps: Dependents | { error: string } | null; found: RecipeInput[]; version: number; onCancel: () => void; onSave: (declareFound: boolean) => void }) {
  const [declare, setDeclare] = useState(true)
  const n = deps && !('error' in deps) ? deps.dependent_count : 0
  const title = !deps ? t('Save this workflow')
    : 'error' in deps ? t('Couldn’t check what uses this workflow') : plural(n, '{n} thing uses this workflow', '{n} things use this workflow')
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="sheet wf-deps" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {deps && 'error' in deps ? (
          <p className="muted small">{t('The platform didn’t answer ({error}). Anything pointing at version {version} or earlier keeps running that version until it’s repointed.', { error: deps.error, version })}</p>
        ) : deps ? (
          <>
            <p className="muted small">{t('They keep running the version they point at (up to version {version}) until someone points them at the new one. Saving doesn’t change them.', { version })}</p>
            <ul className="sheet-list">
              {deps.dependents.slice(0, 12).map((d, i) => (
                <li key={i}><span className="sheet-list-name">{String(d.name ?? d.site ?? t('Reference'))}</span><span className="muted small">{String(d.site ?? '')}</span></li>
              ))}
            </ul>
            {deps.dependents.length > 12 ? <p className="muted small">{t('…and {n} more.', { n: deps.dependents.length - 12 })}</p> : null}
          </>
        ) : null}
        {found.length ? (
          <div className="wf-save-found">
            <label className="wf-check">
              <input type="checkbox" checked={declare} onChange={(e) => setDeclare(e.target.checked)} />
              {foundSummary(found.length)}
            </label>
            <p className="muted small">{found.map((i) => i.label || i.name).join(', ')}. {declare ? t('They’ll be asked when it runs.') : t('They stay undeclared, as they are now.')}</p>
          </div>
        ) : null}
        <div className="sheet-actions">
          <button type="button" onClick={onCancel}>{t('Cancel')}</button>
          <button type="button" className="primary" onClick={() => onSave(declare)}>{deps ? t('Save New Version') : t('Save')}</button>
        </div>
      </div>
    </div>
  )
}
