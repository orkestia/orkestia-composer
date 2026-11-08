import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../ui/i18n'
import type { Json } from '../ui/host'
import { appBackend } from './app'
import { ComposerError, errorMessage, isComposerError, REFUSAL_CODES } from './errors'
import { publishWithRecovery } from './publish'
import { fakeClient, RunFailed, type FakeClient } from './__fixtures__/fakeClient'
import { findEntryPoints, readExposed, refusalOf } from './wire'

const APP = '0123456789ab'
const WS = 'ws-00000000000000000000000000000001'
const ep = (key: string) => `virtual.${key.replace(/-/g, '')}0000000000000000000000@1`
const KEYS = ['validate', 'list', 'get', 'catalog', 'save-draft', 'publish', 'archive', 'publish-status']

/** The app's exposed list, as the end user's types list shows it. */
function exposedList(keys = KEYS, app = APP) {
  return {
    workflows: [
      ...keys.map((k) => ({ name: ep(k), lineage_name: `composer-${k}-${app}` })),
      { name: 'virtual.11111111111111111111111111111111@3', lineage_name: 'composer-list-ffffffffffff' },
      { name: 'example.notify.send' },
    ],
  }
}

function client(keys = KEYS): FakeClient {
  return fakeClient().onGet(/^\/api\/workflows\/types/, () => exposedList(keys))
}

/** A failed run as the contract shapes it: "<CODE>: …" and `failure_details` in its output. */
const refused = (code: string, extra: Json = {}, text = 'refused') => new RunFailed(`${code}: ${text}`, { failure_details: { code, ...extra } })

const typeOf = (slug: string, version: number) => `virtual.${slug.replace(/-/g, '').padEnd(32, '0').slice(0, 32)}@${version}`

/** One lineage of `composition.app.list`. */
const lineage = (slug: string, headVersion: number, liveVersion: number | null) => ({
  lineage_name: `${WS}-${slug}`, slug, lineage_uuid: `l-${slug}`, orn: `orn:example:${slug}`, title: `Title of ${slug}`,
  status: liveVersion === headVersion ? 'live' : 'draft',
  head: { composition_uuid: `c-${slug}-${headVersion}`, version: headVersion, status: liveVersion === headVersion ? 'live' : 'draft' },
  live: liveVersion === null ? null : { composition_uuid: `c-${slug}-${liveVersion}`, version: liveVersion, workflow_type: typeOf(slug, liveVersion) },
  head_version: headVersion, live_version: liveVersion, live_workflow_type: liveVersion === null ? null : typeOf(slug, liveVersion),
  exposed: liveVersion !== null, author: { mine: true, display_name: 'Ana' }, step_count: 3, updated_at: `2026-02-0${headVersion}T00:00:00Z`,
})
const page = (lineages: unknown[], extra: Json = {}) => ({ lineages, count: lineages.length, view: 'workspace', capabilities: { read: true, run: true, publish: true }, ...extra })

/** `composition.app.get`'s composition. */
const composition = (slug: string, version: number, extra: Json = {}) => ({
  composition_uuid: `c-${slug}-${version}`, lineage_uuid: `l-${slug}`, lineage_name: `${WS}-${slug}`, slug, title: `Title of ${slug}`,
  version, status: 'live', workflow_type: typeOf(slug, version), orn: `orn:example:${slug}`, orn_pinned: `orn:example:${slug}@${version}`,
  head_version: version, live_version: version, exposed: true, author: { mine: true, display_name: 'Ana' }, validation: null,
  created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', step_count: 2, definition: { name: slug, layers: [] }, ...extra,
})

afterEach(() => setLocale('en'))

