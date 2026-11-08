import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SaveSheet } from './SaveSheet'

const found = ['store', 'limit', 'offset'].map((name) => ({ id: name, name, label: name[0].toUpperCase() + name.slice(1), type: 'string' as const, required: false, found: true }))

describe('the save summary', () => {
  it('says the save also declares the questions found in the workflow, ticked by default', () => {
    const html = renderToStaticMarkup(<SaveSheet deps={null} found={found} version={3} onCancel={() => {}} onSave={() => {}} />)
    expect(html).toContain('Will also declare 3 questions this workflow already used')
    expect(html).toContain('Store, Limit, Offset')
    expect(html).toMatch(/type="checkbox" checked=""/)
  })

  it('shows them alongside who uses the workflow', () => {
    const deps = { dependent_count: 1, dependents: [{ name: 'Nightly sync', site: 'schedule' }] }
    const html = renderToStaticMarkup(<SaveSheet deps={deps as never} found={found.slice(0, 1)} version={3} onCancel={() => {}} onSave={() => {}} />)
    expect(html).toContain('1 thing uses this workflow')
    expect(html).toContain('Will also declare 1 question this workflow already used')
  })
})
