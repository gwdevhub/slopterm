import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

// One shared right-click menu, rendered through a portal so it's never clipped and clamped
// into the viewport; dismissed by Escape, an outside press, scroll, or resize.
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Measure once mounted, then nudge back inside the viewport if it would overflow.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const clampedX = Math.min(x, Math.max(8, window.innerWidth - width - 8))
    const clampedY = Math.min(y, Math.max(8, window.innerHeight - height - 8))
    setPos({ x: clampedX, y: clampedY })
  }, [x, y])

  useEffect(() => {
    // A mousedown inside the menu is a real selection in progress - let the item's own
    // onClick fire and close; only an outside press dismisses.
    function onPointerDown(event: MouseEvent) {
      if (ref.current?.contains(event.target as Node)) return
      onClose()
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    // Any scroll (captured, so inner scrollers count) or resize invalidates the anchor - just close.
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ top: pos.y, left: pos.x }}
      className="fixed z-50 min-w-44 overflow-hidden rounded-md border border-slate-700 bg-slate-900 py-1 shadow-xl shadow-black/40"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) => (
        <button
          key={index}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            item.onClick()
            onClose()
          }}
          className={`block w-full px-3 py-1.5 text-left text-sm disabled:opacity-40 disabled:hover:bg-transparent ${
            item.danger ? 'text-red-300 hover:bg-red-950/60' : 'text-slate-200 hover:bg-slate-800'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