describe('appBackend: entry points', () => {
  it('finds them by name in the app’s exposed list', async () => {
    const backend = appBackend(client())
    const found = await backend.entryPoints()
    for (const k of KEYS) expect(found[k as keyof typeof found]).toBe(ep(k))
    // publish and publish-status don't shadow each other, and another app's list is ignored.
    expect(found.publish).not.toBe(found['publish-status'])
    expect(found.list).toBe(ep('list'))
  })

  it('reads lineage names from the fields an exposed composition may carry', () => {
    const exposed = readExposed({ workflows: [{ workflow_type: 'virtual.a@1', title: `composer-get-${APP}` }, { name: `composer-archive-${APP}` }] })
    expect(findEntryPoints(exposed)).toEqual({ get: 'virtual.a@1', archive: `composer-archive-${APP}` })
    expect(findEntryPoints(exposed, 'ffffffffffff')).toEqual({})
    expect(findEntryPoints([{ name: `composer-publish-status-${APP}`, workflow_type: 't' }, { name: 'composer-unknown-0123456789ab', workflow_type: 'u' }])).toEqual({ 'publish-status': 't' })
  })

  it('takes them from the host instead, and picks one app among several', async () => {
    const c = fakeClient().on('x.list', () => ({ lineages: [] }))
    await appBackend(c, { entryPoints: Object.fromEntries(KEYS.map((k) => [k, k === 'list' ? 'x.list' : `x.${k}`])) }).lineages()
    expect(c.gets).toEqual([])
    const both = fakeClient().onGet(/types/, () => ({ workflows: [...exposedList(KEYS, 'aaaaaaaaaaaa').workflows, ...exposedList(['list'], 'bbbbbbbbbbbb').workflows] }))
    expect((await appBackend(both, { app12: 'bbbbbbbbbbbb' }).entryPoints()).list).toBe(ep('list'))
  })

  it('says the app isn’t set up when an entry point is missing', async () => {
    const backend = appBackend(client(['list', 'get']))
    await expect(backend.validate({ name: 'x', layers: [] })).rejects.toMatchObject({ code: 'ENTRY_POINT_MISSING' })
  })
})

