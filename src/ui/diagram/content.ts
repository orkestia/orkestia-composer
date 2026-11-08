// What each box on the diagram says, and how big it is. Sizes come from the
// content (fixed row heights in diagram.css), never from measuring the DOM, so
// the same recipe always lays out the same way.
import { t, plural } from '../i18n'
import { fieldLabel, unknownEntry, type Catalog, type CatalogField, type FieldType } from '../../model/catalog'
import { describeRef } from '../../model/data'
import { SERVER_CONTROLLED } from '../../model/definition'
import type { Recipe, Step, Value } from '../../model/recipe'

export const STEP_W = 256
export const IO_W = 224
export const ROW_H = 20
export const HEAD_H = 50
export const SECTION_H = 18
export const PAD = 14
export const GROUP_HEAD = 40
export const GROUP_PAD = 18
export const MAX_FIELDS = 3
export const MAX_PORTS = 8

export interface FieldLine { name: string; label: string; text: string; ref: boolean; missing?: boolean }
export interface InPort { field: string; label: string; type: FieldType; filled: boolean; required: boolean }
export interface OutPort { path: string; label: string; type: FieldType }

export interface StepContent {
  fields: FieldLine[]
  /** Required inputs left empty (the box says so). */
  empty: number
  inPorts: InPort[]
  outPorts: OutPort[]
  morePorts: { in: number; out: number }
}

const asked = (f: CatalogField) => !f.automatic && !SERVER_CONTROLLED.has(f.name)

/** A value in a few words: typed text as is, data as "Step › field". */
export function valueText(recipe: Recipe, catalog: Catalog, value: Value | undefined): { text: string; ref: boolean; missing?: boolean } {
  if (!value || value.kind === 'empty') return { text: '', ref: false }
  switch (value.kind) {
    case 'literal': {
      const v = value.value
      return { text: v === true ? t('Yes') : v === false ? t('No') : typeof v === 'string' ? v : JSON.stringify(v), ref: false }
    }
    case 'ref': {
      const d = describeRef(recipe, catalog, value.ref)
      return { text: d.label, ref: true, missing: d.missing }
    }
    case 'text': return { text: value.parts.map((p) => (typeof p === 'string' ? p : `‹${describeRef(recipe, catalog, p).label}›`)).join(''), ref: value.parts.some((p) => typeof p !== 'string') }
    case 'object': return { text: plural(Object.keys(value.fields).length, '{n} field', '{n} fields'), ref: false }
    case 'list': return { text: plural(value.items.length, '{n} item', '{n} items'), ref: false }
  }
}

export function stepContent(recipe: Recipe, catalog: Catalog, step: Step): StepContent {
  const spec = catalog.get(step.workflowType) ?? unknownEntry(step.workflowType)
  const declared = spec.inputs.filter(asked)
  const extra: CatalogField[] = Object.keys(step.fields).filter((n) => !spec.inputs.some((f) => f.name === n) && !SERVER_CONTROLLED.has(n)).map((name) => ({ name, type: 'json' }))
  const filled = (name: string) => { const v = step.fields[name]; return !!v && v.kind !== 'empty' && !(v.kind === 'literal' && (v.value === '' || v.value == null)) }
  const lines: FieldLine[] = [...declared, ...extra].filter((f) => filled(f.name)).map((f) => ({ name: f.name, label: fieldLabel(f.name), ...valueText(recipe, catalog, step.fields[f.name]) }))
  const empty = declared.filter((f) => f.required && !filled(f.name)).length
  const inAll: InPort[] = [...declared, ...extra]
    .filter((f) => f.required || filled(f.name) || declared.length <= MAX_PORTS)
    .map((f) => ({ field: f.name, label: fieldLabel(f.name), type: f.type, filled: filled(f.name), required: !!f.required }))
  const outAll: OutPort[] = [{ path: '*', label: t('Whole result'), type: 'json' as FieldType }, ...spec.outputs.map((o) => ({ path: o.name, label: fieldLabel(o.name), type: o.type }))]
  return {
    fields: lines.slice(0, MAX_FIELDS),
    empty,
    inPorts: inAll.slice(0, MAX_PORTS),
    outPorts: outAll.slice(0, MAX_PORTS),
    morePorts: { in: Math.max(0, inAll.length - MAX_PORTS), out: Math.max(0, outAll.length - MAX_PORTS) },
  }
}

export interface SizeOptions { data: boolean; technical: boolean; hasProblem: boolean; hasRunNote: boolean }

export function stepHeight(c: StepContent, o: SizeOptions): number {
  let h = HEAD_H + (o.technical ? 16 : 0)
  if (o.data) {
    h += SECTION_H + Math.max(1, c.inPorts.length + (c.morePorts.in ? 1 : 0)) * ROW_H
    h += SECTION_H + (c.outPorts.length + (c.morePorts.out ? 1 : 0)) * ROW_H
  } else {
    h += c.fields.length * ROW_H + (c.empty && c.fields.length < MAX_FIELDS ? ROW_H : 0)
  }
  if (o.hasProblem) h += ROW_H
  if (o.hasRunNote) h += ROW_H
  return h + PAD
}

/** "Starts with" / "Returns" boxes: one row per answer or returned value. */
export function ioHeight(rows: number): number {
  return 38 + Math.max(1, rows) * ROW_H + 8
}

export const COLLAPSED = { w: STEP_W, h: 66 }
