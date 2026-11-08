import { describe, expect, it } from 'vitest'
import {
  MIN_APP_SCHEDULE_MINUTES, cadenceProblem, isTimeZone, minGapSeconds, nextAfter, nextOccurrences, parseSchedule, plannedRuns, resolveTimeZone, runsCadence,
  ScheduleExpressionError,
} from './schedule'

const iso = (dates: Date[]) => dates.map((d) => d.toISOString())

describe('schedule expressions', () => {
  it('parses the five fields, lists, ranges and steps', () => {
    const p = parseSchedule(' */15  6-8 * * 1-5 ')
    expect(p.text).toBe('*/15 6-8 * * 1-5')
    expect([...p.minutes]).toEqual([0, 15, 30, 45])
    expect([...p.hours]).toEqual([6, 7, 8])
    expect([...p.weekdays]).toEqual([1, 2, 3, 4, 5])
    expect(p.dayOfMonthAny).toBe(true)
    expect(p.dayOfWeekAny).toBe(false)
    expect([...parseSchedule('0 0 * * 7').weekdays]).toEqual([0])
    expect([...parseSchedule('0,30 1-10/3 * * *').hours]).toEqual([1, 4, 7, 10])
  })

  it('refuses what the scheduler refuses', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', '1,,2 * * * *', '@daily', '0 9 * * MON']) {
      expect(() => parseSchedule(bad), bad).toThrow(ScheduleExpressionError)
    }
  })

  it('finds the next runs in UTC', () => {
    const at = new Date('2026-03-02T05:59:00Z') // a Monday
    expect(iso(nextOccurrences('0 6 * * 1-5', at, 3))).toEqual(['2026-03-02T06:00:00.000Z', '2026-03-03T06:00:00.000Z', '2026-03-04T06:00:00.000Z'])
    // Strictly after: a run at exactly `after` is not the next one.
    expect(nextAfter('0 6 * * *', new Date('2026-03-02T06:00:00Z')).toISOString()).toBe('2026-03-03T06:00:00.000Z')
    expect(iso(nextOccurrences('0 0 1 * *', new Date('2026-01-15T00:00:00Z'), 2))).toEqual(['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'])
  })

  it('matches either day field when both are restricted', () => {
    // The 13th, or any Friday.
    const days = nextOccurrences('0 12 13 * 5', new Date('2026-02-01T00:00:00Z'), 4).map((d) => d.toISOString().slice(0, 10))
    expect(days).toEqual(['2026-02-06', '2026-02-13', '2026-02-20', '2026-02-27'])
  })

  it('reads the fields in the schedule’s time zone', () => {
    // 06:00 in São Paulo (UTC-3, no DST) is 09:00 UTC.
    expect(iso(nextOccurrences('0 6 * * *', new Date('2026-06-01T00:00:00Z'), 2, 'America/Sao_Paulo'))).toEqual(['2026-06-01T09:00:00.000Z', '2026-06-02T09:00:00.000Z'])
    expect(nextAfter('30 8 * * *', new Date('2026-01-10T00:00:00Z'), 'Asia/Kolkata').toISOString()).toBe('2026-01-10T03:00:00.000Z')
  })

  it('skips a local time the DST change removes', () => {
    // New York springs forward on 2026-03-08: 02:30 does not exist that day.
    expect(iso(nextOccurrences('30 2 * * *', new Date('2026-03-07T00:00:00Z'), 3, 'America/New_York'))).toEqual([
      '2026-03-07T07:30:00.000Z', // EST, UTC-5
      '2026-03-09T06:30:00.000Z', // EDT, UTC-4; the 8th is skipped
      '2026-03-10T06:30:00.000Z',
    ])
  })

  it('runs a repeated local time once, at its first instant', () => {
    // New York falls back on 2026-11-01: 01:30 happens twice; it fires at the EDT one.
    expect(iso(nextOccurrences('30 1 * * *', new Date('2026-10-31T12:00:00Z'), 3, 'America/New_York'))).toEqual([
      '2026-11-01T05:30:00.000Z',
      '2026-11-02T06:30:00.000Z',
      '2026-11-03T06:30:00.000Z',
    ])
    // Every 30 minutes through the repeated hour: no instant fires twice, the repeated pass is skipped.
    const night = nextOccurrences('*/30 * * * *', new Date('2026-11-01T04:00:00Z'), 4, 'America/New_York')
    expect(iso(night)).toEqual(['2026-11-01T04:30:00.000Z', '2026-11-01T05:00:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-01T07:00:00.000Z'])
  })

  it('measures the shortest gap, in UTC', () => {
    expect(minGapSeconds('*/15 * * * *')).toBe(900)
    expect(minGapSeconds('0,5 9 * * *')).toBe(300)
    expect(minGapSeconds('0 6 * * *')).toBe(86_400)
    expect(minGapSeconds('* * * * *')).toBe(60)
  })

  it('refuses an expression that never fires', () => {
    expect(() => nextAfter('0 0 31 2 *', new Date('2026-01-01T00:00:00Z'))).toThrow(/names no instant/)
  })

  it('knows IANA time zones', () => {
    expect(resolveTimeZone(undefined)).toBe('UTC')
    expect(resolveTimeZone(' utc ')).toBe('UTC')
    expect(resolveTimeZone('Europe/Madrid')).toBe('Europe/Madrid')
    expect(isTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(() => resolveTimeZone('Mars/Olympus_Mons')).toThrow(ScheduleExpressionError)
  })
})

