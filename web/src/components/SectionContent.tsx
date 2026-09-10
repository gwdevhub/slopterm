import { HostsSection } from './HostsSection'
import { SnippetsSection } from './SnippetsSection'
import { LogsSection } from './LogsSection'
import { KeychainSection } from './KeychainSection'
import { PortForwardingSection } from './PortForwardingSection'
import { SyncSection } from './SyncSection'
import { CollectionsSection } from './CollectionsSection'
import { JobsSection } from './JobsSection'
import { SettingsPage } from './SettingsPage'
import { AppearancePage } from './AppearancePage'
import type { NavSection } from './Sidebar'
import type { ConnectRequest } from '../lib/api'

interface SectionContentProps {
  section: NavSection
  onConnect: (request: ConnectRequest, startupCommands?: string[]) => Promise<boolean>
  onConnectSftp: (request: ConnectRequest, label: string) => Promise<boolean>
  onConnectLocal: () => Promise<boolean>
  errorMessage: string | null
  isConnecting: boolean
}

// Renders whichever sidebar section is currently active. App.tsx owns the section state and
// the Sidebar itself.
export function SectionContent({
  section,
  onConnect,
  onConnectSftp,
  onConnectLocal,
  errorMessage,
  isConnecting,
}: SectionContentProps) {
  return (
    <>
      {section === 'hosts' && (
        <HostsSection
          onConnect={onConnect}
          onConnectSftp={onConnectSftp}
          onConnectLocal={onConnectLocal}
          errorMessage={errorMessage}
          isConnecting={isConnecting}
        />
      )}
      {section === 'keychain' && <KeychainSection />}
      {section === 'snippets' && <SnippetsSection />}
      {section === 'forwarding' && <PortForwardingSection />}
      {section === 'sync' && <SyncSection />}
      {section === 'collections' && <CollectionsSection />}
      {section === 'jobs' && <JobsSection />}
      {section === 'logs' && <LogsSection />}
      {section === 'appearance' && <AppearancePage />}
      {section === 'settings' && <SettingsPage />}
    </>
  )
}
