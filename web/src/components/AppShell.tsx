import { useState } from 'react'
import { NavRail, type NavSection } from './NavRail'
import { HostsSection } from './HostsSection'
import { SnippetsSection } from './SnippetsSection'
import { LogsSection } from './LogsSection'
import { KeychainSection } from './KeychainSection'
import { ConnectionForm, type ConnectionFormInitialValues } from './ConnectionForm'
import { RecentConnections } from './RecentConnections'
import { SettingsPage } from './SettingsPage'
import type { ConnectRequest } from '../lib/api'

interface AppShellProps {
  onConnect: (request: ConnectRequest) => void
  errorMessage: string | null
  isConnecting: boolean
}

const COMING_SOON: Record<Exclude<NavSection, 'quickConnect' | 'hosts' | 'keychain' | 'snippets' | 'logs' | 'settings'>, string> = {
  portForwarding: 'Port Forwarding',
  knownHosts: 'Known Hosts',
}

// The persistent 3-pane app shell from the Termius reference (issue #8): a left nav
// rail, a main content area per section, and (for Hosts) a right-hand details panel.
export function AppShell({ onConnect, errorMessage, isConnecting }: AppShellProps) {
  const [section, setSection] = useState<NavSection>('quickConnect')
  const [prefill, setPrefill] = useState<ConnectionFormInitialValues | undefined>(undefined)

  return (
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      <NavRail active={section} onSelect={setSection} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {section === 'quickConnect' && (
          <>
            <ConnectionForm
              key={JSON.stringify(prefill)}
              submitLabel="Connect"
              isSubmitting={isConnecting}
              errorMessage={errorMessage}
              initialValues={prefill}
              onSubmit={(values) =>
                onConnect({
                  host: values.host,
                  port: values.port,
                  username: values.username,
                  authMethod: values.authMethod,
                  password: values.password,
                  privateKey: values.privateKey,
                  passphrase: values.passphrase,
                  columns: 80,
                  rows: 24,
                })
              }
            />
            <RecentConnections onSelect={setPrefill} />
          </>
        )}
        {section === 'hosts' && <HostsSection onConnect={onConnect} />}
        {section === 'keychain' && <KeychainSection />}
        {section === 'snippets' && <SnippetsSection />}
        {section === 'logs' && <LogsSection />}
        {section === 'settings' && <SettingsPage />}
        {section in COMING_SOON && (
          <p className="p-4 text-slate-500">{COMING_SOON[section as keyof typeof COMING_SOON]} is coming soon.</p>
        )}
      </div>
    </div>
  )
}
