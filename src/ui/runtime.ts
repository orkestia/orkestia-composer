// The services the editor's components call (dialogs, menus, toasts,
// notifications, storage), bound to the mounted editor's host. Whatever the
// host leaves out falls back to an in-page default rendered by <Overlays />.
// One editor is mounted at a time per page.
import type { ComposerHost, ComposerStorage, MenuSpec, ToastAction, ToastKind } from './host'

export type { MenuSpec } from './host'

// ---- In-page overlays (the DOM defaults) ----

export interface OverlayToast { id: number; kind: ToastKind; text: string; action?: ToastAction }
export interface OverlayMenu { items: MenuSpec[]; x: number; y: number; done: () => void }
export interface OverlayConfirm { message: string; title?: string; okLabel?: string; destructive?: boolean; done: (ok: boolean) => void }

interface OverlayState { toasts: OverlayToast[]; menu: OverlayMenu | null; confirm: OverlayConfirm | null }

let overlay: OverlayState = { toasts: [], menu: null, confirm: null }
const overlayListeners = new Set<() => void>()
function setOverlay(patch: Partial<OverlayState>) {
  overlay = { ...overlay, ...patch }
  for (const l of overlayListeners) l()
}
export const overlays = {
  get state() { return overlay },
  subscribe(listener: () => void) { overlayListeners.add(listener); return () => { overlayListeners.delete(listener) } },
  closeMenu() { overlay.menu?.done(); setOverlay({ menu: null }) },
  answer(ok: boolean) { overlay.confirm?.done(ok); setOverlay({ confirm: null }) },
  dismiss(id: number) { setOverlay({ toasts: overlay.toasts.filter((t) => t.id !== id) }) },
}

/** Where the pointer last was: an in-page menu opens there, like a native one. */
const pointer = { x: 0, y: 0 }
let tracking = false
export function trackPointer() {
  if (tracking || typeof document === 'undefined') return
  tracking = true
  const note = (e: MouseEvent) => { pointer.x = e.clientX; pointer.y = e.clientY }
  document.addEventListener('pointerdown', note, true)
  document.addEventListener('contextmenu', note, true)
}

// ---- Binding ----

const memoryStorage = (): ComposerStorage => {
  const map = new Map<string, string>()
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: (k) => { map.delete(k) } }
}

function browserStorage(): ComposerStorage {
  try {
    const s = globalThis.localStorage
    const probe = '__composer_probe__'
    s.setItem(probe, '1')
    s.removeItem(probe)
    return s
  } catch {
    return memoryStorage()
  }
}

let host: ComposerHost = {}
let storage: ComposerStorage | null = null

/** The platform as seen by shortcuts: ⌘ on a Mac, Ctrl elsewhere. Live: rebound with the host. */
export let isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)

export function bindHost(next: ComposerHost) {
  host = next
  storage = next.storage ?? null
  isMac = next.platform ? next.platform === 'mac' : typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)
}

export function currentHost(): ComposerHost { return host }

/** Storage that never throws: a host's, else localStorage, else memory. Keys are scoped by `host.scopeKey`. */
export const store = {
  key(name: string) { return `composer.${name}.${host.scopeKey ?? 'default'}` },
  get(name: string): string | null {
    try { return (storage ??= browserStorage()).getItem(store.key(name)) } catch { return null }
  },
  set(name: string, value: string | null) {
    try {
      const s = (storage ??= browserStorage())
      if (value == null) s.removeItem(store.key(name))
      else s.setItem(store.key(name), value)
    } catch { /* storage unavailable: kept in memory only */ }
  },
}

// ---- The services ----

export function confirmDialog(message: string, opts: { title?: string; okLabel?: string; destructive?: boolean } = {}): Promise<boolean> {
  if (host.confirm) return host.confirm(message, opts)
  return new Promise((resolve) => {
    overlay.confirm?.done(false)
    setOverlay({ confirm: { message, ...opts, done: resolve } })
  })
}

export function popupMenu(items: MenuSpec[]): Promise<void> {
  if (host.menu) return host.menu(items)
  return new Promise((resolve) => {
    overlay.menu?.done()
    setOverlay({ menu: { items, x: pointer.x, y: pointer.y, done: resolve } })
  })
}

let toastId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()
export const toastStore = {
  push(t: { kind?: ToastKind; text: string; ttl?: number | null; action?: ToastAction }): number {
    if (host.toast) { host.toast(t); return 0 }
    const kind = t.kind ?? 'info'
    const same = overlay.toasts.find((x) => x.text === t.text && x.kind === kind)
    if (same) overlays.dismiss(same.id)
    const id = toastId++
    setOverlay({ toasts: [...overlay.toasts, { id, kind, text: t.text, action: t.action }].slice(-4) })
    const ttl = t.ttl !== undefined ? t.ttl : kind === 'error' ? null : t.action ? 8000 : 5000
    if (ttl) timers.set(id, setTimeout(() => { timers.delete(id); overlays.dismiss(id) }, ttl))
    return id
  },
}

export function showNotification(id: string, title: string, body: string): Promise<void> {
  if (host.notify) return host.notify(id, title, body)
  return Promise.resolve()
}

/** A message in the app, from places that aren't components (the store). */
export function notify(text: string, ttl?: number) {
  toastStore.push({ text, ttl })
}