describe('appBackend: compositions', () => {
  it('lists the workspace’s lineages, page by page, with titles', async () => {
    const c = client().on(ep('list'), (input) => (input.cursor ? page([lineage('b', 1, 1)]) : page([lineage('a', 2, 1)], { next_cursor: 'p2' })))
    const lineages = await appBackend(c).lineages()
    expect(c.inputsOf(ep('list'))).toEqual([{ limit: 200 }, { limit: 200, cursor: 'p2' }])
    // Newest first.
    expect(lineages.map((l) => l.name)).toEqual([`${WS}-a`, `${WS}-b`])
    const a = lineages.find((l) => l.name === `${WS}-a`)!
    // The draft head's type is not in the list; the live one's is.
    expect(a.head).toMatchObject({ composition_uuid: 'c-a-2', version: 2, status: 'draft', title: 'Title of a', step_count: 3, workflow_type: '', orn: null })
    expect(a.live).toMatchObject({ composition_uuid: 'c-a-1', version: 1, status: 'active', workflow_type: typeOf('a', 1) })
    expect(a.versionOf).toEqual({ [typeOf('a', 1)]: 1 })
    const b = lineages.find((l) => l.name === `${WS}-b`)!
    expect(b.head).toBe(b.live)
  })

  it('marks a live lineage the workspace is not offered as unexposed', async () => {
    const c = client().on(ep('list'), () => page([
      { ...lineage('a', 1, 1), availability: 'unexposed' },
      { ...lineage('b', 1, 1), availability: 'available' },
      { ...lineage('c', 1, null), availability: 'unexposed' },
      lineage('d', 1, 1),
    ]))
    const byName = new Map((await appBackend(c).lineages()).map((l) => [l.name, l]))
    expect(byName.get(`${WS}-a`)?.unexposed).toBe(true)
    expect(byName.get(`${WS}-b`)?.unexposed).toBeUndefined()
    // Only a live version can be unexposed; an older platform without the field reads as available.
    expect(byName.get(`${WS}-c`)?.unexposed).toBeUndefined()
    expect(byName.get(`${WS}-d`)?.unexposed).toBeUndefined()
  })

  it('reads one version with its definition', async () => {
    const c = client().on(ep('get'), () => ({ composition: composition('a', 1), capabilities: { read: true, run: true, publish: true } }))
    expect(await appBackend(c).get('c-a-1')).toMatchObject({ composition_uuid: 'c-a-1', name: `${WS}-a`, title: 'Title of a', status: 'active', orn: null, orn_pinned: `orn:example:a@1`, definition: { name: 'a', layers: [] } })
    expect(c.inputsOf(ep('get'))).toEqual([{ composition_uuid: 'c-a-1' }])
  })

  it('reads a lineage by slug or lineage name, and its head version', async () => {
    const c = client().on(ep('get'), (i) => {
      if (i.slug === 'weekly-digest' || i.lineage_name === `${WS}-weekly-digest`) return { composition: composition('weekly-digest', 1, { head_version: 2 }) }
      throw refused('NOT_FOUND')
    })
    const backend = appBackend(c)
    expect((await backend.byName('weekly-digest'))?.name).toBe(`${WS}-weekly-digest`)
    expect((await backend.byName(`${WS}-weekly-digest`))?.composition_uuid).toBe('c-weekly-digest-1')
    expect(await backend.byName('other')).toBeNull()
    expect(await backend.headVersion('weekly-digest')).toBe(2)
    expect(await backend.headVersion('other')).toBeNull()
    expect(c.inputsOf(ep('get')).slice(0, 2)).toEqual([{ slug: 'weekly-digest' }, { lineage_name: `${WS}-weekly-digest` }])
    expect((await backend.byType(typeOf('weekly-digest', 1)))).toBeNull() // not listed yet
  })

  it('checks: publishable is passing, each finding is a problem, Test run asks for the dry run', async () => {
    const c = client().on(ep('validate'), () => ({
      passed: true, errors: [], warnings: ['w'], repair_suggestions: [], repairs: [], dry_run: { passed: true, errors: [], evaluated: true },
      authoring: { passed: false, evaluated: true, findings: [], codes: ['STEP_NOT_AUTHORABLE'], step_count: 1, step_types: ['example.notify.send'] },
      publishable: false, valid: false,
      findings: [{ code: 'STEP_NOT_AUTHORABLE', step_name: 'send', workflow_type: 'example.notify.send', message: 'example.notify.send is not in the authoring catalog' }],
    }))
    const backend = appBackend(c)
    const result = await backend.validate({ name: 'x', layers: [] }, true)
    expect(result).toMatchObject({ passed: false, warnings: ['w'], errors: ["Step 'send': example.notify.send is not in the authoring catalog"], dry_run: { passed: true, evaluated: true } })
    await backend.validate({ name: 'x', layers: [] })
    expect(c.inputsOf(ep('validate'))).toEqual([{ definition: { name: 'x', layers: [] }, include_dry_run: true }, { definition: { name: 'x', layers: [] } }])
  })

  it('saves drafts by slug (new) or lineage name (existing), with the expected version', async () => {
    const c = client().on(ep('save-draft'), (i) => ({
      composition_uuid: 'c-a-2', lineage_uuid: 'l-a', lineage_name: `${WS}-a`, slug: 'a', title: i.title, version: 2, head_version: 2, status: 'draft',
      workflow_type: typeOf('a', 2), validation_passed: true, validation_errors: [], validation_warnings: [],
    }))
    const backend = appBackend(c)
    const out = await backend.save('a', { name: 'a', layers: [] }, undefined, { title: 'A', expectedVersion: 0 })
    expect(out).toMatchObject({ status: 'draft', name: `${WS}-a`, version: 2, title: 'A', workflow_type: typeOf('a', 2), validation_passed: true })
    await backend.saveDraft({ lineage: `${WS}-a`, title: 'A', definition: { name: 'a', layers: [] }, expectedVersion: 2 })
    expect(c.inputsOf(ep('save-draft'))).toEqual([
      { slug: 'a', title: 'A', definition: { name: 'a', layers: [] }, expected_version: 0 },
      { lineage_name: `${WS}-a`, title: 'A', definition: { name: 'a', layers: [] }, expected_version: 2 },
    ])
  })

  it('archives a version', async () => {
    const c = client().on(ep('archive'), () => ({ composition_uuid: 'c-a-1', lineage_name: `${WS}-a`, version: 1, status: 'retired', previous_status: 'live', unexposed: true }))
    await appBackend(c).archive('c-a-1')
    expect(c.inputsOf(ep('archive'))).toEqual([{ composition_uuid: 'c-a-1' }])
  })

  it('serves the app’s authoring catalog: authorable steps in the picker, every schema known', async () => {
    const c = client().on(ep('catalog'), () => ({
      workflow_types: [
        {
          workflow_type: 'example.notify.send', name: 'Notify the team', description: 'Send a notification to the team', authorable: true,
          schema: {
            input_fields: [{ name: 'organization_uuid', type: 'uuid', required: true, default: null, description: '', server_controlled: true }, { name: 'text', type: 'string', required: true, default: null, description: 'What to say', server_controlled: false }],
            output_fields: [{ name: 'message_id', type: 'string' }],
          },
        },
        { workflow_type: 'example.admin.reset', name: 'example.admin.reset', description: 'Reset everything', authorable: false, reason: 'not end-user eligible', schema: { input_fields: [], output_fields: [] } },
      ],
      count: 2, limits: { steps: 40 },
    }))
    const catalog = appBackend(c).catalog()
    await catalog.loadList()
    expect(catalog.search('').map((e) => e.type)).toEqual(['example.notify.send'])
    await catalog.ensure(['example.notify.send', 'example.admin.reset', 'outside.the.catalog'])
    const notify = catalog.get('example.notify.send')!
    expect(notify.title).toBe('Notify the team')
    expect(notify.inputs.map((f) => [f.name, !!f.automatic])).toEqual([['organization_uuid', true], ['text', false]])
    expect(notify.outputs.map((f) => f.name)).toEqual(['message_id'])
    expect(catalog.get('example.admin.reset')?.title).toBe('Reset everything')
    expect(catalog.isMissing('outside.the.catalog')).toBe(true)
    // One read serves the list and every schema.
    expect(c.inputsOf(ep('catalog'))).toHaveLength(1)
  })
})

