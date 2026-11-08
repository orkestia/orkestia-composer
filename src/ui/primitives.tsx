// Small building blocks the editor draws with: loading, empty and problem
// states, relative times, a pane resize handle and the toolbar title (which a
// host may render itself through the `renderToolbarTitle` slot).
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react'
import { IcAlertCircle } from './icons'
import { intlLocale, t } from './i18n'
import { store } from './runtime'

export function Spinner() {
  return <span className="oc-spinner" role="status" aria-label={t('Loading')} />
}

export function Empty({ title, detail, icon }: { title: string; detail?: string; icon?: ReactNode }) {
  return (
    <div className="oc-empty">
      {icon ? <div className="oc-empty-icon">{icon}</div> : null}
      <p className="oc-empty-title">{title}</p>
      {detail ? <p className="muted">{detail}</p> : null}
    </div>
  )
}

/** A server timestamp; one without a zone is UTC. */
export function parseInstant(iso: string): number {
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`
  return Date.parse(zoned)
}

export function relativeTime(iso: string, now = Date.now()): string {
  const at = parseInstant(iso)
  if (Number.isNaN(at)) return iso
  const seconds = Math.round((at - now) / 1000)
  const abs = Math.abs(seconds)
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' })
  if (abs < 45) return rtf.format(0, 'second')
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour')
  if (abs < 30 * 86_400) return rtf.format(Math.round(seconds / 86_400), 'day')
  return new Date(at).toLocaleDateString(intlLocale(), { dateStyle: 'medium' })
}

export function Ago({ iso }: { iso?: string }) {
  if (!iso) return null
  const at = parseInstant(iso)
  const full = Number.isNaN(at) ? iso : new Date(at).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
  return <time dateTime={iso} title={full}>{relativeTime(iso)}</time>
}

export function Skeleton({ lines = 3, kind = 'lines', className }: { lines?: number; kind?: 'lines' | 'card' | 'rows'; className?: string }) {
  if (kind === 'card') return <div className={['oc-skel oc-skel-card', className ?? ''].join(' ')} aria-hidden />
  if (kind === 'rows') return <div className={['oc-skel-rows', className ?? ''].join(' ')} aria-hidden>{Array.from({ length: lines }, (_, i) => <div key={i} className="oc-skel oc-skel-row" />)}</div>
  return <div className={['oc-skel-lines', className ?? ''].join(' ')} aria-hidden>{Array.from({ length: lines }, (_, i) => <div key={i} className="oc-skel oc-skel-line" style={{ width: `${92 - ((i * 17) % 40)}%` }} />)}</div>
}

export function Problem({ title, detail, raw, onRetry, busy, tone = 'bad' }: {
  title: string; detail?: ReactNode; raw?: string | null; onRetry?: () => void; busy?: boolean; tone?: 'bad' | 'warn'
}) {
  return (
    <div className={`oc-problem ${tone}`} role="alert">
      <IcAlertCircle size="sm" className="oc-problem-icon" />
      <div className="oc-problem-body">
        <div className="oc-problem-title">{title}</div>
        {detail ? <div className="oc-problem-detail">{detail}</div> : null}
        {raw ? (
          <details className="oc-problem-raw">
            <summary>{t('Details')}</summary>
            <pre>{raw}</pre>
          </details>
        ) : null}
      </div>
      {onRetry ? <button type="button" className="small" disabled={busy} onClick={onRetry}>{t('Retry')}</button> : null}
    </div>
  )
}

// ---- Pane resize ----

export interface ResizeProps {
  /** Remembered as `layout.<id>`. */
  id: string
  /** The CSS variable the container's grid reads, e.g. `--w-sidebar`. */
  cssVar: string
  defaultPx: number
  min: number
  max: number
  /** Which pane it sizes: the one to its left (drag right = wider) or to its right (drag left = wider). */
  sizes?: 'left' | 'right'
  className?: string
  label: string
}

const readWidth = (id: string): number | null => {
  const v = Number(store.get(`layout.${id}`))
  return Number.isFinite(v) && v > 0 ? v : null
}
const writeWidth = (id: string, px: number | null) => store.set(`layout.${id}`, px == null ? null : String(Math.round(px)))
const clampWidth = (px: number, min: number, max: number) => Math.min(max, Math.max(min, px))

export function ResizeHandle({ id, cssVar, defaultPx, min, max, sizes = 'left', className, label }: ResizeProps) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useRef<number>(readWidth(id) ?? defaultPx)
  const apply = useCallback((px: number, persist = true) => {
    width.current = clampWidth(px, min, max)
    ref.current?.parentElement?.style.setProperty(cssVar, `${width.current}px`)
    if (persist) writeWidth(id, width.current)
  }, [cssVar, id, min, max])
  useEffect(() => { apply(width.current, false) }, [apply])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const start = width.current
    const el = ref.current!
    el.setPointerCapture?.(e.pointerId)
    document.documentElement.classList.add('oc-is-resizing')
    const move = (ev: PointerEvent) => apply(start + (sizes === 'left' ? ev.clientX - startX : startX - ev.clientX), false)
    const up = () => {
      writeWidth(id, width.current)
      document.documentElement.classList.remove('oc-is-resizing')
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 40 : 10
    const grow = sizes === 'left' ? 'ArrowRight' : 'ArrowLeft'
    const shrink = sizes === 'left' ? 'ArrowLeft' : 'ArrowRight'
    if (e.key === grow) { e.preventDefault(); apply(width.current + step) }
    if (e.key === shrink) { e.preventDefault(); apply(width.current - step) }
    if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); writeWidth(id, null); apply(defaultPx, false) }
  }
  return (
    <div
      ref={ref}
      className={['oc-resize', `sizes-${sizes}`, className ?? ''].join(' ')}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={t('{label} · drag to resize, double-click to reset', { label })}
      onPointerDown={onPointerDown}
      onDoubleClick={() => { writeWidth(id, null); apply(defaultPx, false) }}
      onKeyDown={onKey}
    />
  )
}

// ---- Toolbar title (host slot) ----

export type ToolbarTitleRender = (props: { title: string; subtitle?: string; icon?: ReactNode }) => ReactNode
export const ToolbarTitleContext = createContext<ToolbarTitleRender | null>(null)

export function ToolbarTitle({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: ReactNode }) {
  const render = useContext(ToolbarTitleContext)
  if (render) return <>{render({ title, subtitle, icon })}</>
  return (
    <div className="oc-toolbar-title">
      <span className="oc-toolbar-title-main">{icon ? <span className="oc-toolbar-title-icon" aria-hidden>{icon}</span> : null}{title}</span>
      {subtitle ? <span className="oc-toolbar-title-sub">{subtitle}</span> : null}
    </div>
  )
}
