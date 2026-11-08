// A small floating panel under an anchor, closed by Escape or a click outside.
// Used where a native menu can't do the job (search, rich rows).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Popover({ anchor, onClose, children, width = 300, className = '' }: {
  anchor: HTMLElement
  onClose: () => void
  children: ReactNode
  width?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number }>({ left: 0, top: 0, maxHeight: 400 })

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    const below = window.innerHeight - r.bottom - 12
    const above = r.top - 12
    if (below >= 240 || below >= above) setPos({ left, top: r.bottom + 4, maxHeight: Math.max(160, below) })
    else setPos({ left, top: Math.max(8, r.top - Math.min(420, above) - 4), maxHeight: Math.min(420, above) })
  }, [anchor, width])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [anchor, onClose])

  return createPortal(
    <div className="oc-composer-layer">
      <div ref={ref} className={`wf-popover ${className}`} style={{ left: pos.left, top: pos.top, width, maxHeight: pos.maxHeight }} role="dialog">
        {children}
      </div>
    </div>,
    document.body,
  )
}