describe('appBackend: publishing', () => {
  const definition = { name: 'a', layers: [] }
  const receipt = { composition_uuid: 'c-a-1', lineage_uuid: 'l-a', lineage_name: `${WS}-a`, title: 'A', version: 1, workflow_type: 'virtual.a@1', orn_pinned: 'orn:example:a@1', published_at: '2026-02-01T00:00:00Z', request_uuid: 'r1' }
  const outcome = (status: string, extra: Json = {}) => ({
    request_uuid: 'r1', idempotency_key: 'k1', status, refusal_code: null, refusal: null, receipt: null, replayed: false,
    lineage_name: `${WS}-a`, expected_version: 0, created_at: '2026-02-01T00:00:00Z', finished_at: status === 'accepted' ? null : '2026-02-01T00:00:01Z', ...extra,
  })
  const input = { lineage: 'a', title: 'A', definition, expectedVersion: 0, idempotencyKey: 'k1' }

  it('sends the contract’s fields and reads the receipt', async () => {
    const c = client().on(ep('publish'), () => outcome('published', { receipt }))
    expect(await appBackend(c).publish(input)).toEqual(receipt)
    expect(c.inputsOf(ep('publish'))).toEqual([{ slug: 'a', title: 'A', definition, expected_version: 0, idempotency_key: 'k1' }])
  })

  it('reads a replayed outcome like the first', async () => {
    const c = client().on(ep('publish'), () => outcome('published', { receipt, replayed: true }))
    expect((await appBackend(c).publish(input)).version).toBe(1)
  })

  it('treats refused and failed as answers, typed', async () => {
    const c = client().on(ep('publish'), () => outcome('refused', { refusal_code: 'VERSION_CONFLICT', refusal: { code: 'VERSION_CONFLICT', message: 'expected_version 0 but head is 3', head_version: 3, expected_version: 0 } }))
    const error = await appBackend(c).publish(input).catch((e) => e)
    expect(isComposerError(error, 'VERSION_CONFLICT')).toBe(true)
    expect(error.headVersion).toBe(3)
    expect(error.retryable).toBe(false)
    const failed = client().on(ep('publish'), () => outcome('failed', { refusal_code: 'INTERNAL_ERROR', refusal: { code: 'INTERNAL_ERROR', message: 'boom' } }))
    await expect(appBackend(failed).publish(input)).rejects.toMatchObject({ code: 'INTERNAL_ERROR', retryable: false })
    const abandoned = client().on(ep('publish'), () => outcome('refused', { refusal_code: 'PUBLISH_ABANDONED', refusal: { code: 'PUBLISH_ABANDONED' } }))
    await expect(appBackend(abandoned).publish(input)).rejects.toMatchObject({ code: 'PUBLISH_ABANDONED', retryable: false })
  })

  it('polls while accepted, then reads the stored receipt', async () => {
    let checks = 0
    const c = client()
      .on(ep('publish'), () => outcome('accepted'))
      .on(ep('publish-status'), () => (++checks < 2 ? outcome('accepted') : outcome('published', { receipt })))
    expect(await publishWithRecovery(appBackend(c), input, { sleep: async () => {} })).toEqual(receipt)
    expect(c.inputsOf(ep('publish-status'))).toEqual([{ idempotency_key: 'k1' }, { idempotency_key: 'k1' }])
  })

  it('checks the status after a timeout before anyone retries', async () => {
    let published = false
    const c = client()
      .on(ep('publish'), () => { published = true; throw new Error('timed out waiting for the workflow to finish') })
      .on(ep('publish-status'), () => (published ? outcome('published', { receipt }) : outcome('accepted')))
    expect(await publishWithRecovery(appBackend(c), input, { sleep: async () => {} })).toEqual(receipt)
  })

  it('says it is still pending (retryable, same key) when the status doesn’t settle', async () => {
    const c = client().on(ep('publish'), () => outcome('accepted')).on(ep('publish-status'), () => outcome('accepted'))
    const error = await publishWithRecovery(appBackend(c), input, { attempts: 3, sleep: async () => {} }).catch((e) => e)
    expect(error).toBeInstanceOf(ComposerError)
    expect(error).toMatchObject({ code: 'PUBLISH_PENDING', retryable: true })
    expect(c.inputsOf(ep('publish-status'))).toHaveLength(3)
  })

  it('ends the attempt with the refusal the status reports', async () => {
    const c = client()
      .on(ep('publish'), () => { throw new Error('timed out') })
      .on(ep('publish-status'), () => outcome('refused', { refusal_code: 'QUOTA_EXCEEDED', refusal: { code: 'QUOTA_EXCEEDED', limit: 25 } }))
    const error = await publishWithRecovery(appBackend(c), input, { sleep: async () => {} }).catch((e) => e)
    expect(error).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false, detail: '25' })
  })

  it('reads refusals raised before the request exists', async () => {
    const c = client().on(ep('publish'), () => { throw refused('WORKSPACE_REQUIRED', {}, 'metadata.end_user.app_organization_uuid is required') })
    const error = await appBackend(c).publish(input).catch((e) => e)
    expect(error).toMatchObject({ code: 'WORKSPACE_REQUIRED', detail: 'metadata.end_user.app_organization_uuid is required' })
  })
})

