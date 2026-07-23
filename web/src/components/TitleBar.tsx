import { useEffect, useRef, useState } from 'react'
import { CloseIcon, MaximizeIcon, MenuIcon, MinimizeIcon, RestoreIcon } from './icons'
import { ContextMenu } from './ContextMenu'
import { onWindowMessage, sendWindowCommand } from '../lib/photino'
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

  const controlButton = 'app-no-drag flex h-8 w-11 items-center justify-center text-slate-400'

  return (
    <div className="app-drag flex h-8 shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900 select-none">
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
