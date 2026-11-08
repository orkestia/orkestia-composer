import { describe, expect, it } from 'vitest'
import type { CompositionRow } from '../ui/host'
import { mapSchema, PlatformCatalog, registrySource, titleFor } from './catalog'
import { fakeClient } from './__fixtures__/fakeClient'
import { memberBackend } from './member'

const ORG = '00000000000000000000000000000001'
const row = (name: string, version: number, status: CompositionRow['status'], updated = '2026-01-0' + version): CompositionRow => ({
  composition_uuid: `c-${name}-${version}`, name, version, status, workflow_type: `virtual.${name}${version}@${version}`, updated_at: updated,
})

describe('memberBackend', () => {
  it('lists lineages: newest version per name, the live one, every version type', async () => {
    const client = fakeClient().on('data.composition.list', (input) => ({
      compositions: input.status === 'active' ? [row('daily-report', 2, 'active'), row('notify', 1, 'active')]
        : input.status === 'draft' ? [row('daily-report', 3, 'draft')]
        : [row('daily-report', 1, 'archived')],
    }))
    const backend = memberBackend(client, ORG)
    const lineages = await backend.lineages()
    expect(lineages.map((l) => l.name)).toEqual(['daily-report', 'notify'])
    const report = lineages[0]
    expect(report.head.version).toBe(3)
    expect(report.live?.version).toBe(2)
    expect(report.versionOf).toEqual({ 'virtual.daily-report2@2': 2, 'virtual.daily-report3@3': 3, 'virtual.daily-report1@1': 1 })
    // Every call acts in the organization.
    expect(client.inputsOf('data.composition.list').every((i) => i.organization_uuid === ORG)).toBe(true)
    expect(client.inputsOf('data.composition.list').map((i) => i.status)).toEqual(['active', 'draft', 'archived'])
  })

  it('works without the archived versions', async () => {
    const client = fakeClient().on('data.composition.list', (input) => {
      if (input.status === 'archived') throw new Error('nope')
      return { compositions: input.status === 'active' ? [row('a', 1, 'active')] : [] }
    })
    expect((await memberBackend(client, ORG).lineages()).map((l) => l.name)).toEqual(['a'])
  })

  it('reads the org lazily and leaves it out when there is none', async () => {
    let org: string | null = null
    const client = fakeClient().on('composition.validate', () => ({ passed: true, errors: [], warnings: [], repairs: [] }))
    const backend = memberBackend(client, () => org)
    await backend.validate({ name: 'x', layers: [] })
    org = ORG
    await backend.validate({ name: 'x', layers: [] }, true)
    expect(client.inputsOf('composition.validate')).toEqual([
      { definition: { name: 'x', layers: [] }, include_dry_run: false },
      { organization_uuid: ORG, definition: { name: 'x', layers: [] }, include_dry_run: true },
    ])
  })

  it('saves, activates, archives and lists dependents with the platform verbs', async () => {
    const client = fakeClient()
      .on('composition.save', () => ({ composition_uuid: 'c1', workflow_type: 'virtual.c1@1', version: 1, status: 'active', validation_passed: true, validation_errors: [], validation_warnings: [] }))
      .on('composition.activate', () => ({ ok: true }))
      .on('composition.archive', () => ({ ok: true }))
      .on('data.composition.dependents', () => ({ name: 'a', stale_workflow_types: [], dependents: [], dependent_count: 0 }))
    const backend = memberBackend(client, ORG)
    expect((await backend.save('a', { name: 'a', layers: [] }, 'Does a', { title: 'A', expectedVersion: 3 })).version).toBe(1)
    await backend.activate('c1')
    await backend.archive('c1')
    expect((await backend.dependents('a')).dependent_count).toBe(0)
    // The member save is as it was: name, definition, tags, description; the editor's extra options aren't sent.
    expect(client.inputsOf('composition.save')[0]).toEqual({ organization_uuid: ORG, name: 'a', definition: { name: 'a', layers: [] }, tags: ['builder'], description: 'Does a' })
    expect(client.inputsOf('composition.activate')[0]).toEqual({ organization_uuid: ORG, composition_uuid: 'c1' })
    expect(client.inputsOf('composition.archive')[0]).toEqual({ organization_uuid: ORG, composition_uuid: 'c1' })
  })

  it('finds versions by name, head version and workflow type', async () => {
    const client = fakeClient()
      .on('data.composition.list', (input) => {
        if (input.name === 'a' && input.status === 'active') return { compositions: [] }
        if (input.name === 'a' && input.status === 'draft') return { compositions: [row('a', 1, 'draft'), row('a', 2, 'draft')] }
        if (input.name === 'a') return { compositions: [row('a', 4, 'archived'), row('b', 9, 'active')] }
        if (input.q) return { compositions: [row('a', 2, 'draft')] }
        return { compositions: [] }
      })
      .on('data.composition.get', (input) => ({ composition: { ...row('a', 2, 'draft'), composition_uuid: input.composition_uuid } }))
    const backend = memberBackend(client, ORG)
    expect((await backend.byName('a'))?.composition_uuid).toBe('c-a-2')
    expect(await backend.headVersion('a')).toBe(4)
    expect((await backend.byType('virtual.a2@2'))?.composition_uuid).toBe('c-a-2')
    expect(await backend.byType('virtual.nope@1')).toBeNull()
  })

  it('reads runs, history, facts and the run inspector', async () => {
    const client = fakeClient()
      .on('audit.workflow-run.query', (input) => ({
        items: input.workflow_type === 'virtual.a@1'
          ? [{ workflow_uuid: 'r1', workflow_type: 'virtual.a@1', state_name: 'completed', is_terminal: true, terminal_status: 'success', created_at_iso: '2026-01-01T00:00:00Z' }]
          : input.workflow_type === 'virtual.a@2'
            ? [{ workflow_uuid: 'r2', workflow_type: 'virtual.a@2', state_name: 'failed', is_terminal: true, terminal_status: 'failed', created_at_iso: '2026-01-02T00:00:00Z' }]
            : [{ workflow_uuid: 'r3', workflow_type: 'virtual.a@2', state_name: 'waiting', is_terminal: false, terminal_status: null, created_at_iso: '2026-01-03T00:00:00Z' }],
      }))
      .on('audit.workflow-run.get-history', () => ({ items: [{ state_name: 'start', is_terminal: false, terminal_status: null }] }))
      .on('schedule.list', () => ({ schedules: [{ schedule_uuid: 's1', name: 'a', target_workflow_type: 'virtual.a@2', interval_minutes: 60, active: false }] }))
      .onGet(/run-inspector$/, () => ({ workflow_id: 'r1', layers: [] }))
    const backend = memberBackend(client, ORG)
    expect((await backend.runs(['virtual.a@1', 'virtual.a@2'])).map((r) => r.workflow_uuid)).toEqual(['r2', 'r1'])
    expect(client.inputsOf('audit.workflow-run.query').at(-1)).toMatchObject({ workflow_type: 'virtual.a@2', limit: 25, offset: 0 })
    await backend.runs(['virtual.a@1'], 5, 'failed')
    expect(client.inputsOf('audit.workflow-run.query').at(-1)).toMatchObject({ terminal_status: 'failed', limit: 5 })
    expect(await backend.history('r1')).toHaveLength(1)
    const facts = await backend.facts()
    expect(facts.schedules.get('virtual.a@2')).toBe('paused')
    // A run still waiting says nothing about how it last ended.
    expect(facts.lastRuns.get('virtual.a@2')).toBeUndefined()
    expect(await backend.inspect!('r1')).toMatchObject({ workflow_id: 'r1' })
    expect(client.gets).toContain('/api/workflows/r1/run-inspector')
  })

  it('manages schedules, by interval or by time expression', async () => {
    const client = fakeClient()
      .on('schedule.list', () => ({ schedules: [{ schedule_uuid: 's1', target_workflow_type: 'virtual.a@1' }, { schedule_uuid: 's2', target_workflow_type: 'virtual.b@1' }] }))
      .on('schedule.create', (input) => ({ schedule_uuid: 's3', ...input }))
      .on('schedule.update', (input) => input)
      .on('schedule.pause', () => ({})).on('schedule.resume', () => ({})).on('schedule.delete', () => ({}))
    const { schedules } = memberBackend(client, ORG)
    expect((await schedules.list(['virtual.a@1'])).map((s) => s.schedule_uuid)).toEqual(['s1'])
    await schedules.create('virtual.a@1', 30, 'A', { x: 1 })
    await schedules.create('virtual.a@1', { kind: 'cron', expression: '0 6 * * 1-5', timezone: 'Europe/Madrid' }, 'A', {})
    expect(client.inputsOf('schedule.create')).toEqual([
      { organization_uuid: ORG, target_workflow_type: 'virtual.a@1', interval_minutes: 30, name: 'A', initial_data: { x: 1 }, active: true },
      { organization_uuid: ORG, target_workflow_type: 'virtual.a@1', schedule_expression: '0 6 * * 1-5', timezone: 'Europe/Madrid', name: 'A', initial_data: {}, active: true },
    ])
    await schedules.update('s1', { interval_minutes: 15 })
    await schedules.setActive('s1', false)
    await schedules.setActive('s1', true)
    await schedules.remove('s1')
    expect(client.calls.map((c) => c.type).slice(-4)).toEqual(['schedule.update', 'schedule.pause', 'schedule.resume', 'schedule.delete'])
  })

  it('switches off what the client can’t do', async () => {
    const bare = memberBackend(fakeClient({ withGet: false }), ORG)
    expect(bare.inspect).toBeUndefined()
    expect(bare.fieldOptions).toBeUndefined()
    expect(await bare.canFilterByStep!()).toBe(false)
    const client = fakeClient({ withPost: true }).onGet('/api/workflows/types/data.composition.list/schema', () => ({ fields: [{ name: 'uses_workflow_type' }] }))
    const full = memberBackend(client, ORG)
    expect(await full.canFilterByStep!()).toBe(true)
    expect(await full.fieldOptions!('slack.message.send', { text: 'hi' })).toHaveLength(1)
    expect(client.posts[0]).toEqual({ path: '/api/workflows/types/slack.message.send/field-options', body: { partial_inputs: { organization_uuid: ORG, text: 'hi' }, include_optional: true } })
  })
})