describe('refusals', () => {
  for (const code of REFUSAL_CODES) {
    it(`types ${code} with a message in en, pt-BR and es`, async () => {
      const c = client().on(ep('validate'), () => { throw refused(code) })
      const error = await appBackend(c).validate({ name: 'x', layers: [] }).catch((e) => e)
      expect(error).toBeInstanceOf(ComposerError)
      expect(error.code).toBe(code)
      const en = errorMessage(code)
      expect(error.message).toBe(`${en} (refused)`)
      setLocale('pt-BR')
      const pt = errorMessage(code)
      setLocale('es')
      const es = errorMessage(code)
      expect(new Set([en, pt, es]).size).toBe(3)
    })
  }

  it('reads failure_details and the "<CODE>: " message', () => {
    const cap = refusalOf(refused('CAPABILITY_REQUIRED', { capability: 'compositions:publish' }))
    expect(cap).toMatchObject({ code: 'CAPABILITY_REQUIRED', detail: 'compositions:publish', data: { capability: 'compositions:publish' } })
    const quota = refusalOf(refused('QUOTA_EXCEEDED', { limit: 25, maximum: 25 }))
    expect(quota.detail).toBe('25')
    const gate = refusalOf(refused('STEP_NOT_AUTHORABLE', { findings: [{ code: 'STEP_NOT_AUTHORABLE', step_name: 'send', message: 'not in the catalog' }] }))
    expect(gate.detail).toBe('send: not in the catalog')
    const conflict = refusalOf(refused('VERSION_CONFLICT', { head_version: 4, expected_version: 2 }))
    expect(conflict.headVersion).toBe(4)
    expect(conflict.data.expected_version).toBe(2)
    // The message alone, and failure_details straight on the error, are enough.
    expect(refusalOf(new Error('RESERVED_NAME: ws- names are reserved'))).toMatchObject({ code: 'RESERVED_NAME', detail: 'ws- names are reserved' })
    expect(refusalOf(Object.assign(new Error('x'), { failure_details: { code: 'organization_mismatch' } })).code).toBe('organization_mismatch')
    expect(refusalOf(new Error('end_user_principal_required: sign in')).code).toBe('end_user_principal_required')
    expect(refusalOf(new Error('schedule_not_found')).code).toBe('NOT_FOUND')
    expect(refusalOf(new Error('schedule_interval_too_short: at most every 15 minutes')).code).toBe('SCHEDULE_TOO_FREQUENT')
    expect(refusalOf(Object.assign(new Error('slow'), { name: 'TimeoutError' })).code).toBe('TIMEOUT')
    // A code named in the middle of a message isn't one.
    expect(refusalOf(new Error('the step said NOT_FOUND somewhere')).code).toBe('UNKNOWN')
    expect(refusalOf(new Error('the engine is on fire'))).toMatchObject({ code: 'UNKNOWN', message: 'the engine is on fire', retryable: false })
  })
})

