// How often a scheduled workflow runs: every N minutes, or a five-field time
// expression in an IANA time zone, with the next runs it plans. The plan is
// computed here, before anything is saved; the platform decides the real runs.
import { useMemo } from 'react'
import { cadenceProblem, plannedRuns, resolveTimeZone, type Cadence } from '../model/schedule'
import { cadenceProblemText } from './cadence'
import { intlLocale, t } from './i18n'

/** The viewer's own time zone (UTC when the runtime can't tell). */
export function viewerTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

function zones(): string[] {
  try { return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [] } catch { return [] }
}

const when = (date: Date, zone: string) => {
  try {
    return new Intl.DateTimeFormat(intlLocale(), { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date)
  } catch {
    return date.toISOString()
  }
}

export interface PlannedRunsProps {
  cadence: Cadence
  /** The schedule's next run as the platform said, to plan an interval from. */
  nextRunAt?: string | null
  count?: number
  /** Shown beside each run; defaults to the viewer's zone. */
  viewerZone?: string
  /** The shortest gap allowed, in minutes. */
  minMinutes?: number
  /** For tests: plan from this instant instead of now. */
  from?: Date
}

/** The next runs a cadence plans, labelled as planned, in the viewer's time zone and the schedule's. */
export function PlannedRuns({ cadence, nextRunAt, count = 5, viewerZone, minMinutes = 1, from }: PlannedRunsProps) {
  const problem = cadenceProblem(cadence, minMinutes)
  const viewer = viewerZone ?? viewerTimeZone()
  const scheduleZone = cadence.kind === 'cron' && !problem ? resolveTimeZone(cadence.timezone) : viewer
  const runs = useMemo(() => {
    if (problem) return []
    try { return plannedRuns(cadence, { from, anchor: nextRunAt ? new Date(nextRunAt) : null, count }) } catch { return [] }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(cadence), nextRunAt, count, from?.getTime(), !!problem])
  if (problem) return <p className="error-text wf-planned-problem" role="alert">{cadenceProblemText(problem)}</p>
  const twoZones = scheduleZone !== viewer
  return (
    <div className="wf-planned" aria-label={t('Planned runs')}>
      <span className="wf-section-hint">{twoZones ? t('Next {n} planned runs, in your time ({viewer}) and the schedule’s ({zone}):', { n: runs.length, viewer, zone: scheduleZone }) : t('Next {n} planned runs ({zone}):', { n: runs.length, zone: viewer })}</span>
      <ol className="wf-planned-list">
        {runs.map((date) => (
          <li key={date.getTime()}>
            <time dateTime={date.toISOString()}>{when(date, viewer)}</time>
            {twoZones ? <span className="muted"> · {when(date, scheduleZone)}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  )
}

export interface CadenceFieldsProps {
  runs: { everyMinutes: number; cron?: string; timezone?: string }
  disabled?: boolean
  /** Whether the backend takes time expressions. */
  expressions: boolean
  minMinutes: number
  onChange(change: { everyMinutes?: number; cron?: string; timezone?: string }): void
}

/** "Every N minutes" or "By a time expression", with its time zone. */
export function CadenceFields({ runs, disabled, expressions, minMinutes, onChange }: CadenceFieldsProps) {
  const byExpression = runs.cron !== undefined && runs.cron !== null && expressions
  const zoneList = useMemo(zones, [])
  return (
    <div className="wf-cadence">
      {expressions ? (
        <div className="segmented" role="radiogroup" aria-label={t('How often')}>
          <button type="button" role="radio" aria-checked={!byExpression} className={!byExpression ? 'selected' : ''} disabled={disabled}
            onClick={() => onChange({ cron: undefined })}>{t('Every few minutes')}</button>
          <button type="button" role="radio" aria-checked={byExpression} className={byExpression ? 'selected' : ''} disabled={disabled}
            onClick={() => onChange({ cron: runs.cron || '0 9 * * 1-5', timezone: runs.timezone || viewerTimeZone() })}>{t('At set times')}</button>
        </div>
      ) : null}
      {byExpression ? (
        <>
          <label className="wf-every">{t('Times (cron)')}
            <input className="wf-input wf-cron mono" value={runs.cron ?? ''} disabled={disabled} placeholder="0 9 * * 1-5" aria-label={t('Schedule expression')}
              onChange={(e) => onChange({ cron: e.target.value })} />
          </label>
          <label className="wf-every">{t('Time zone')}
            <input className="wf-input wf-zone" list="oc-composer-zones" value={runs.timezone ?? ''} disabled={disabled} placeholder="UTC" aria-label={t('Time zone')}
              onChange={(e) => onChange({ timezone: e.target.value })} />
            <datalist id="oc-composer-zones">{zoneList.map((z) => <option key={z} value={z} />)}</datalist>
          </label>
        </>
      ) : (
        <label className="wf-every">{t('every')}
          <input className="wf-input wf-count" type="number" min={minMinutes} disabled={disabled} value={runs.everyMinutes} aria-label={t('Minutes between runs')}
            onChange={(e) => onChange({ everyMinutes: Math.max(1, Math.round(Number(e.target.value)) || 1) })} />
          {t('minutes')}
        </label>
      )}
    </div>
  )
}
