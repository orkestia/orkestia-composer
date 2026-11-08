// The editor's words. Every user-facing string is written in English in the
// code and passed through `t()`; the English text is the key, so a missing
// translation falls back to English instead of showing a key. `{name}`
// placeholders are filled from `vars`.
//
//   t('Delete “{title}”?', { title })
//
// A host picks a locale (`en`, `pt-BR`, `es`) and may override any string:
// `messages={{ 'Save': 'Publish' }}` (keys are the English text).
import { es } from './es'
import { ptBR } from './pt-BR'

export type Locale = 'en' | 'pt-BR' | 'es'
export type Messages = Record<string, string>

export const CATALOGS: Record<Locale, Messages> = { en: {}, 'pt-BR': ptBR, es }

let locale: Locale = 'en'
let overrides: Messages = {}

export function setLocale(next: Locale, messages: Messages = {}) {
  locale = CATALOGS[next] ? next : 'en'
  overrides = messages
}

export function currentLocale(): Locale { return locale }

/** BCP 47 tag for Intl formatters. */
export function intlLocale(): string { return locale }

export function t(text: string, vars?: Record<string, string | number>): string {
  const template = overrides[text] ?? CATALOGS[locale][text] ?? text
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole))
}

/**
 * Marks a string for the catalogs without translating it yet: for tables built
 * once at import time and translated where shown, with t(label).
 */
export const msg = (text: string): string => text

/** "1 step" / "3 steps": English plural forms as keys, each catalog translating both. */
export function plural(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  return t(n === 1 ? one : other, { n, ...vars })
}