describe('appBackend: read-only mode', () => {
  it('follows the workspace’s capabilities from the list', async () => {
    const c = client().on(ep('list'), () => page([], { view: 'own', capabilities: { read: true, run: false, publish: false } }))
    const backend = appBackend(c)
    expect(backend.capabilities).toEqual({ publish: true, run: true, draft: true }) // not known yet
    await backend.lineages()
    expect(backend.capabilities).toEqual({ publish: false, run: false, draft: false })
  })

  it('follows them from get too', async () => {
    const c = client().on(ep('get'), () => ({ composition: composition('a', 1), capabilities: { read: true, run: true, publish: false } }))
    const backend = appBackend(c)
    await backend.get('c-a-1')
    expect(backend.capabilities).toEqual({ publish: false, run: true, draft: false })
  })

  it('can’t publish when the app offers no save or publish entry point', async () => {
    const c = client(['list', 'get', 'validate']).on(ep('list'), () => page([]))
    const backend = appBackend(c)
    await backend.lineages()
    expect(backend.capabilities).toEqual({ publish: false, run: true, draft: false })
  })

  it('turns read-only when publishing is refused for lack of the capability', async () => {
    const c = client().on(ep('publish'), () => { throw refused('CAPABILITY_REQUIRED', { capability: 'compositions:publish' }) })
    const backend = appBackend(c)
    await backend.publish({ lineage: 'a', title: 'A', definition: { name: 'a', layers: [] }, expectedVersion: 0, idempotencyKey: 'k' }).catch(() => {})
    expect(backend.capabilities.publish).toBe(false)
  })

  it('takes what the host says over the workspace', async () => {
    const c = client().on(ep('list'), () => page([]))
    const backend = appBackend(c, { capabilities: { publish: false, run: false } })
    await backend.lineages()
    expect(backend.capabilities).toEqual({ publish: false, run: false, draft: false })
  })

  it('a member who may draft but not publish edits and saves drafts (compositions:draft)', async () => {
    const c = client().on(ep('list'), () => page([], { view: 'published', capabilities: { read: true, run: true, draft: true, publish: false } }))
    const backend = appBackend(c)
    await backend.lineages()
    expect(backend.capabilities).toEqual({ publish: false, run: true, draft: true })
  })

  it('publish implies draft, for platforms from before the draft capability', async () => {
    const c = client().on(ep('list'), () => page([], { capabilities: { read: true, run: true, publish: true } }))
    const backend = appBackend(c)
    await backend.lineages()
    expect(backend.capabilities.draft).toBe(true)
  })

  it('a save refused on someone else’s lineage (needs publish) keeps drafts on; one refused for drafting turns them off', async () => {
    const save = { lineage: `${WS}-theirs`, title: 'T', definition: { name: 'theirs', layers: [] }, expectedVersion: 1 }
    const onTheirs = appBackend(client().on(ep('save-draft'), () => { throw refused('CAPABILITY_REQUIRED', { capability: 'compositions:publish' }) }))
    await onTheirs.saveDraft(save).catch(() => {})
    expect(onTheirs.capabilities.draft).toBe(true)
    // The platform currently drops failure_details on composer refusals: the capability is then read from the message.
    const byMessage = appBackend(client().on(ep('save-draft'), () => { throw new RunFailed("CAPABILITY_REQUIRED: changing it needs the 'compositions:publish' capability", {}) }))
    await byMessage.saveDraft(save).catch(() => {})
    expect(byMessage.capabilities.draft).toBe(true)
    const noDrafts = appBackend(client().on(ep('save-draft'), () => { throw refused('CAPABILITY_REQUIRED', { capability: 'compositions:draft' }) }))
    await noDrafts.saveDraft(save).catch(() => {})
    expect(noDrafts.capabilities.draft).toBe(false)
  })

  it('has no step-by-step run view', () => {
    expect(appBackend(client()).inspect).toBeUndefined()
  })
})

