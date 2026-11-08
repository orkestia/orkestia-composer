// A field is edited as one line of text where chips are written {Like › this}.
// These two functions turn a Value into that line and back.
import type { FieldType } from './catalog'
import type { Ref, Value } from './recipe'

export interface Label { ref: Ref; label: string }

export function toEditText(value: Value | undefined, labelOf: (ref: Ref) => string): string {
  if (!value) return ''
  switch (value.kind) {
    case 'empty': return ''
    case 'literal': return value.value === null || value.value === undefined ? '' : typeof value.value === 'string' ? value.value : JSON.stringify(value.value)
    case 'ref': return `{${labelOf(value.ref)}}`
    case 'text': return value.parts.map((p) => (typeof p === 'string' ? p : `{${labelOf(p)}}`)).join('')
    default: return ''
  }
}

export function fromEditText(text: string, labels: Label[], type: FieldType | undefined): Value {
  const byLabel = new Map(labels.map((l) => [l.label.toLowerCase(), l.ref]))
  const parts: Array<string | Ref> = []
  let rest = text
  while (rest.length) {
    const open = rest.indexOf('{')
    if (open < 0) { parts.push(rest); break }
    const close = rest.indexOf('}', open + 1)
    if (close < 0) { parts.push(rest); break }
    const ref = byLabel.get(rest.slice(open + 1, close).trim().toLowerCase())
    if (ref) {
      if (open > 0) parts.push(rest.slice(0, open))
      parts.push(ref)
    } else {
      parts.push(rest.slice(0, close + 1))
    }
    rest = rest.slice(close + 1)
  }
  const merged: Array<string | Ref> = []
  for (const p of parts) {
    const last = merged.at(-1)
    if (typeof p === 'string' && typeof last === 'string') merged[merged.length - 1] = last + p
    else merged.push(p)
  }
  const refs = merged.filter((p): p is Ref => typeof p !== 'string')
  if (!refs.length) return literal(text, type)
  if (merged.length === 1) return { kind: 'ref', ref: refs[0] }
  return { kind: 'text', parts: merged }
}

export function literal(text: string, type: FieldType | undefined): Value {
  if (text === '') return { kind: 'empty' }
  const t = text.trim()
  switch (type) {
    case 'integer':
    case 'float':
      return t !== '' && !Number.isNaN(Number(t)) ? { kind: 'literal', value: Number(t) } : { kind: 'literal', value: text }
    case 'boolean':
      if (/^(true|yes|on)$/i.test(t)) return { kind: 'literal', value: true }
      if (/^(false|no|off)$/i.test(t)) return { kind: 'literal', value: false }
      return { kind: 'literal', value: text }
    case 'list':
    case 'dict':
    case 'json':
      try { return { kind: 'literal', value: JSON.parse(t) } } catch { return { kind: 'literal', value: text } }
    default:
      return { kind: 'literal', value: text }
  }
}
