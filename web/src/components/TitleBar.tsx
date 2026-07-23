import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { CloseIcon, MaximizeIcon, MenuIcon, MinimizeIcon, RestoreIcon } from './icons'
import { ContextMenu } from './ContextMenu'
import { onWindowMessage, sendWindowCommand, sendWindowDrag } from '../lib/photino'
import type { NavSection } from './Sidebar'

interface TitleBarProps {
  collapsed: boolean
  onToggleCollapsed: () => void
  onSelectSection: (section: NavSection) => void
  // Mirrors the sidebar's Settings dot when a startup update check finds a new version -
  // Settings lives in the hamburger here, so the cue moves onto the hamburger button.
  updateAvailable?: boolean
}

// The app's own title bar for the chromeless desktop window (server makes the OS window
// borderless - see AppWindowManager). One integrated bar at the top: a hamburger menu on
// the left holding the app-chrome actions that used to sit in the sidebar (collapse,
// Settings), and the window's minimize/maximize/close controls on the right, at the same
// height. The whole bar is draggable to move the window (CSS app-region); the buttons and
// the hamburger opt back out so they stay clickable. Only rendered inside Photino (see
// isDesktopApp) - a normal browser keeps its own chrome and the sidebar keeps these controls.
export function TitleBar({ collapsed, onToggleCollapsed, onSelectSection, updateAvailable }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const hamburgerRef = useRef<HTMLButtonElement>(null)
  // The pointer id of an in-progress title-bar drag (null when not dragging), plus a
  // requestAnimationFrame coalescer so a fast drag posts at most one window-move per frame
  // instead of one per pointermove event.
  const dragPointerRef = useRef<number | null>(null)
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null)
  const rafRef = useRef<number | null>(null)

  // Physical (device) pixels - MouseEvent.screenX/Y are CSS pixels, but the native window's
  // coordinates are physical, so scale by devicePixelRatio to keep dragging 1:1 under
  // display scaling (e.g. 150%).
  const toPhysical = (value: number) => Math.round(value * window.devicePixelRatio)

  useEffect(() => {
    onWindowMessage((message) => {
      if (message === 'wc:maximized') setMaximized(true)
      else if (message === 'wc:restored') setMaximized(false)
    })
    // Ask the backend for the current state so the glyph starts correct.
    sendWindowCommand('ready')
  }, [])

  function openMenu() {
    const rect = hamburgerRef.current?.getBoundingClientRect()
    if (rect) setMenu({ x: rect.left, y: rect.bottom + 2 })
  }

  // Window drag by following the pointer: the CSS `-webkit-app-region: drag` on the bar only
  // moves the window on WebView2 runtimes that honor the experimental draggable-regions flag
  // (see AppWindowManager); on the ones that ignore it the bar is a normal DOM region and
  // these handlers fire instead, repositioning the native window to track the pointer. Where
  // the flag *does* work the draggable region swallows the pointer events so this never runs,
  // so the two coexist. Left button only, and never when the press starts on a control (the
  // buttons opt out of dragging) so their clicks still register.
  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button, .app-no-drag')) return
    // Capture so pointermove/up keep coming to this element even as the cursor leaves it
    // (and even as the window moves out from under it).
    event.currentTarget.setPointerCapture(event.pointerId)
    dragPointerRef.current = event.pointerId
    sendWindowDrag('start', toPhysical(event.screenX), toPhysical(event.screenY))
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragPointerRef.current !== event.pointerId) return
    pendingMoveRef.current = { x: toPhysical(event.screenX), y: toPhysical(event.screenY) }
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        const move = pendingMoveRef.current
        if (move) sendWindowDrag('move', move.x, move.y)
      })
    }
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragPointerRef.current !== event.pointerId) return
    dragPointerRef.current = null
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Capture may already be gone (e.g. pointercancel) - nothing to release.
    }
  }

  const controlButton = 'app-no-drag flex h-8 w-11 items-center justify-center text-slate-400'

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="app-drag flex h-8 shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900 select-none"
    >
      <div className="flex items-center">
        <button
          ref={hamburgerRef}
          type="button"
          onClick={openMenu}
          aria-label="Menu"
          className={`${controlButton} relative hover:bg-slate-800 hover:text-slate-200`}
        >
          <MenuIcon aria-hidden="true" className="h-4 w-4" />
          {updateAvailable && (
            <span aria-hidden="true" className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-indigo-400 ring-2 ring-slate-900" />
          )}
        </button>
        <span className="px-1 text-xs font-medium text-slate-500">slopterm</span>
      </div>

      <div className="flex items-center">
        <button type="button" onClick={() => sendWindowCommand('min')} aria-label="Minimize" className={`${controlButton} hover:bg-slate-800 hover:text-slate-100`}>
          <MinimizeIcon aria-hidden="true" className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => sendWindowCommand('max')}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          className={`${controlButton} hover:bg-slate-800 hover:text-slate-100`}
        >
          {maximized ? <RestoreIcon aria-hidden="true" className="h-4 w-4" /> : <MaximizeIcon aria-hidden="true" className="h-4 w-4" />}
        </button>
        <button type="button" onClick={() => sendWindowCommand('close')} aria-label="Close" className={`${controlButton} hover:bg-red-600 hover:text-white`}>
          <CloseIcon aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: collapsed ? 'Expand sidebar' : 'Collapse sidebar', onClick: onToggleCollapsed },
            { label: 'Settings', onClick: () => onSelectSection('settings') },
          ]}
        />
      )}
    </div>
  )
}