describe('appBackend: schedules and runs', () => {
  const live = { workflow_type: typeOf('a', 2) }
  const redacted = (extra: Json = {}) => ({
    schedule_uuid: 's1', name: 'Weekly digest', target: { kind: 'composition', name: `${WS}-a`, version: 2, follows_head: false },
    interval_seconds: 3600, schedule_expression: null, timezone: null, active: true, next_run_at: '2026-02-02T09:00:00Z', mine: true, ...extra,
  })

  function scheduled() {
    return client()
      .on(ep('list'), () => page([lineage('a', 2, 2)]))
      .on('schedule.app.list', () => ({ schedules: [redacted(), redacted({ schedule_uuid: 's2', target: { kind: 'composition', name: `${WS}-other`, version: 1 } })] }))
      .on('schedule.app.create', (input) => ({ schedule_uuid: 's3', schedule: redacted({ schedule_uuid: 's3', schedule_expression: input.schedule_expression ?? null, timezone: input.timezone ?? null }) }))
      .on('schedule.app.update', () => ({ schedule: redacted({ interval_seconds: 1800 }) }))
      .on('schedule.app.pause', () => ({})).on('schedule.app.resume', () => ({})).on('schedule.app.delete', () => ({}))
      .on('schedule.app.runs', () => ({ runs: [{ workflow_id: 'wf_s1', status: 'completed', started_at: '2026-02-02T09:00:01Z', finished_at: '2026-02-02T09:00:05Z', terminal_status: 'success' }] }))
  }

  it('lists the schedules of a version, by lineage and version', async () => {
    const backend = appBackend(scheduled())
    await backend.lineages()
    const list = await backend.schedules.list([live.workflow_type])
    expect(list).toEqual([expect.objectContaining({ schedule_uuid: 's1', target_workflow_type: live.workflow_type, interval_minutes: 60, active: true, next_run_at: '2026-02-02T09:00:00Z' })])
    expect(backend.schedules.minIntervalMinutes).toBe(15)
  })

  it('creates by interval or by time expression, and refuses anything under 15 minutes before calling', async () => {
    const c = scheduled()
    const { schedules } = appBackend(c)
    await schedules.create(live.workflow_type, 60, 'Digest', { team: 'ops' })
    const cron = await schedules.create(live.workflow_type, { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'America/Sao_Paulo' }, 'Digest', {})
    expect(cron).toMatchObject({ schedule_expression: '0 9 * * 1-5', timezone: 'America/Sao_Paulo' })
    expect(c.inputsOf('schedule.app.create')).toEqual([
      { target_workflow_type: live.workflow_type, name: 'Digest', initial_data: { team: 'ops' }, active: true, interval_minutes: 60 },
      { target_workflow_type: live.workflow_type, name: 'Digest', initial_data: {}, active: true, schedule_expression: '0 9 * * 1-5', timezone: 'America/Sao_Paulo' },
    ])
    await expect(schedules.create(live.workflow_type, 10, 'Too often', {})).rejects.toMatchObject({ code: 'SCHEDULE_TOO_FREQUENT' })
    await expect(schedules.create(live.workflow_type, { kind: 'cron', expression: '*/5 * * * *' }, 'Too often', {})).rejects.toMatchObject({ code: 'SCHEDULE_TOO_FREQUENT' })
    await expect(schedules.update('s1', { interval_minutes: 5 })).rejects.toMatchObject({ code: 'SCHEDULE_TOO_FREQUENT' })
    expect(c.inputsOf('schedule.app.create')).toHaveLength(2)
    expect(c.inputsOf('schedule.app.update')).toHaveLength(0)
  })

  it('updates, pauses, resumes and deletes through schedule.app', async () => {
    const c = scheduled()
    const { schedules } = appBackend(c)
    expect((await schedules.update('s1', { interval_minutes: 30, name: undefined })).interval_minutes).toBe(30)
    expect(c.inputsOf('schedule.app.update')).toEqual([{ schedule_uuid: 's1', interval_minutes: 30 }])
    await schedules.setActive('s1', false)
    await schedules.setActive('s1', true)
    await schedules.remove('s1')
    expect(c.calls.map((x) => x.type).slice(-3)).toEqual(['schedule.app.pause', 'schedule.app.resume', 'schedule.app.delete'])
  })

  it('goes through the app’s composer-schedule-* entry points when it offers them', async () => {
    // An end-user token may start only exposed compositions: the verbs themselves are refused.
    const SCHEDULE_KEYS = ['schedule-list', 'schedule-runs', 'schedule-create', 'schedule-update', 'schedule-pause', 'schedule-resume', 'schedule-delete']
    const notExposed = () => { throw refused('NOT_EXPOSED_TO_END_USERS') }
    const step = (key: string, out: Json) => ({ [key.replace(/-/g, '_')]: out }) // the output, nested under the step
    const c = fakeClient().onGet(/^\/api\/workflows\/types/, () => exposedList([...KEYS, ...SCHEDULE_KEYS]))
      .on(ep('list'), () => page([lineage('a', 2, 2)]))
      .on('schedule.app.list', notExposed).on('schedule.app.create', notExposed).on('schedule.app.update', notExposed)
      .on('schedule.app.pause', notExposed).on('schedule.app.resume', notExposed).on('schedule.app.delete', notExposed)
      .on('schedule.app.runs', notExposed)
      .on(ep('schedule-list'), () => step('schedule-list', { schedules: [redacted()], count: 1 }))
      .on(ep('schedule-create'), () => step('schedule-create', { schedule_uuid: 's3', schedule: redacted({ schedule_uuid: 's3' }) }))
      .on(ep('schedule-update'), () => step('schedule-update', { schedule_uuid: 's1', schedule: redacted({ interval_seconds: 1800 }), changed_fields: ['interval_seconds'] }))
      .on(ep('schedule-pause'), () => ({})).on(ep('schedule-resume'), () => ({})).on(ep('schedule-delete'), () => ({}))
      .on(ep('schedule-runs'), () => step('schedule-runs', { schedule_uuid: 's1', runs: [{ workflow_id: 'wf_s1', status: 'completed', terminal_status: 'success', finished_at: '2026-02-02T09:00:05Z' }], count: 1 }))
    const backend = appBackend(c)
    await backend.lineages()
    expect(await backend.schedules.list([live.workflow_type])).toEqual([expect.objectContaining({ schedule_uuid: 's1', target_workflow_type: live.workflow_type })])
    expect(await backend.schedules.create(live.workflow_type, 60, 'Digest', {})).toMatchObject({ schedule_uuid: 's3' })
    expect((await backend.schedules.update('s1', { interval_minutes: 30 })).interval_minutes).toBe(30)
    await backend.schedules.setActive('s1', false)
    await backend.schedules.setActive('s1', true)
    await backend.schedules.remove('s1')
    expect(c.inputsOf(ep('schedule-create'))).toEqual([{ target_workflow_type: live.workflow_type, name: 'Digest', initial_data: {}, active: true, interval_minutes: 60 }])
    expect(c.inputsOf(ep('schedule-pause'))).toEqual([{ schedule_uuid: 's1' }])
    expect(c.inputsOf(ep('schedule-delete'))).toEqual([{ schedule_uuid: 's1' }])
    expect(c.calls.some((x) => x.type.startsWith('schedule.app.'))).toBe(false)
  })

  it('lists runs from schedules and the ones started here, labelled', async () => {
    const c = scheduled()
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
    const backend = appBackend(c, { storage })
    await backend.lineages()
    const started = await backend.start(live.workflow_type, { team: 'ops' })
    expect(c.starts).toEqual([{ type: live.workflow_type, input: { team: 'ops' } }])
    c.states.set(started.workflow_id!, { workflow_id: started.workflow_id, is_terminal: true, terminal_status: 'failed', state_name: 'failed' })
    const runs = await backend.runs([live.workflow_type])
    expect(runs.map((r) => [r.workflow_uuid, r.source, r.terminal_status])).toEqual([
      [started.workflow_id, 'editor', 'failed'],
      ['wf_s1', 'schedule', 'success'],
    ])
    expect((await backend.runs([live.workflow_type], 25, 'success')).map((r) => r.workflow_uuid)).toEqual(['wf_s1'])
    // Remembered across a reload.
    const again = appBackend(c, { storage })
    expect((await again.runs([live.workflow_type])).some((r) => r.source === 'editor')).toBe(true)
    const facts = await backend.facts()
    expect(facts.schedules.get(live.workflow_type)).toBe('active')
    expect(facts.lastRuns.get(live.workflow_type)?.status).toBe('failed')
  })
})

