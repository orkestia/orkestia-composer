// Plain words for identifiers: `order-status-sync` reads as
// "Order status sync". The raw identifier stays available to callers;
// it is never the headline.

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'via'])
const ACRONYMS: Record<string, string> = {
  pr: 'PR', prs: 'PRs', ci: 'CI', api: 'API', mcp: 'MCP', geo: 'GEO', ui: 'UI', ux: 'UX', sla: 'SLA', slo: 'SLO', seo: 'SEO', llm: 'LLM', id: 'ID', vm: 'VM',
}

/** `order-status-sync` → "Order status sync". */
export function humanName(raw: string): string {
  const words = raw.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ')
  return words.map((w, i) => {
    const lower = w.toLowerCase()
    if (ACRONYMS[lower]) return ACRONYMS[lower]
    if (i > 0 && SMALL.has(lower)) return lower
    return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
  }).join(' ')
}
