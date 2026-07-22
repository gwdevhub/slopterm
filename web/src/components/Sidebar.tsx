import { useState } from 'react'
import {
  HostsIcon,
  KeychainIcon,
  KnownHostsIcon,
  LogsIcon,
  MenuIcon,
  PortForwardingIcon,
  SettingsIcon,
  SidebarToggleIcon,
  SnippetsIcon,
  CloseIcon,
} from './icons'
import type { ComponentType, SVGProps } from 'react'

export type NavSection = 'hosts' | 'keychain' | 'portForwarding' | 'snippets' | 'knownHosts' | 'logs' | 'settings'

const SECTIONS: { id: Exclude<NavSection, 'settings'>; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: 'hosts', label: 'Hosts', icon: HostsIcon },
  { id: 'keychain', label: 'Keychain', icon: KeychainIcon },
  { id: 'portForwarding', label: 'Port Forwarding', icon: PortForwardingIcon },
  { id: 'snippets', label: 'Snippets', icon: SnippetsIcon },
  { id: 'knownHosts', label: 'Known Hosts', icon: KnownHostsIcon },
  { id: 'logs', label: 'Logs', icon: LogsIcon },
]

interface SidebarProps {
  active: NavSection
  onSelect: (section: NavSection) => void
  collapsed: boolean
  onToggleCollapsed: () => void
}

// The persistent left sidebar (issue #8's nav rail, now always visible - there's no more
// "Quick Connect" view to fall back to when no tab is open, see App.tsx). Desktop/tablet
// gets a real collapsible column; phones get a slim top bar with just a menu button that
// opens a full-screen overlay instead, since a permanently-visible icon column has no
// room at phone width.
export function Sidebar({ active, onSelect, collapsed, onToggleCollapsed }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  function selectAndClose(section: NavSection) {
    onSelect(section)
    setMobileOpen(false)
  }

  const itemClasses = (isActive: boolean) =>
    `flex items-center gap-3 rounded px-3 py-2 text-left text-sm ${
      isActive ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'
    }`

  return (
    <>
      {/* Desktop/tablet: persistent column, collapsible to icons-only. Hidden outright
          below the `sm` breakpoint - see the mobile bar below instead. */}
      <nav
        className={`hidden shrink-0 flex-col border-r border-slate-800 bg-slate-900 sm:flex ${
          collapsed ? 'sm:w-14' : 'sm:w-48'
        }`}
      >
        {/* Fixed-height header row, deliberately the same height as TabBar's row so the
            two align visually as one continuous toolbar across the top of the app. */}
        <div className="flex h-[42px] shrink-0 items-center justify-center border-b border-slate-800 px-1">
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <SidebarToggleIcon aria-hidden="true" className={`h-5 w-5 ${collapsed ? 'rotate-180' : ''}`} />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => onSelect(section.id)}
              title={section.label}
              className={itemClasses(active === section.id)}
            >
              <section.icon aria-hidden="true" className="h-5 w-5 shrink-0" />
              {!collapsed && <span className="truncate">{section.label}</span>}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSelect('settings')}
            title="Settings"
            className={`${itemClasses(active === 'settings')} mt-auto`}
          >
            <SettingsIcon aria-hidden="true" className="h-5 w-5 shrink-0" />
            {!collapsed && <span className="truncate">Settings</span>}
          </button>
        </div>
      </nav>

      {/* Mobile: a slim top bar with only a menu button - opens a full overlay with every
          section spelled out, since there's no room for a persistent icon column here. */}
      <div className="flex h-[42px] shrink-0 items-center border-b border-slate-800 bg-slate-900 px-2 sm:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          className="rounded p-1.5 text-slate-300 hover:bg-slate-800"
        >
          <MenuIcon aria-hidden="true" className="h-5 w-5" />
        </button>
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex sm:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <div className="relative flex w-64 max-w-[80vw] flex-col bg-slate-900">
            <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-slate-800 px-3">
              <span className="text-sm font-medium text-slate-300">Menu</span>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              >
                <CloseIcon aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
            <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
              {SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => selectAndClose(section.id)}
                  className={itemClasses(active === section.id)}
                >
                  <section.icon aria-hidden="true" className="h-5 w-5 shrink-0" />
                  <span className="truncate">{section.label}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => selectAndClose('settings')}
                className={`${itemClasses(active === 'settings')} mt-auto`}
              >
                <SettingsIcon aria-hidden="true" className="h-5 w-5 shrink-0" />
                <span className="truncate">Settings</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
