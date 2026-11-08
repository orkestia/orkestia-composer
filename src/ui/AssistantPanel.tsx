// "Discuss with the assistant": a panel beside the recipe whose conversation
// the host renders (`renderAssistant`). The host's assistant reads the
// composition, proposes a new definition through `onPropose`, and the person
// reviews it here and applies it to the editor; nothing is saved without them.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { IcSparkles, IcWand, IcX } from './icons'
import { confirmDialog } from './runtime'
import { t, plural } from './i18n'
import type { RecipeMeta } from '../model/compile'
import type { CompositionDefinition } from '../model/definition'
import { decompile } from '../model/decompile'
import { describeRecipe } from '../model/describe'
import type { Recipe } from '../model/recipe'
import type { AssistantSlotProps } from './host'
import { builder, catalog, type Entry } from './store'

export type AssistantRender = (props: AssistantSlotProps) => ReactNode
export const AssistantContext = createContext<AssistantRender | null>(null)
/** Whether the host gave the editor an assistant (the toolbar shows the button only then). */
export const useHasAssistant = () => useContext(AssistantContext) !== null

/** What the assistant last proposed. */
interface Proposal { definition: CompositionDefinition; savedAs: string | null; stepCount: number }

/** Builder-made definitions reopen exactly; if the assistant renamed or added steps, read them layer by layer instead. */
function toRecipe(definition: CompositionDefinition, entry: Entry): Recipe {
  const def = structuredClone(definition)
  const meta = def.metadata?.recipe as RecipeMeta | undefined
  if (meta) {
    const names = new Set(def.layers.flatMap((l) => l.steps.map((s) => s.name)))
    const treeNames: string[] = []
    const walk = (nodes: RecipeMeta['tree']) => nodes.forEach((n) => (typeof n === 'string' ? treeNames.push(n) : walk(n.items)))
    walk(meta.tree)
    const fits = treeNames.every((n) => names.has(n)) && [...names].every((n) => treeNames.includes(n) || /__/.test(n))
    if (!fits) delete def.metadata!.recipe
  }
  const recipe = decompile(def, catalog, { children: entry.childDefs })
  return { ...recipe, name: entry.recipe?.name ?? entry.key, title: entry.recipe?.title ?? recipe.title, runs: entry.recipe?.runs ?? recipe.runs, readOnly: [] }
}

/** Blocks picked on the diagram, as context for the assistant. */
export interface AssistantFocus { title: string; name: string; type?: string }

export function AssistantPanel({ entry, dirty, focus = [], onClearFocus }: { entry: Entry; dirty: boolean; focus?: AssistantFocus[]; onClearFocus?: () => void }) {
  const render = useContext(AssistantContext)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  useEffect(() => { setProposal(null) }, [entry.key])

  const apply = async () => {
    if (!proposal) return
    if (dirty && !(await confirmDialog(t('Replace your unsaved changes with the assistant’s version?'), { title: t('Apply Changes'), okLabel: t('Replace') }))) return
    builder.update(entry.key, () => toRecipe(proposal.definition, entry))
    setProposal(null)
  }

  if (!render) return null

  const head = entry.head
  const slot = render({
    definition: (head?.definition as CompositionDefinition | undefined) ?? null,
    outline: entry.recipe ? describeRecipe(entry.recipe, catalog) : '',
    focus,
    lineage: { key: entry.key, title: entry.title, version: entry.version, compositionUuid: head?.composition_uuid ?? null, dirty },
    onPropose: (definition, options) => {
      if (!definition || !Array.isArray(definition.layers)) return
      setProposal({ definition, savedAs: options?.savedAs ?? null, stepCount: definition.layers.reduce((n, l) => n + (l.steps?.length ?? 0), 0) })
    },
  })

  return (
    <aside className="wf-panel wf-assistant">
      <div className="wf-assistant-head">
        <h3 className="wf-panel-title"><IcSparkles size="sm" /> {t('Assistant')}</h3>
      </div>
      {dirty && head ? <p className="wf-section-hint">{t('The assistant reads version {version}. Save to share your latest edits.', { version: entry.version })}</p> : null}
      {focus.length ? (
        <p className="wf-assistant-focus">
          <span>{t('About: {titles}', { titles: focus.map((f) => `“${f.title}”`).join(', ') })}</span>
          {onClearFocus ? <button type="button" className="icon-button" aria-label={t('Ask about the whole workflow')} title={t('Ask about the whole workflow')} onClick={onClearFocus}><IcX size="xs" /></button> : null}
        </p>
      ) : null}
      {proposal ? (
        <div className="wf-proposal">
          <IcWand size="sm" />
          <span>{proposal.savedAs
            ? t('The assistant saved a new version ({version}).', { version: proposal.savedAs.replace(/^virtual\.[0-9a-f]+@/, 'v') })
            : plural(proposal.stepCount, 'The assistant has a version with {n} step.', 'The assistant has a version with {n} steps.')}</span>
          {proposal.savedAs
            ? <button type="button" onClick={() => { builder.discard(entry.key); setProposal(null) }}>{t('Reload')}</button>
            : <button type="button" className="primary" onClick={() => void apply()}>{t('Apply to the Builder')}</button>}
        </div>
      ) : null}
      <div className="wf-assistant-chat">{slot}</div>
    </aside>
  )
}
