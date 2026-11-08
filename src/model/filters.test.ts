import { describe, expect, it } from 'vitest'
import { activeFilters, allTags, emptyFilter, facetCounts, isFiltering, matches, readFilter, sortSubjects, type FilterSubject } from './filters'

const subject = (over: Partial<FilterSubject>): FilterSubject => ({
  key: 'x', title: 'X', status: 'live', dirty: false, description: '', tags: [], workflowTypes: [], ids: [],
  stepCount: 1, updatedAt: null, checkFails: false, schedule: null, lastRun: null, ...over,
})

const list = [
  subject({ key: 'triage-dispatch', title: 'Triage dispatch', description: 'Routes new tickets', tags: ['ops'], stepCount: 12, updatedAt: '2026-10-10T10:00:00Z', schedule: 'active', lastRun: 'success', workflowTypes: ['virtual.aaa@3'] }),
  subject({ key: 'builder-smoke-test', title: 'Builder smoke test', tags: ['builder'], stepCount: 3, updatedAt: '2026-10-12T22:10:00Z', schedule: 'paused', lastRun: 'failed', ids: ['00000001'] }),
  subject({ key: 'nightly-report', title: 'Nightly report', status: 'draft', tags: ['builder', 'ops'], stepCount: 5, updatedAt: '2026-10-11T08:00:00Z', checkFails: true }),
  subject({ key: 'local:w1', title: 'Untitled workflow', status: 'new', dirty: true }),
  subject({ key: 'invoice-sync', title: 'Invoice sync', dirty: true, stepCount: 7, updatedAt: '2026-09-01T00:00:00Z' }),
]
const keys = (f: Partial<typeof emptyFilter>, using: Set<string> | null = null) => list.filter((s) => matches(s, { ...emptyFilter, ...f }, using)).map((s) => s.key)

describe('workflow filters', () => {
  it('searches every word across name, description, tags, types and ids', () => {
    expect(keys({ text: 'tickets routes' })).toEqual(['triage-dispatch'])
    expect(keys({ text: 'OPS' })).toEqual(['triage-dispatch', 'nightly-report'])
    expect(keys({ text: 'virtual.aaa' })).toEqual(['triage-dispatch'])
    expect(keys({ text: '00000001' })).toEqual(['builder-smoke-test'])
    expect(keys({ text: 'nothing-like-this' })).toEqual([])
  })

  it('combines status choices with or, other filters with and', () => {
    expect(keys({ status: ['draft', 'new'] })).toEqual(['nightly-report', 'local:w1'])
    expect(keys({ status: ['edited'] })).toEqual(['invoice-sync'])
    expect(keys({ status: ['live'], tags: ['builder'] })).toEqual(['builder-smoke-test'])
  })

  it('filters by schedule, problems, tags and step use', () => {
    expect(keys({ runs: 'scheduled' })).toEqual(['triage-dispatch'])
    expect(keys({ runs: 'paused' })).toEqual(['builder-smoke-test'])
    expect(keys({ runs: 'manual' })).toEqual(['nightly-report', 'local:w1', 'invoice-sync'])
    expect(keys({ health: 'check' })).toEqual(['nightly-report'])
    expect(keys({ health: 'run' })).toEqual(['builder-smoke-test'])
    expect(keys({ tags: ['builder', 'ops'] })).toEqual(['nightly-report'])
    expect(keys({ usesStep: 'slack.message.send' }, new Set(['invoice-sync']))).toEqual(['invoice-sync'])
    // Until the platform answers, a step filter doesn't hide anything.
    expect(keys({ usesStep: 'slack.message.send' }, null)).toHaveLength(list.length)
  })

  it('sorts by recency, name or size', () => {
    expect(sortSubjects(list, 'recent').map((s) => s.key)).toEqual(['builder-smoke-test', 'nightly-report', 'triage-dispatch', 'invoice-sync', 'local:w1'])
    expect(sortSubjects(list, 'name').map((s) => s.title)[0]).toBe('Builder smoke test')
    expect(sortSubjects(list, 'steps')[0].key).toBe('triage-dispatch')
  })

  it('counts each choice given the other filters', () => {
    const counts = facetCounts(list, { ...emptyFilter, tags: ['ops'] })
    expect(counts.status).toEqual({ live: 1, draft: 1, new: 0, edited: 0 })
    expect(counts.runs.scheduled).toBe(1)
    expect(counts.tags).toEqual({ builder: 1, ops: 2 })
    expect(allTags(list)).toEqual(['builder', 'ops'])
  })

  it('lists active filters as removable labels', () => {
    const f = { ...emptyFilter, status: ['live' as const], runs: 'paused' as const, tags: ['ops'], usesStep: 'slack.message.send' }
    const chips = activeFilters(f, () => 'Send a Slack message')
    expect(chips.map((c) => c.label)).toEqual(['Live', 'Schedule paused', '#ops', 'Uses “Send a Slack message”'])
    expect(chips[2].clear(f).tags).toEqual([])
    expect(isFiltering(emptyFilter)).toBe(false)
    expect(isFiltering({ ...emptyFilter, text: ' a ' })).toBe(true)
  })

  it('reads stored filters defensively', () => {
    const f = { ...emptyFilter, text: 'x', status: ['draft' as const], sort: 'name' as const }
    expect(readFilter(JSON.stringify(f))).toEqual(f)
    expect(readFilter('{"status":["bogus","live"],"runs":"never","sort":7}')).toEqual({ ...emptyFilter, status: ['live'] })
    expect(readFilter('not json')).toEqual(emptyFilter)
    expect(readFilter(null)).toEqual(emptyFilter)
  })
})
