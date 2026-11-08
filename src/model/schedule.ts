// When a schedule runs: five-field time expressions read in the schedule's own
// IANA time zone, fixed intervals, and the "next runs" a schedule editor shows
// before anything is saved. Pure: no clock unless you pass none, no DOM.
//
// The semantics follow the platform's scheduler, so what the editor plans is
// what fires:
//
// - Fields: minute 0-59, hour 0-23, day-of-month 1-31, month 1-12,
//   day-of-week 0-7 (0 and 7 are Sunday). Each is `*`, `*/n`, `a-b`, `a-b/n`,
//   `n`, or a comma list of those. No names (`MON`) and no macros (`@daily`).
// - When both day-of-month and day-of-week are restricted (not a literal `*`),
//   a day matches if either does.
// - Wall time: a local time a DST change skips does not fire that day; a local
//   time a DST change repeats fires once, at its first instant.
// - The shortest gap is measured in UTC over 128 consecutive occurrences from
//   2024-01-01, floored at one minute.
//
// Everything here is a plan computed on the client: the platform decides when
// a run actually starts.

/** The shortest gap an end user's schedule may have (app schedules), in minutes. */
export const MIN_APP_SCHEDULE_MINUTES = 15

/** How often a schedule starts its workflow. */
export type Cadence =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'cron'; expression: string; timezone?: string | null }

export class ScheduleExpressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleExpressionError'
  }
}

export interface ScheduleExpression {
  text: string
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  days: ReadonlySet<number>
  months: ReadonlySet<number>
  weekdays: ReadonlySet<number>
  dayOfMonthAny: boolean
  dayOfWeekAny: boolean
}

const FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'] as const
const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
const LOOKAHEAD_DAYS = 366 * 5
const GAP_SAMPLES = 128
const GAP_EPOCH = Date.UTC(2024, 0, 1)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const invalid = (text: string, reason: string) => new ScheduleExpressionError(`time expression '${text}': ${reason}`)

function parseInt10(token: string, field: string, text: string, low: number, high: number): number {
  if (!/^\d+$/.test(token)) throw invalid(text, `${field} field entry '${token}' is not a whole number`)
  const value = Number(token)
  if (value < low || value > high) throw invalid(text, `${field} field entry ${value} is outside ${low}-${high}`)
  return value
}

function parseField(text: string, index: number): Set<number> {
  const field = FIELD_NAMES[index]
  const [low, high] = FIELD_RANGES[index]
  const values = new Set<number>()
  for (const entry of text.split(',')) {
    if (!entry) throw invalid(text, `${field} field '${text}' has an empty list entry`)
    const slash = entry.indexOf('/')
    const base = slash >= 0 ? entry.slice(0, slash) : entry
    const step = slash >= 0 ? parseInt10(entry.slice(slash + 1), field, text, 1, high) : 1
    let start: number
    let end: number
    if (base === '*') {
      start = low
      end = high
    } else if (base.includes('-')) {
      const dash = base.indexOf('-')
      start = parseInt10(base.slice(0, dash), field, text, low, high)
      end = parseInt10(base.slice(dash + 1), field, text, low, high)
      if (start > end) throw invalid(text, `${field} field range '${base}' starts after it ends`)
    } else {
      start = end = parseInt10(base, field, text, low, high)
    }
    for (let v = start; v <= end; v += step) values.add(v)
  }
  if (!values.size) throw invalid(text, `${field} field '${text}' allows no value`)
  return values
}