// Trimmed from a schema response.
const slackSend = {
  description: 'Send a Slack message with an organization-scoped Slack connection.',
  read_only: false,
  fields: [
    { name: 'organization_uuid', type: 'uuid', required: true, source: { kind: 'context', ref: 'organization_uuid' } },
    { name: 'connection_uuid', type: 'uuid', required: true, description: 'Slack connection UUID', source: { kind: 'workflow', ref: 'connection.query' } },
    { name: 'channel', type: 'string', required: true, source: { kind: 'workflow', ref: 'slack.channel.list' } },
    { name: 'text', type: 'string', required: true },
    { name: 'workflow_run_id', type: 'string', required: false },
  ],
  outputs: [
    { name: 'channel', type: 'string', description: 'Slack channel id that received the message' },
    { name: 'message_ts', type: 'string' },
    { name: 'failure_reason', type: 'string' },
    { name: 'error_type', type: 'string' },
    { name: 'workflow_run_id', type: 'string' },
  ],
}

describe('the platform catalog', () => {
  it('maps a schema to an entry', () => {
    const e = mapSchema('slack.message.send', slackSend, { apps: { slack: 'Slack' } })
    expect(e.title).toBe('Send a Slack message')
    expect(e.app).toBe('Slack')
    expect(e.readOnly).toBe(false)
    expect(e.inputs.map((f) => f.name)).toEqual(['organization_uuid', 'connection_uuid', 'channel', 'text'])
    expect(e.inputs[0].automatic).toBe(true)
    expect(e.inputs[1].source).toEqual({ kind: 'workflow', ref: 'connection.query' })
    expect(e.outputs.map((f) => f.name)).toEqual(['channel', 'message_ts'])
  })

  it('titles types from their description when not curated', () => {
    expect(titleFor('x.compare', 'Compare two values with one operator, emitting a boolean result')).toBe('Compare two values')
    expect(titleFor('registry.image.resolve', '')).toBe('Resolve image')
    expect(titleFor('example.notify.send', '', { titles: { 'example.notify.send': 'Notify the team' } })).toBe('Notify the team')
  })

  it('loads the registry once, schemas on demand, and tells the editor', async () => {
    const client = fakeClient()
      .onGet(/\/schema$/, (path) => (path.includes('nope') ? { error: 'not found' } : slackSend))
      .onGet(/^\/api\/workflows\/types\?/, () => ({ workflows: [{ name: 'slack.message.send', description: slackSend.description, read_only: false, featured: true }], has_more: false }))
    const cat = new PlatformCatalog(registrySource(client.get!), { apps: { slack: 'Slack' } })
    let bumps = 0
    cat.subscribe(() => bumps++)
    expect(cat.get('slack.message.send')).toBeUndefined()
    await cat.ensure(['slack.message.send', 'slack.message.send', 'nope.type'])
    expect(cat.get('slack.message.send')?.title).toBe('Send a Slack message')
    expect(cat.isMissing('nope.type')).toBe(true)
    await cat.loadList()
    expect(cat.search('slack').map((e) => e.type)).toEqual(['slack.message.send'])
    expect(cat.search('', { readOnly: true })).toEqual([])
    expect(cat.search('', { app: 'Slack', readOnly: false }).map((e) => e.type)).toEqual(['slack.message.send'])
    expect(cat.apps()).toEqual(['Slack'])
    expect(client.gets).toHaveLength(3)
    expect(bumps).toBeGreaterThan(0)
    expect(memberBackend(client, ORG).catalog()).toBeInstanceOf(PlatformCatalog)
  })
})
