/** An unsaved workflow nobody has touched: still the default title, no steps. Pressing "New" reuses it. */
export function isBlankDraft(entry: { status: string; title: string; recipe: { blocks: unknown[] } | null }): boolean {
  return entry.status === 'new' && entry.title === 'Untitled workflow' && !entry.recipe?.blocks.length
}
