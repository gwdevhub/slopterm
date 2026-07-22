import {
  HostsIcon,
  KeychainIcon,
  KnownHostsIcon,
  LogsIcon,
  PortForwardingIcon,
  QuickConnectIcon,
  SettingsIcon,
  SnippetsIcon,
} from './icons'
import type { ComponentType, SVGProps } from 'react'

export type NavSection =
  | 'quickConnect'
  | 'hosts'
  | 'keychain'
  | 'portForwarding'
  | 'snippets'
  | 'knownHosts'
  | 'logs'
  | 'settings'

const SECTIONS: { id: Exclude<NavSection, 'settings'>; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: 'quickConnect', label: 'Quick Connect', icon: QuickConnectIcon },
  { id: 'hosts', label: 'Hosts', icon: HostsIcon },
  { id: 'keychain', label: 'Keychain', icon: KeychainIcon },
  { id: 'portForwarding', label: 'Port Forwarding', icon: PortForwardingIcon },
  { id: 'snippets', label: 'Snippets', icon: SnippetsIcon },
  { id: 'knownHosts', label: 'Known Hosts', icon: KnownHostsIcon },
  { id: 'logs', label: 'Logs', icon: LogsIcon },
]

interface NavRailProps {
  active: NavSection
  onSelect: (section: NavSection) => void
}

// The persistent left icon-rail from the Termius reference (issue #8). Collapses to a
// horizontal bottom bar on narrow screens per AGENTS.md's mobile-first requirement - the
// full mobile-responsive spec is issue #11, this is the baseline stacking.
export function NavRail({ active, onSelect }: NavRailProps) {
  const buttonClasses = (isActive: boolean) =>
    `flex shrink-0 items-center gap-2 rounded px-3 py-2 text-left text-sm whitespace-nowrap ${
      isActive ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'
    }`

  return (
    <nav
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-800 bg-slate-900 p-2
                 sm:w-40 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r"
    >
      {SECTIONS.map((section) => (
        <button key={section.id} type="button" onClick={() => onSelect(section.id)} className={buttonClasses(active === section.id)}>
          <section.icon aria-hidden="true" className="h-5 w-5 shrink-0" />
          {section.label}
        </button>
      ))}
      {/* Pinned to the bottom of the sidebar on desktop (sm:mt-auto), not part of the
          scrollable section list. */}
      <button
        type="button"
        onClick={() => onSelect('settings')}
        className={`${buttonClasses(active === 'settings')} sm:mt-auto`}
      >
        <SettingsIcon aria-hidden="true" className="h-5 w-5 shrink-0" />
        Settings
      </button>
    </nav>
  )
}