describe('cadences', () => {
  it('holds app schedules to the 15-minute minimum', () => {
    expect(MIN_APP_SCHEDULE_MINUTES).toBe(15)
    expect(cadenceProblem({ kind: 'interval', everyMinutes: 15 }, MIN_APP_SCHEDULE_MINUTES)).toBeNull()
    expect(cadenceProblem({ kind: 'interval', everyMinutes: 14 }, MIN_APP_SCHEDULE_MINUTES)).toEqual({ code: 'too-frequent', minMinutes: 15 })
    expect(cadenceProblem({ kind: 'cron', expression: '*/15 * * * *', timezone: 'UTC' }, 15)).toBeNull()
    expect(cadenceProblem({ kind: 'cron', expression: '*/10 * * * *' }, 15)).toEqual({ code: 'too-frequent', minMinutes: 15 })
    // Two runs five minutes apart once a day is still too often.
    expect(cadenceProblem({ kind: 'cron', expression: '0,5 9 * * *' }, 15)?.code).toBe('too-frequent')
    expect(cadenceProblem({ kind: 'cron', expression: '*/10 * * * *' })).toBeNull()
  })

  it('names what is wrong', () => {
    expect(cadenceProblem({ kind: 'interval', everyMinutes: 0 })?.code).toBe('interval')
    expect(cadenceProblem({ kind: 'cron', expression: '0 6 * *' })?.code).toBe('expression')
    expect(cadenceProblem({ kind: 'cron', expression: '0 6 * * *', timezone: 'Nowhere/Town' })?.code).toBe('timezone')
    expect(cadenceProblem({ kind: 'cron', expression: '0 0 31 2 *' })?.code).toBe('expression')
  })

  it('plans the next five runs of an interval from its next run or from now', () => {
    const from = new Date('2026-05-01T10:00:00Z')
    expect(iso(plannedRuns({ kind: 'interval', everyMinutes: 60 }, { from, count: 2 }))).toEqual(['2026-05-01T11:00:00.000Z', '2026-05-01T12:00:00.000Z'])
    expect(iso(plannedRuns({ kind: 'interval', everyMinutes: 30 }, { from, anchor: new Date('2026-05-01T10:10:00Z') }))).toEqual([
      '2026-05-01T10:10:00.000Z', '2026-05-01T10:40:00.000Z', '2026-05-01T11:10:00.000Z', '2026-05-01T11:40:00.000Z', '2026-05-01T12:10:00.000Z',
    ])
    // A next run already past moves on by whole intervals.
    expect(plannedRuns({ kind: 'interval', everyMinutes: 30 }, { from, anchor: new Date('2026-05-01T09:10:00Z'), count: 1 })[0].toISOString()).toBe('2026-05-01T10:10:00.000Z')
    expect(plannedRuns({ kind: 'cron', expression: '0 6 * * *', timezone: 'Europe/Madrid' }, { from })).toHaveLength(5)
  })

  it('reads a recipe’s "Runs"', () => {
    expect(runsCadence({ everyMinutes: 60 })).toEqual({ kind: 'interval', everyMinutes: 60 })
    expect(runsCadence({ everyMinutes: 60, cron: ' 0 6 * * 1-5 ', timezone: 'Europe/Madrid' })).toEqual({ kind: 'cron', expression: '0 6 * * 1-5', timezone: 'Europe/Madrid' })
    expect(runsCadence({ everyMinutes: 60, cron: '' })).toEqual({ kind: 'cron', expression: '', timezone: null })
    expect(runsCadence({ everyMinutes: 60, cron: undefined })).toEqual({ kind: 'interval', everyMinutes: 60 })
  })
})