describe('appBackend: workspaces', () => {
  const ALL = [...KEYS, 'workspaces', 'workspace-switch']
  const ws = (uuid: string, name: string, role = 'admin') => ({ app_organization_ref: { uuid, name, slug: name.toLowerCase() }, membership_status: 'active', role })

  it('finds the workspace entry points next to the authoring ones', async () => {
    const found = await appBackend(client(ALL)).entryPoints()
    expect(found.workspaces).toBe(ep('workspaces'))
    expect(found['workspace-switch']).toBe(ep('workspace-switch'))
  })

  it('lists the person’s workspaces', async () => {
    const c = client(ALL).on(ep('workspaces'), () => ({ workspaces: { items: [ws('a1', 'A'), ws('b2', 'B', 'member')], total: 2 } }))
    expect(await appBackend(c).workspaces()).toEqual([
      { uuid: 'a1', name: 'A', slug: 'a', role: 'admin', status: 'active' },
      { uuid: 'b2', name: 'B', slug: 'b', role: 'member', status: 'active' },
    ])
  })

  it('switches with workspace_uuid and forgets what it read in the old workspace', async () => {
    let listed = 0
    const c = client(ALL)
      .on(ep('list'), () => { listed++; return page([lineage('a', 1, 1)], { capabilities: { read: true, run: true, publish: false } }) })
      .on(ep('workspace-switch'), () => ({ workspace_switch: { active_app_organization_uuid: 'b2', ...ws('b2', 'B') } }))
    const backend = appBackend(c)
    await backend.lineages()
    expect(backend.capabilities.publish).toBe(false)
    const out = await backend.switchWorkspace('b2')
    expect(out).toEqual({ active: 'b2', workspace: { uuid: 'b2', name: 'B', slug: 'b', role: 'admin', status: 'active' } })
    expect(c.inputsOf(ep('workspace-switch'))).toEqual([{ workspace_uuid: 'b2' }])
    expect(backend.capabilities.publish).toBe(true) // the old workspace's grant is gone until the next read
    await backend.lineages()
    expect(listed).toBe(2)
  })

  it('says the app isn’t set up for switching when it has no workspace entry points (apps enabled before them)', async () => {
    const backend = appBackend(client(KEYS))
    await expect(backend.workspaces()).rejects.toSatisfy((e: unknown) => isComposerError(e, 'ENTRY_POINT_MISSING'))
  })
})
