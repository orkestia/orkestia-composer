import { describe, expect, it } from 'vitest'
import { isBlankDraft } from './drafts'

const draft = (over = {}) => ({ status: 'new', title: 'Untitled workflow', recipe: { blocks: [] as unknown[] }, ...over })

describe('isBlankDraft', () => {
  it('is true for an untouched new workflow', () => expect(isBlankDraft(draft())).toBe(true))
  it('is false once it has steps, a name, or was saved', () => {
    expect(isBlankDraft(draft({ recipe: { blocks: [{}] } }))).toBe(false)
    expect(isBlankDraft(draft({ title: 'Invoices' }))).toBe(false)
    expect(isBlankDraft(draft({ status: 'live' }))).toBe(false)
  })
})
