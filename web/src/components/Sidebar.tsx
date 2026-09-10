import { useState } from 'react'
import { AppearanceIcon, CollectionsIcon, ForwardingIcon, HostsIcon, JobsIcon, KeychainIcon, LogsIcon, MenuIcon, SettingsIcon, SidebarToggleIcon, SnippetsIcon, SyncIcon, CloseIcon } from './icons'
import type { ComponentType, SVGProps } from 'react'

export type NavSection = 'hosts' | 'keychain' | 'snippets' | 'forwarding' | 'sync' | 'collections' | 'jobs' | 'logs' | 'appearance' | 'settings'

const SECTIONS: { id: Exclude<NavSection, 'settings'>; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: 'hosts', label: 'Hosts', icon: HostsIcon },
  { id: 'keychain', label: 'Keychain', icon: KeychainIcon },
  { id: 'forwarding', label: 'Port Forwarding', icon: ForwardingIcon },
  { id: 'sync', label: 'Folder Sync', icon: SyncIcon },
  // Distinct from Folder Sync above, which mirrors local <-> remote directories over SFTP
  // and has nothing to do with this - Collections syncs the VAULT over WebDAV.
  { id: 'collections', label: 'Collections', icon: CollectionsIcon },
  { id: 'jobs', label: 'Scheduled Jobs', icon: JobsIcon },
  { id: 'snippets', label: 'Snippets', icon: SnippetsIcon },
  { id: 'logs', label: 'Logs', icon: LogsIcon },
]

interface SidebarProps {
  active: NavSection
  onSelect: (section: NavSection) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  // Shown as a small dot over the Settings icon. See UpdateSection.tsx for the update UI.
  updateAvailable?: boolean
  // In the chromeless desktop app TitleBar owns the collapse toggle and Settings, so the
  // sidebar drops both to avoid duplicating them.
  hideChromeControls?: boolean
}

// The persistent left sidebar (issue #8's nav rail). Desktop gets a collapsible column;
// phones get a slim top bar whose menu button opens a full-screen overlay.
export function Sidebar({ active, onSelect, collapsed, onToggleCollapsed, updateAvailable, hideChromeControls }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  function selectAndClose(section: NavSection) {
    onSelect(section)
    setMobileOpen(false)
  }

  const itemClasses = (isActive: boolean) =>
    `flex items-center gap-3 rounded px-3 py-2 text-left text-sm ${
      isActive ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'
    }`

  const settingsIcon = (
    <span className="relative inline-flex shrink-0">
      <SettingsIcon aria-hidden="true" className="h-5 w-5" />
      {updateAvailable && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-indigo-400 ring-2 ring-slate-900"
        />
      )}
    </span>
  )

  return (
    <>
      {/* Desktop/tablet: persistent column, collapsible to icons-only. Hidden outright
          below the `sm` breakpoint - see the mobile bar below instead. */}
      <nav
        className={`hidden shrink-0 flex-col border-r border-slate-800 bg-slate-900 sm:flex ${
          collapsed ? 'sm:w-14' : 'sm:w-48'
        }`}
      >
        {/* Fixed-height header row, matched to TabBar's height so the two align as one
            toolbar. In the desktop app the toggle moves to the title bar, leaving a spacer. */}
        <div className="flex h-[42px] shrink-0 items-center justify-center border-b border-slate-800 px-1">
          {!hideChromeControls && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <SidebarToggleIcon aria-hidden="true" className={`h-5 w-5 ${collapsed ? 'rotate-180' : ''}`} />
            </button>
          )}
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
          {!hideChromeControls && (
            <>
              <button
                type="button"
                onClick={() => onSelect('appearance')}
                title="Appearance"
                className={`${itemClasses(active === 'appearance')} mt-auto`}
              >
                <AppearanceIcon aria-hidden="true" className="h-5 w-5 shrink-0" />
                {!collapsed && <span className="truncate">Appearance</span>}
              </button>
              <button
                type="button"
                onClick={() => onSelect('settings')}
                title="Settings"
                className={itemClasses(active === 'settings')}
              >
                {settingsIcon}
                {!collapsed && <span className="truncate">Settings</span>}
              </button>
            </>
          )}
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
                onClick={() => selectAndClose('appearance')}
                className={`${itemClasses(active === 'appearance')} mt-auto`}
              >
                <AppearanceIcon aria-hidden="true" className="h-5 w-5 shrink-0" />
                <span className="truncate">Appearance</span>
              </button>
              <button
                type="button"
                onClick={() => selectAndClose('settings')}
                className={itemClasses(active === 'settings')}
              >
                {settingsIcon}
                <span className="truncate">Settings</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