/** Parse a five-field expression, or throw ScheduleExpressionError. */
export function parseSchedule(expression: string | ScheduleExpression): ScheduleExpression {
  if (typeof expression !== 'string') return expression
  const raw = (expression ?? '').trim()
  if (!raw) throw new ScheduleExpressionError("time expression must not be empty; expected five fields 'minute hour day-of-month month day-of-week', e.g. '0 6 * * 1-5'")
  const fields = raw.split(/\s+/)
  if (fields.length !== 5) throw invalid(raw, `expected five fields 'minute hour day-of-month month day-of-week', got ${fields.length}`)
  const values = fields.map((f, i) => parseField(f, i))
  return {
    text: fields.join(' '),
    minutes: values[0], hours: values[1], days: values[2], months: values[3],
    weekdays: new Set([...values[4]].map((d) => (d === 7 ? 0 : d))),
    dayOfMonthAny: fields[2] === '*',
    dayOfWeekAny: fields[4] === '*',
  }
}

// ---- Time zones ----

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(zone, f)
  }
  return f
}

/** The IANA zone a name names (blank or `UTC` is UTC), or throw ScheduleExpressionError. */
export function resolveTimeZone(zone: string | null | undefined): string {
  const name = (zone ?? '').trim()
  if (!name || name.toUpperCase() === 'UTC') return 'UTC'
  try {
    formatter(name)
  } catch {
    throw new ScheduleExpressionError(`time zone '${name}' is not an IANA time zone name (e.g. 'America/Sao_Paulo')`)
  }
  return name
}

/** Whether a name is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try { resolveTimeZone(zone); return true } catch { return false }
}

/** The zone's offset from UTC at an instant, in ms (local = utc + offset). */
function offsetAt(ms: number, zone: string): number {
  if (zone === 'UTC') return 0
  const parts: Record<string, number> = {}
  for (const p of formatter(zone).formatToParts(new Date(ms))) if (p.type !== 'literal') parts[p.type] = Number(p.value)
  const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === 24 ? 0 : parts.hour, parts.minute, parts.second)
  return local - Math.floor(ms / 1000) * 1000
}

/** A local wall time (as UTC-based ms) in `zone`, at its first instant; null when a DST change skips it. */
function instantOf(wall: number, zone: string): number | null {
  if (zone === 'UTC') return wall
  const candidates = new Set([offsetAt(wall - DAY, zone), offsetAt(wall, zone), offsetAt(wall + DAY, zone)])
  let first: number | null = null
  for (const offset of candidates) {
    const instant = wall - offset
    if (offsetAt(instant, zone) === offset && (first === null || instant < first)) first = instant
  }
  return first
}

const wallOf = (instant: number, zone: string) => instant + offsetAt(instant, zone)

// ---- Occurrences ----

function matchesDay(p: ScheduleExpression, wall: Date): boolean {
  const day = p.days.has(wall.getUTCDate())
  const weekday = p.weekdays.has(wall.getUTCDay())
  if (p.dayOfMonthAny && p.dayOfWeekAny) return true
  if (p.dayOfMonthAny) return weekday
  if (p.dayOfWeekAny) return day
  return day || weekday
}

function nextAfterParsed(p: ScheduleExpression, after: number, zone: string): number {
  const wallAfter = wallOf(after, zone)
  let c = Math.floor((wallAfter + MINUTE) / MINUTE) * MINUTE
  const deadline = wallAfter + LOOKAHEAD_DAYS * DAY
  while (c <= deadline) {
    const d = new Date(c)
    if (!p.months.has(d.getUTCMonth() + 1)) {
      c = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    } else if (!matchesDay(p, d)) {
      c = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
    } else if (!p.hours.has(d.getUTCHours())) {
      c = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1)
    } else if (!p.minutes.has(d.getUTCMinutes())) {
      c += MINUTE
    } else {
      const instant = instantOf(c, zone)
      if (instant !== null && instant > after) return instant
      c += MINUTE
    }
  }
  throw invalid(p.text, `names no instant within ${LOOKAHEAD_DAYS} days of ${new Date(after).toISOString()}`)
}

/** The first instant strictly after `after` the expression fires at in `timeZone` (UTC when absent). */
export function nextAfter(expression: string | ScheduleExpression, after: Date, timeZone?: string | null): Date {
  return new Date(nextAfterParsed(parseSchedule(expression), after.getTime(), resolveTimeZone(timeZone)))
}

