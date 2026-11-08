// @vitest-environment jsdom
// Saving through a backend that publishes: one idempotency key per attempt,
// a timeout checked before retrying, someone else's newer version opened as
// "warn, then save", and the schedule editor's cadence and planned runs.
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CompositionEditor } from './CompositionEditor'
import { createFixtureBackend, fixtureCatalog, sampleCompositions, type FixtureOptions } from './fixtures'
import { builder } from './store'
import { ComposerError } from '../backends/errors'
import { PlannedRuns } from './schedule'

afterEach(() => {
  cleanup()
  globalThis.localStorage?.clear()
})

const sampleRow = (name: string) => name.startsWith('Confirm big orders') && !/each/i.test(name)

async function setup(options: FixtureOptions = {}) {
  const backend = createFixtureBackend({ definitions: sampleCompositions({ childNames: 'slug' }), kind: 'app', publishing: true, ...options })
  render(<CompositionEditor backend={backend} catalog={fixtureCatalog} host={{ scopeKey: 'test', platform: 'mac' }} />)
  fireEvent.click(await screen.findByRole('button', { name: sampleRow }))
  await screen.findAllByText('Get the order')
  return backend
}

function rename(title: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Workflow name' }), { target: { value: title } })
}

async function clickSave() {
  fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
  // The summary sheet, when the save declares questions found in the workflow.
  const sheet = await screen.findByRole('dialog').catch(() => null)
  if (sheet && within(sheet).queryByRole('button', { name: /^Save/ })) fireEvent.click(within(sheet).getByRole('button', { name: /^Save/ }))
}

const versionsOf = (backend: ReturnType<typeof createFixtureBackend>) => backend.rows.filter((r) => r.name === 'confirm-big-orders').map((r) => r.version)

describe('publishing from the editor', () => {
  it('publishes with the version it started from and a fresh idempotency key', async () => {
    const backend = await setup()
    rename('Confirm very big orders')
    await clickSave()
    await waitFor(() => expect(versionsOf(backend)).toEqual([1, 2]))
    const sent = backend.publishes.find((p) => p.lineage === 'confirm-big-orders')!
    expect(sent).toMatchObject({ title: 'Confirm very big orders', expectedVersion: 1 })
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    await waitFor(() => expect(builder.state.entries.find((e) => e.key === 'confirm-big-orders')?.version).toBe(2))
  })

  it('checks the status after a timeout instead of publishing twice', async () => {
    const backend = await setup()
    rename('Confirm very big orders')
    backend.failNextPublish = new ComposerError('TIMEOUT')
    await clickSave()
    await waitFor(() => expect(builder.state.entries.find((e) => e.key === 'confirm-big-orders')?.version).toBe(2))
    expect(versionsOf(backend)).toEqual([1, 2])
    expect(backend.publishes.filter((p) => p.lineage === 'confirm-big-orders')).toHaveLength(1)
  })

  it('offers to retry the same attempt when the status doesn’t settle', async () => {
    const backend = await setup()
    rename('Confirm very big orders')
    failOnce(backend, 'confirm-big-orders-each-item')
    const status = backend.publishStatus!
    backend.publishStatus = async () => ({ status: 'accepted' })
    await clickSave()
    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getAllByText(/Publishing is taking longer than usual/).length).toBeGreaterThan(0)
    backend.publishStatus = status
    fireEvent.click(retry)
    await clickSaveSheetIfShown()
    await waitFor(() => expect(builder.state.entries.find((e) => e.key === 'confirm-big-orders')?.version).toBe(2))
    // The step repeated per item timed out after it went through: retrying sent the same key and the same
    // expected version, and the platform answered with the receipt it had. One new version of each.
    const child = backend.publishes.filter((p) => p.lineage === 'confirm-big-orders-each-item')
    expect(child).toHaveLength(2)
    expect(child[1].idempotencyKey).toBe(child[0].idempotencyKey)
    expect(child[1].expectedVersion).toBe(child[0].expectedVersion)
    expect(backend.rows.filter((r) => r.name === 'confirm-big-orders-each-item').map((r) => r.version)).toEqual([1, 2])
    expect(versionsOf(backend)).toEqual([1, 2])
  })

  it('opens "someone else changed it" on VERSION_CONFLICT, then saves over their version', async () => {
    const backend = await setup()
    // The quick check misses it (stale head), so the platform's refusal is what tells.
    const headVersion = backend.headVersion
    backend.headVersion = async (name) => (name === 'confirm-big-orders' ? 1 : headVersion(name))
    backend.rows.push({ ...backend.rows.find((r) => r.name === 'confirm-big-orders')!, composition_uuid: 'c-theirs', version: 2, workflow_type: 'virtual.theirs@2' })
    rename('Confirm very big orders')
    await clickSave()
    const sheet = await screen.findByRole('dialog', { name: 'Someone else changed it' })
    expect(within(sheet).getByText(/version 2 was saved since/)).toBeTruthy()
    expect(builder.state.entries.find((e) => e.key === 'confirm-big-orders')?.conflict).toEqual({ base: 1, theirs: 2 })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save Anyway' }))
    await clickSaveSheetIfShown()
    await waitFor(() => expect(versionsOf(backend)).toEqual([1, 2, 3]))
    const sent = backend.publishes.filter((p) => p.lineage === 'confirm-big-orders')
    expect(sent.map((p) => p.expectedVersion)).toEqual([1, 2])
    // A new expected version is a new attempt: a new key.
    expect(sent[0].idempotencyKey).not.toBe(sent[1].idempotencyKey)
  })
})

