import { HostsSection } from './HostsSection'
import { SnippetsSection } from './SnippetsSection'
import { LogsSection } from './LogsSection'
import { KeychainSection } from './KeychainSection'
import { SettingsPage } from './SettingsPage'
import type { NavSection } from './Sidebar'
import type { ConnectRequest } from '../lib/api'

interface SectionContentProps {
  section: NavSection
  onConnect: (request: ConnectRequest) => void
  onConnectSftp: (request: ConnectRequest, label: string) => void
  errorMessage: string | null
  isConnecting: boolean
}

const COMING_SOON: Record<Exclude<NavSection, 'hosts' | 'keychain' | 'snippets' | 'logs' | 'settings'>, string> = {
  portForwarding: 'Port Forwarding',
  knownHosts: 'Known Hosts',
}

// Renders whichever sidebar section is currently active. App.tsx owns both the section
// state and the always-visible Sidebar itself now - this file used to be "AppShell" when
// it also owned the nav rail (issue #8), but that's been hoisted out so more than one
// connection tab can stay open alongside a visible section at once.
export function SectionContent({ section, onConnect, onConnectSftp, errorMessage, isConnecting }: SectionContentProps) {
  return (
    <>
      {section === 'hosts' && (
        <HostsSection
          onConnect={onConnect}
          onConnectSftp={onConnectSftp}
          errorMessage={errorMessage}
          isConnecting={isConnecting}
        />
      )}
      {section === 'keychain' && <KeychainSection />}
      {section === 'snippets' && <SnippetsSection />}
      {section === 'logs' && <LogsSection />}
      {section === 'settings' && <SettingsPage />}
      {section in COMING_SOON && (
        <p className="p-4 text-slate-500">{COMING_SOON[section as keyof typeof COMING_SOON]} is coming soon.</p>
      )}
    </>
  )
}