/** The next `count` instants (strictly increasing) the expression fires at after `after`. */
export function nextOccurrences(expression: string | ScheduleExpression, after: Date, count: number, timeZone?: string | null): Date[] {
  if (count < 0) throw new ScheduleExpressionError(`count must not be negative, got ${count}`)
  const p = parseSchedule(expression)
  const zone = resolveTimeZone(timeZone)
  const out: Date[] = []
  let cursor = after.getTime()
  for (let i = 0; i < count; i++) {
    cursor = nextAfterParsed(p, cursor, zone)
    out.push(new Date(cursor))
  }
  return out
}

/** The expression's shortest gap between consecutive runs in seconds, floored at one minute. */
export function minGapSeconds(expression: string | ScheduleExpression): number {
  const at = nextOccurrences(expression, new Date(GAP_EPOCH), GAP_SAMPLES)
  let min = Infinity
  for (let i = 1; i < at.length; i++) min = Math.min(min, (at[i].getTime() - at[i - 1].getTime()) / 1000)
  return Math.max(60, min)
}

// ---- Cadences ----

/** The shortest gap between runs of a cadence, in minutes. */
export function cadenceGapMinutes(cadence: Cadence): number {
  return cadence.kind === 'interval' ? cadence.everyMinutes : minGapSeconds(cadence.expression) / 60
}

/** Why a cadence can't be scheduled: a code the editor words, and the parser's detail. */
export interface CadenceProblem {
  code: 'interval' | 'expression' | 'timezone' | 'too-frequent'
  detail?: string
  /** For `too-frequent`: the shortest gap allowed, in minutes. */
  minMinutes?: number
}

/** What is wrong with a cadence, or null. `minMinutes` is the shortest gap allowed (app schedules: 15). */
export function cadenceProblem(cadence: Cadence, minMinutes = 1): CadenceProblem | null {
  if (cadence.kind === 'interval') {
    if (!Number.isInteger(cadence.everyMinutes) || cadence.everyMinutes < 1) return { code: 'interval' }
  } else {
    try { parseSchedule(cadence.expression) } catch (error) { return { code: 'expression', detail: (error as Error).message } }
    try { resolveTimeZone(cadence.timezone) } catch (error) { return { code: 'timezone', detail: (error as Error).message } }
    try { minGapSeconds(cadence.expression) } catch (error) { return { code: 'expression', detail: (error as Error).message } }
  }
  if (cadenceGapMinutes(cadence) < minMinutes) return { code: 'too-frequent', minMinutes }
  return null
}

/**
 * The next `count` planned runs of a cadence. An interval counts from
 * `anchor` (the schedule's next run, when the platform said) or else from
 * `from`; an expression is read in its own time zone.
 */
export function plannedRuns(cadence: Cadence, options: { from?: Date; anchor?: Date | null; count?: number } = {}): Date[] {
  const from = options.from ?? new Date()
  const count = options.count ?? 5
  if (cadence.kind === 'cron') return nextOccurrences(cadence.expression, from, count, cadence.timezone)
  const step = Math.max(1, cadence.everyMinutes) * MINUTE
  let first = options.anchor ? options.anchor.getTime() : from.getTime() + step
  // An anchor in the past moves forward by whole intervals.
  if (first <= from.getTime()) first += Math.ceil((from.getTime() - first + 1) / step) * step
  return Array.from({ length: count }, (_, i) => new Date(first + i * step))
}

/** The cadence a recipe's "Runs" asks for: by expression when `cron` is set (even blank), else every `everyMinutes`. */
export function runsCadence(runs: { everyMinutes: number; cron?: string | null; timezone?: string | null }): Cadence {
  return typeof runs.cron === 'string' ? { kind: 'cron', expression: runs.cron.trim(), timezone: runs.timezone || null } : { kind: 'interval', everyMinutes: runs.everyMinutes }
}
