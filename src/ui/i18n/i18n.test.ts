// Every string the editor passes through t() or plural() has a translation in
// each catalog, with the same {placeholders}; and the runtime fills them in.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { es } from './es'
import { plural, setLocale, t } from './index'
import { ptBR } from './pt-BR'

const UI = join(__dirname, '..')
/** The backends' refusal messages are the editor's strings too. */
const BACKENDS = join(__dirname, '../../backends')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'fixtures.ts' ? [path] : []
  })
}

const STRING = String.raw`'((?:\\.|[^'\\])*)'`
const unescape = (s: string) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\')

/** Keys passed to t(), plural() and msg() (labels in tables, translated where shown). */
function usedKeys(): Set<string> {
  const keys = new Set<string>()
  for (const file of [...sources(UI), ...sources(BACKENDS)]) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(new RegExp(String.raw`\b(?:t|msg)\(\s*` + STRING, 'g'))) keys.add(unescape(m[1]))
    for (const m of text.matchAll(new RegExp(String.raw`\bplural\(\s*[^,]+,\s*` + STRING + String.raw`\s*,\s*` + STRING, 'g'))) {
      keys.add(unescape(m[1]))
      keys.add(unescape(m[2]))
    }
  }
  return keys
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')

describe('the catalogs', () => {
  const keys = usedKeys()

  it('finds the strings', () => {
    expect(keys.size).toBeGreaterThan(300)
    expect(keys.has('New Workflow')).toBe(true)
  })

  for (const [name, catalog] of [['pt-BR', ptBR], ['es', es]] as const) {
    it(`${name} translates every string the editor uses`, () => {
      expect([...keys].filter((k) => !(k in catalog))).toEqual([])
    })
    it(`${name} keeps every placeholder`, () => {
      expect(Object.entries(catalog).filter(([k, v]) => placeholders(k) !== placeholders(v)).map(([k]) => k)).toEqual([])
    })
    it(`${name} has no stale entries`, () => {
      expect(Object.keys(catalog).filter((k) => !keys.has(k))).toEqual([])
    })
  }
})

describe('t()', () => {
  afterEach(() => setLocale('en'))

  it('falls back to the English text and fills placeholders', () => {
    expect(t('Run “{title}”', { title: 'Daily report' })).toBe('Run “Daily report”')
    expect(t('Something nobody translated')).toBe('Something nobody translated')
  })

  it('translates, keeps unknown placeholders and lets the host override', () => {
    setLocale('pt-BR')
    expect(t('Run “{title}”', { title: 'Relatório' })).toBe('Executar “Relatório”')
    expect(t('Step {n}')).toBe('Etapa {n}')
    setLocale('pt-BR', { 'New Workflow': 'Nova rotina' })
    expect(t('New Workflow')).toBe('Nova rotina')
  })

  it('picks the plural form by count', () => {
    setLocale('es')
    expect(plural(1, '{n} step', '{n} steps')).toBe('1 paso')
    expect(plural(3, '{n} step', '{n} steps')).toBe('3 pasos')
  })

  it('falls back to English for an unknown locale', () => {
    setLocale('xx' as never)
    expect(t('Save')).toBe('Save')
  })
})
