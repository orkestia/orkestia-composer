// The platform's validation answers, pinned to the cards they are about.
// composition.validate returns plain strings: structural lint ones start with
// a path (`layers[0].steps[1].name: …`), validator ones name the step in prose
// (`Step 'x' …`). Repairs carry `step_name` + `param` and candidate producers.
import { t } from './i18n'
import type { Fix, Problem } from '../model/check'
import { SERVER_CONTROLLED, type CompositionDefinition } from '../model/definition'
import type { ValidateResult } from './host'

export type { Fix }
export type ServerProblem = Problem & { source: 'platform' }

const PATH = /^layers\[(\d+)\]\.(steps|compensate)\[(\d+)\]/

/**
 * The composition lint still calls these keys and sources unknown although the
 * engine runs them. Hidden until the lint catches up.
 */
const LINT_FALSE_ALARMS = [
  /unknown key '(condition|fan_out|metadata|unrecoverable_on_failure)'/,
  /unknown or missing 'source': '(object|list)'/,
]
const STEP = /\b[Ss]tep '([^']+)'/

function owner(definition: CompositionDefinition, owners: Record<string, string>, text: string): string | undefined {
  const path = PATH.exec(text)
  if (path) {
    const layer = definition.layers[Number(path[1])]
    const step = (path[2] === 'steps' ? layer?.steps : layer?.compensate)?.[Number(path[3])]
    if (step) return owners[step.name]
  }
  const named = STEP.exec(text)
  if (named) return owners[named[1]]
  for (const name of Object.keys(owners).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(text)) return owners[name]
  }
  return undefined
}

/** Plain words for the engine's phrasing. */
export function humanMessage(text: string): string {
  return text
    .replace(PATH, '')
    .replace(/^[\w.[\]]*:\s*/, '')
    .replace(/^dry_run failed \(composition would not run\):?\s*/i, t('Test run: '))
    .replace(/references unknown workflow type/i, t('uses a step the platform doesn’t know'))
    .replace(/\s+/g, ' ')
    .trim()
}

export function serverProblems(result: ValidateResult, definition: CompositionDefinition, owners: Record<string, string>, ignore: (text: string) => boolean = () => false): ServerProblem[] {
  const out: ServerProblem[] = []
  const add = (text: string, severity: Problem['severity']) => {
    if (!text || ignore(text) || LINT_FALSE_ALARMS.some((re) => re.test(text)) || (/^dry_run failed/i.test(text) && !text.includes(':'))) return
    const at = owner(definition, owners, text)
    out.push({ ...(at ? { at } : {}), severity, message: humanMessage(text), source: 'platform' })
  }
  for (const e of result.errors ?? []) add(e, 'error')
  for (const w of result.warnings ?? []) add(w, 'warning')
  for (const e of result.dry_run?.evaluated && !result.dry_run.passed ? result.dry_run.errors : []) add(t('Test run: {error}', { error: e }), 'error')
  for (const r of result.repairs ?? []) {
    if (!r.step_name || !r.param || SERVER_CONTROLLED.has(r.param)) continue
    const at = owners[r.step_name]
    if (!at) continue
    const candidate = r.candidates?.find((c) => c.producer_step && c.field_name && owners[c.producer_step])
    const problem: ServerProblem = { at, field: r.param, severity: 'warning', message: r.hint ?? t('{field} isn’t filled in', { field: r.param.replace(/_/g, ' ') }), source: 'platform' }
    if (candidate) {
      problem.fix = { at, field: r.param, producer: owners[candidate.producer_step!], path: candidate.field_name!, label: `${candidate.producer_step} › ${candidate.field_name}` }
    }
    if (!out.some((p) => p.at === at && p.field === r.param)) out.push(problem)
  }
  return out
}
