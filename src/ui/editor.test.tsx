// @vitest-environment jsdom
// The editor end to end against the in-memory backend: what a person sees and
// does in the step list, the pickers, the diagram, read-only mode and locales.
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CompositionEditor, type CompositionEditorProps } from './CompositionEditor'
import { createFixtureBackend, fixtureCatalog, sampleCompositions, sampleDefinition, type FixtureOptions } from './fixtures'
import { builder } from './store'

afterEach(() => {
  cleanup()
  globalThis.localStorage?.clear()
})

function setup(options: FixtureOptions = {}, props: Partial<CompositionEditorProps> = {}) {
  const backend = createFixtureBackend({ definitions: sampleCompositions(), ...options })
  const view = render(<CompositionEditor backend={backend} catalog={fixtureCatalog} host={{ scopeKey: 'test', platform: 'mac' }} {...props} />)
  return { backend, ...view }
}

/** The sample's row in the list (not the per-item composition its For each calls). */
const sampleRow = (name: string) => name.startsWith('Confirm big orders') && !/each/i.test(name)

async function openSample() {
  fireEvent.click(await screen.findByRole('button', { name: sampleRow }))
  await screen.findAllByText('Get the order')
}

const stepTitles = () => [...document.querySelectorAll('.wf-card .wf-step-title, .wf-card input.wf-step-title')]
  .map((el) => (el instanceof HTMLInputElement ? el.value : el.textContent ?? ''))

describe('the step list', () => {
  it('lists the saved compositions and opens one as steps', async () => {
    setup()
    await openSample()
    const shown = (title: string) => screen.queryAllByText(title).length > 0 || screen.queryAllByDisplayValue(title).length > 0
    for (const title of ['Find the customer', 'Get the order', 'Confirm the order', 'Email the customer']) expect(shown(title)).toBe(true)
    expect(document.querySelector('[data-block="if"], .wf-if')).not.toBeNull()
    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveProperty('value', 'Confirm big orders')
  })

  it('adds a step through the step picker', async () => {
    setup()
    await openSample()
    const before = document.querySelectorAll('.wf-card').length
    const add = screen.getAllByRole('button', { name: /^Add a step$/ })
    fireEvent.click(add[add.length - 1])
    const search = await screen.findByRole('textbox', { name: 'Search steps' })
    fireEvent.change(search, { target: { value: 'slack message' } })
    fireEvent.click(await screen.findByRole('button', { name: /Send a Slack message/ }))
    await waitFor(() => expect(document.querySelectorAll('.wf-card').length).toBe(before + 1))
    expect(screen.getAllByText(/Send a Slack message/).length).toBeGreaterThan(0)
  })

  it('puts data from an earlier step into a field as a chip', async () => {
    setup()
    await openSample()
    // A new step's fields start empty: add one, then fill its field from earlier data.
    const add = screen.getAllByRole('button', { name: /^Add a step$/ })
    fireEvent.click(add[add.length - 1])
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search steps' }), { target: { value: 'slack message' } })
    fireEvent.click(await screen.findByRole('button', { name: /Send a Slack message/ }))
    await screen.findAllByText(/Send a Slack message/)
    const card = [...document.querySelectorAll<HTMLElement>('.wf-card')].find((c) => /Send a Slack message/.test(c.textContent ?? '') || [...c.querySelectorAll('input')].some((i) => /Send a Slack message/.test(i.value)))!
    const before = card.querySelectorAll('.wf-chip').length
    fireEvent.click(within(card).getAllByRole('button', { name: 'Use data from earlier' })[0])
    const search = await screen.findByPlaceholderText('Search data')
    const picker = search.closest('.wf-picker') as HTMLElement
    const option = within(picker).getAllByRole('button').find((b) => b.className.includes('wf-picker-item'))!
    fireEvent.click(option)
    await waitFor(() => expect(card.querySelectorAll('.wf-chip').length).toBeGreaterThan(before))
  })
})

describe('one undo history for both views', () => {
  it('undoes an edit made in the step list from the diagram', async () => {
    setup()
    await openSample()
    const name = screen.getByRole('textbox', { name: 'Workflow name' })
    fireEvent.change(name, { target: { value: 'Confirm very big orders' } })
    expect((screen.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe('Confirm very big orders')

    fireEvent.click(screen.getByRole('radio', { name: 'Diagram' }))
    const undo = await screen.findByRole('button', { name: /^Undo/ })
    expect(undo).not.toHaveProperty('disabled', true)
    fireEvent.click(undo)

    fireEvent.click(screen.getByRole('radio', { name: 'Steps' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe('Confirm big orders'))
  })

  it('redoes it from the step list with the keyboard', async () => {
    setup()
    await openSample()
    const key = builder.state.selected!
    act(() => { builder.update(key, (r) => ({ ...r, title: 'Edited in the diagram' }), { merge: false }) })
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe('Edited in the diagram'))
    fireEvent.keyDown(window, { key: 'z', metaKey: true })
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe('Confirm big orders'))
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true })
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Workflow name' }) as HTMLInputElement).value).toBe('Edited in the diagram'))
  })
})

describe('read-only mode', () => {
  it('hides every way to change or create when the caller may not publish', async () => {
    setup({ capabilities: { publish: false, run: false } })
    await openSample()
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New Workflow' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Run…/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Add a step/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit anyway' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveProperty('disabled', true)
    expect(screen.getByText(/You can view this workflow but not change it/)).toBeTruthy()
  })

  it('keeps editing for a caller who may publish', async () => {
    setup()
    await openSample()
    expect(screen.getByRole('button', { name: /^Save/ })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveProperty('disabled', false)
  })
})

describe('locales', () => {
  it('renders Brazilian Portuguese, then English again', async () => {
    const backend = createFixtureBackend({ definitions: sampleCompositions() })
    const host = { scopeKey: 'test' }
    const view = render(<CompositionEditor backend={backend} catalog={fixtureCatalog} host={host} locale="pt-BR" />)
    expect((await screen.findAllByRole('button', { name: 'Novo fluxo' })).length).toBeGreaterThan(0)
    fireEvent.click(await screen.findByRole('button', { name: sampleRow }))
    expect(await screen.findByRole('radio', { name: 'Etapas' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Diagrama' })).toBeTruthy()

    view.rerender(<CompositionEditor backend={backend} catalog={fixtureCatalog} host={host} locale="en" />)
    expect((await screen.findAllByRole('button', { name: 'New Workflow' })).length).toBeGreaterThan(0)
  })

  it('lets the host replace any string', async () => {
    setup({}, { messages: { 'New Workflow': 'New Routine' } })
    expect((await screen.findAllByRole('button', { name: 'New Routine' })).length).toBeGreaterThan(0)
  })
})

describe('the assistant slot', () => {
  it('shows no assistant without a renderAssistant', async () => {
    setup()
    await openSample()
    expect(screen.queryByRole('button', { name: 'Assistant' })).toBeNull()
  })

  it('renders the host’s assistant and applies what it proposes', async () => {
    const proposed = sampleDefinition()
    proposed.layers = proposed.layers.slice(0, 1)
    setup({}, {
      renderAssistant: ({ onPropose, lineage }) => (
        <button type="button" onClick={() => onPropose(proposed)}>Propose for {lineage.title}</button>
      ),
    })
    await openSample()
    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }))
    fireEvent.click(await screen.findByRole('button', { name: /Propose for Confirm big orders/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply to the Builder' }))
    await waitFor(() => expect(stepTitles().length).toBeLessThan(4))
  })
})