/** The next publish of `lineage` goes through, then answers with a timeout. */
function failOnce(backend: ReturnType<typeof createFixtureBackend>, lineage: string) {
  const publish = backend.publish!
  let done = false
  backend.publish = async (input) => {
    const receipt = await publish(input)
    if (input.lineage === lineage && !done) { done = true; throw new ComposerError('TIMEOUT') }
    return receipt
  }
}

async function clickSaveSheetIfShown() {
  const sheet = await screen.findByRole('dialog', {}, { timeout: 300 }).catch(() => null)
  if (sheet && within(sheet).queryByRole('button', { name: /^Save/ })) fireEvent.click(within(sheet).getByRole('button', { name: /^Save/ }))
}

describe('drafting without the right to publish', () => {
  it('a member who may draft edits the workflow and Save Draft keeps a draft, never publishing', async () => {
    const backend = await setup({ capabilities: { publish: false, run: true, draft: true } })
    rename('Confirm very big orders')
    await clickSave()
    await waitFor(() => expect(versionsOf(backend)).toEqual([1, 2]))
    expect(backend.publishes).toEqual([])
    expect(screen.getByRole('button', { name: /^Save Draft/ })).toBeTruthy()
  })

  it('without drafts either, the editor is read-only and has no Save', async () => {
    await setup({ capabilities: { publish: false, run: true, draft: false } })
    expect((screen.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull()
  })
})

describe('a live workflow the workspace is not offered', () => {
  it('says it is not available to run and offers no Run until it is published again', async () => {
    await setup({ unexposed: ['confirm-big-orders'] })
    expect(screen.getByRole('button', { name: sampleRow }).textContent).toContain('not available to run')
    expect(builder.state.entries.find((e) => e.key === 'confirm-big-orders')?.unexposed).toBe(true)
    rename('Confirm very big orders')
    await clickSave()
    await waitFor(() => expect(builder.state.entries.find((e) => e.key === 'confirm-big-orders')?.unexposed).toBe(false))
    expect(screen.getByRole('button', { name: /^Confirm very big orders/ }).textContent).not.toContain('not available to run')
  })
})

describe('the schedule editor', () => {
  it('takes a time expression and time zone, and shows the planned runs', async () => {
    await setup({ minIntervalMinutes: 15 })
    fireEvent.click(screen.getByRole('button', { name: 'On a schedule' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Minutes between runs' }), { target: { value: '5' } })
    expect((await screen.findByRole('alert')).textContent).toBe('Schedules here can run at most every 15 minutes.')
    fireEvent.click(screen.getByRole('radio', { name: 'At set times' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Schedule expression' }), { target: { value: '0 9 * * 1-5' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Time zone' }), { target: { value: 'America/Sao_Paulo' } })
    const planned = await screen.findByLabelText('Planned runs')
    expect(planned.querySelectorAll('li')).toHaveLength(5)
    const key = builder.state.selected!
    expect(builder.state.entries.find((e) => e.key === key)?.recipe?.runs).toMatchObject({ mode: 'schedule', cron: '0 9 * * 1-5', timezone: 'America/Sao_Paulo' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Schedule expression' }), { target: { value: '*/5 * * * *' } })
    expect((await screen.findByRole('alert')).textContent).toBe('Schedules here can run at most every 15 minutes.')
    // Back to an interval drops the expression.
    fireEvent.click(screen.getByRole('radio', { name: 'Every few minutes' }))
    expect(builder.state.entries.find((e) => e.key === key)?.recipe?.runs.cron).toBeUndefined()
  })

  it('sets up the schedule by expression when it publishes', async () => {
    const backend = await setup({ minIntervalMinutes: 15 })
    fireEvent.click(screen.getByRole('button', { name: 'On a schedule' }))
    fireEvent.click(screen.getByRole('radio', { name: 'At set times' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Schedule expression' }), { target: { value: '30 8 * * *' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Time zone' }), { target: { value: 'Europe/Madrid' } })
    await clickSave()
    await waitFor(() => expect(backend.schedulesList).toHaveLength(1))
    expect(backend.schedulesList[0]).toMatchObject({ schedule_expression: '30 8 * * *', timezone: 'Europe/Madrid', active: true })
  })

  it('shows each planned run in the viewer’s time and the schedule’s', () => {
    render(<PlannedRuns cadence={{ kind: 'cron', expression: '0 6 * * *', timezone: 'America/Sao_Paulo' }} viewerZone="Europe/Madrid" from={new Date('2026-06-01T00:00:00Z')} count={2} />)
    const planned = screen.getByLabelText('Planned runs')
    expect(planned.textContent).toContain('America/Sao_Paulo')
    expect(planned.textContent).toContain('Europe/Madrid')
    const times = [...planned.querySelectorAll('time')].map((t) => t.getAttribute('datetime'))
    expect(times).toEqual(['2026-06-01T09:00:00.000Z', '2026-06-02T09:00:00.000Z'])
    // 09:00 UTC is 11:00 in Madrid (summer) and 06:00 in São Paulo.
    expect(planned.querySelector('li')!.textContent).toMatch(/11:00.*06:00/)
  })
})
