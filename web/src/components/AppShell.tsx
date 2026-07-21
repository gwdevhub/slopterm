import { useState } from 'react'
import { NavRail, type NavSection } from './NavRail'
import { HostsSection } from './HostsSection'
import { SnippetsSection } from './SnippetsSection'
import { LogsSection } from './LogsSection'
import { ConnectForm } from './ConnectForm'
import type { ConnectRequest } from '../lib/api'

interface AppShellProps {
  onConnect: (request: ConnectRequest) => void
  errorMessage: string | null
  isConnecting: boolean
}

const COMING_SOON: Record<Exclude<NavSection, 'quickConnect' | 'hosts' | 'snippets' | 'logs'>, string> = {
  keychain: 'Keychain',
  portForwarding: 'Port Forwarding',
  knownHosts: 'Known Hosts',
}

// The persistent 3-pane app shell from the Termius reference (issue #8): a left nav
// rail, a main content area per section, and (for Hosts) a right-hand details panel.
export function AppShell({ onConnect, errorMessage, isConnecting }: AppShellProps) {
  const [section, setSection] = useState<NavSection>('quickConnect')

  return (
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      <NavRail active={section} onSelect={setSection} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {section === 'quickConnect' && (
          <ConnectForm onConnect={onConnect} errorMessage={errorMessage} isConnecting={isConnecting} />
        )}
        {section === 'hosts' && <HostsSection onConnect={onConnect} />}
        {section === 'snippets' && <SnippetsSection />}
        {section === 'logs' && <LogsSection />}
        {section in COMING_SOON && (
          <p className="p-4 text-slate-500">{COMING_SOON[section as keyof typeof COMING_SOON]} is coming soon.</p>
        )}
      </div>
    </div>
  )
}
