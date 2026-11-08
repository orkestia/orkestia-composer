// The in-page defaults for what a host may provide itself: a context menu at
// the pointer, a confirm dialog and toasts. Rendered once by the editor; each
// stays empty when the host handles that service.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { IcX } from './icons'
import { t } from './i18n'
import { overlays, type MenuSpec } from './runtime'

function MenuItems({ items, onDone }: { items: MenuSpec[]; onDone: () => void }) {
  return (
    <>
      {items.map((item, i) => {
        if (item === 'separator') return <div key={i} className="oc-menu-sep" role="separator" />
        if ('submenu' in item) {
          return (
            <div key={i} className="oc-menu-group" role="group" aria-label={item.label}>
              <div className="oc-menu-head">{item.label}</div>
              <MenuItems items={item.submenu} onDone={onDone} />
            </div>
          )
        }
        return (
          <button key={i} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked}
            className="oc-menu-item" disabled={item.enabled === false}
            onClick={() => { onDone(); item.action?.() }}>
            <span className="oc-menu-check" aria-hidden>{item.checked ? '✓' : ''}</span>{item.label}
          </button>
        )
      })}
    </>
  )
}

function Menu() {
  const { menu } = useSyncExternalStore(overlays.subscribe, () => overlays.state)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) overlays.closeMenu() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') overlays.closeMenu() }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', key)
    ref.current?.querySelector<HTMLButtonElement>('.oc-menu-item:not([disabled])')?.focus()
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', key) }
  }, [menu])
  if (!menu) return null
  const x = Math.min(menu.x, (typeof window !== 'undefined' ? window.innerWidth : 1024) - 240)
  const y = Math.min(menu.y, (typeof window !== 'undefined' ? window.innerHeight : 768) - 40)
  return createPortal(
    <div className="oc-composer-layer">
      <div ref={ref} className="oc-menu" role="menu" style={{ left: Math.max(4, x), top: Math.max(4, y) }}>
        <MenuItems items={menu.items} onDone={() => overlays.closeMenu()} />
      </div>
    </div>,
    document.body,
  )
}

function Confirm() {
  const { confirm } = useSyncExternalStore(overlays.subscribe, () => overlays.state)
  const ok = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!confirm) return
    ok.current?.focus()
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') overlays.answer(false) }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [confirm])
  if (!confirm) return null
  return createPortal(
    <div className="oc-composer-layer"><div className="oc-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) overlays.answer(false) }}>
      <div className="oc-dialog" role="alertdialog" aria-modal="true" aria-label={confirm.title ?? t('Are you sure?')}>
        <h3>{confirm.title ?? t('Are you sure?')}</h3>
        <p>{confirm.message}</p>
        <div className="oc-dialog-actions">
          <button type="button" onClick={() => overlays.answer(false)}>{t('Cancel')}</button>
          <button ref={ok} type="button" className={confirm.destructive ? 'danger' : 'primary'} onClick={() => overlays.answer(true)}>{confirm.okLabel ?? t('OK')}</button>
        </div>
      </div>
    </div></div>,
    document.body,
  )
}

function Toasts() {
  const { toasts } = useSyncExternalStore(overlays.subscribe, () => overlays.state)
  if (!toasts.length) return null
  return createPortal(
    <div className="oc-composer-layer"><div className="oc-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`oc-toast ${toast.kind}`}>
          <span>{toast.text}</span>
          {toast.action ? <button type="button" className="link" onClick={() => { overlays.dismiss(toast.id); toast.action!.run() }}>{toast.action.label}</button> : null}
          <button type="button" className="icon-button" aria-label={t('Dismiss')} onClick={() => overlays.dismiss(toast.id)}><IcX size="xs" /></button>
        </div>
      ))}
    </div></div>,
    document.body,
  )
}

export function Overlays() {
  return <><Menu /><Confirm /><Toasts /></>
}
