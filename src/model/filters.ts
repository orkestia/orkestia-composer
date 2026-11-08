// Finding a workflow in the list: words to search for, plus filters on what
// the platform knows about each one (status, schedule, last run, check, tags).
// Pure: the list view feeds it the facts it loaded.

export type StatusFacet = 'live' | 'draft' | 'new' | 'edited'
export type RunsFacet = 'any' | 'scheduled' | 'paused' | 'manual'
export type HealthFacet = 'any' | 'check' | 'run'
export type SortOrder = 'recent' | 'name' | 'steps'

export interface WorkflowFilter {
  text: string
  status: StatusFacet[]
  runs: RunsFacet
  health: HealthFacet
  tags: string[]
  /** A step type the workflow must use (needs the platform's list filter). */
  usesStep: string | null
  sort: SortOrder
}

export const emptyFilter: WorkflowFilter = { text: '', status: [], runs: 'any', health: 'any', tags: [], usesStep: null, sort: 'recent' }

/** What the list knows about one workflow. */
export interface FilterSubject {
  key: string
  title: string
  status: 'new' | 'draft' | 'live'
  dirty: boolean
  description: string
  tags: string[]
  workflowTypes: string[]
  ids: string[]
  stepCount: number
  updatedAt: string | null
  checkFails: boolean
  schedule: 'active' | 'paused' | null
  lastRun: 'success' | 'failed' | 'running' | null
}

export function terms(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

export function matches(s: FilterSubject, f: WorkflowFilter, usingStep: Set<string> | null = null): boolean {
  const words = terms(f.text)
  if (words.length) {
    const hay = [s.title, s.key, s.description, ...s.tags, ...s.workflowTypes, ...s.ids].join(' ').toLowerCase()
    if (!words.every((w) => hay.includes(w))) return false
  }
  if (f.status.length && !f.status.some((st) => (st === 'edited' ? s.dirty && s.status !== 'new' : s.status === st))) return false
  if (f.runs === 'scheduled' && s.schedule !== 'active') return false
  if (f.runs === 'paused' && s.schedule !== 'paused') return false
  if (f.runs === 'manual' && s.schedule !== null) return false
  if (f.health === 'check' && !s.checkFails) return false
  if (f.health === 'run' && s.lastRun !== 'failed') return false
  if (f.tags.length && !f.tags.every((t) => s.tags.includes(t))) return false
  if (f.usesStep && usingStep && !usingStep.has(s.key)) return false
  return true
}

export function sortSubjects<T extends FilterSubject>(list: T[], order: SortOrder): T[] {
  const out = [...list]
  if (order === 'name') out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  else if (order === 'steps') out.sort((a, b) => b.stepCount - a.stepCount || a.title.localeCompare(b.title))
  else out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  return out
}

/** How many workflows each choice would show, given the other filters. */
export function facetCounts(subjects: FilterSubject[], f: WorkflowFilter, usingStep: Set<string> | null = null) {
  const count = (patch: Partial<WorkflowFilter>) => subjects.filter((s) => matches(s, { ...f, ...patch }, usingStep)).length
  return {
    status: Object.fromEntries((['live', 'draft', 'new', 'edited'] as StatusFacet[]).map((st) => [st, count({ status: [st] })])) as Record<StatusFacet, number>,
    runs: Object.fromEntries((['any', 'scheduled', 'paused', 'manual'] as RunsFacet[]).map((r) => [r, count({ runs: r })])) as Record<RunsFacet, number>,
    health: Object.fromEntries((['any', 'check', 'run'] as HealthFacet[]).map((h) => [h, count({ health: h })])) as Record<HealthFacet, number>,
    tags: Object.fromEntries(allTags(subjects).map((t) => [t, count({ tags: [...new Set([...f.tags, t])] })])),
  }
}

export function allTags(subjects: FilterSubject[]): string[] {
  return [...new Set(subjects.flatMap((s) => s.tags))].sort()
}

/** The filters in use, as removable labels (the text search is shown in its own box). */
export function activeFilters(f: WorkflowFilter, stepTitle: (type: string) => string = (t) => t): Array<{ id: string; label: string; clear: (f: WorkflowFilter) => WorkflowFilter }> {
  const out: Array<{ id: string; label: string; clear: (f: WorkflowFilter) => WorkflowFilter }> = []
  const statusLabel: Record<StatusFacet, string> = { live: 'Live', draft: 'Draft', new: 'Not saved', edited: 'Unsaved changes' }
  for (const st of f.status) out.push({ id: `status:${st}`, label: statusLabel[st], clear: (x) => ({ ...x, status: x.status.filter((y) => y !== st) }) })
  const runsLabel: Record<RunsFacet, string> = { any: '', scheduled: 'On a schedule', paused: 'Schedule paused', manual: 'Not scheduled' }
  if (f.runs !== 'any') out.push({ id: 'runs', label: runsLabel[f.runs], clear: (x) => ({ ...x, runs: 'any' }) })
  if (f.health === 'check') out.push({ id: 'health', label: 'Check finds problems', clear: (x) => ({ ...x, health: 'any' }) })
  if (f.health === 'run') out.push({ id: 'health', label: 'Last run failed', clear: (x) => ({ ...x, health: 'any' }) })
  for (const t of f.tags) out.push({ id: `tag:${t}`, label: `#${t}`, clear: (x) => ({ ...x, tags: x.tags.filter((y) => y !== t) }) })
  if (f.usesStep) out.push({ id: 'uses', label: `Uses “${stepTitle(f.usesStep)}”`, clear: (x) => ({ ...x, usesStep: null }) })
  return out
}

export function isFiltering(f: WorkflowFilter): boolean {
  return !!f.text.trim() || activeFilters(f).length > 0
}

/** Read a stored filter defensively: unknown or broken values fall back to the defaults. */
export function readFilter(raw: string | null): WorkflowFilter {
  try {
    const v = JSON.parse(raw ?? 'null') as Partial<WorkflowFilter> | null
    if (!v || typeof v !== 'object') return emptyFilter
    const pick = <T extends string>(x: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(x as T) ? (x as T) : fallback)
    return {
      text: typeof v.text === 'string' ? v.text : '',
      status: Array.isArray(v.status) ? v.status.filter((s): s is StatusFacet => ['live', 'draft', 'new', 'edited'].includes(s)) : [],
      runs: pick(v.runs, ['any', 'scheduled', 'paused', 'manual'] as const, 'any'),
      health: pick(v.health, ['any', 'check', 'run'] as const, 'any'),
      tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string') : [],
      usesStep: typeof v.usesStep === 'string' ? v.usesStep : null,
      sort: pick(v.sort, ['recent', 'name', 'steps'] as const, 'recent'),
    }
  } catch {
    return emptyFilter
  }
}
