// A schedule's cadence problems in the editor's words.
import type { CadenceProblem } from '../model/schedule'
import { t } from './i18n'

export function cadenceProblemText(problem: CadenceProblem): string {
  switch (problem.code) {
    case 'interval': return t('The interval must be a whole number of minutes.')
    case 'expression': return t('That isn’t a schedule the platform understands: {detail}', { detail: problem.detail ?? '' })
    case 'timezone': return t('That isn’t a time zone the platform knows.')
    case 'too-frequent': return t('Schedules here can run at most every {minutes} minutes.', { minutes: problem.minMinutes ?? 1 })
  }
}
