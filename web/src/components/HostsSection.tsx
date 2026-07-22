import { useEffect, useState } from 'react'
import { listHosts, upsertRecentConnection, type ConnectRequest, type SavedHost, type SavedRecentConnection } from '../lib/api'
import { resolveConnectRequest, resolveRecentConnectRequest } from '../lib/hosts'
import { VaultGate } from './VaultGate'
import { HostGrid } from './HostGrid'
import { HostDetailsPanel } from './HostDetailsPanel'
import { RecentConnections } from './RecentConnections'
import { QuickConnectModal } from './QuickConnectModal'
import type { ConnectionFormValues } from './ConnectionForm'

interface HostsSectionProps {
  onConnect: (request: ConnectRequest) => Promise<boolean>
  onConnectSftp: (request: ConnectRequest, label: string) => Promise<boolean>
  errorMessage: string | null
  isConnecting: boolean
}

export function HostsSection({ onConnect, onConnectSftp, errorMessage, isConnecting }: HostsSectionProps) {
  const [hosts, setHosts] = useState<SavedHost[]>([])
  const [selection, setSelection] = useState<'none' | 'new' | string>('none')
  const [quickConnectOpen, setQuickConnectOpen] = useState(false)
  const [recentsRefreshToken, setRecentsRefreshToken] = useState(0)

  useEffect(() => {
    refreshHosts()
  }, [])

  function refreshHosts() {
    listHosts().then(setHosts)
  }

  // Ad hoc connections (Quick Connect, or reconnecting via an existing Recent) remember
  // their credential so next time is one click/double-click away - see
  // RecentConnectionRecord's doc comment for why this is a separate store from Hosts.
  function rememberRecent(request: ConnectRequest) {
    void upsertRecentConnection({
      host: request.host,
      port: request.port,
      username: request.username,
      authMethod: request.authMethod,
      secret: request.authMethod === 'password' ? request.password : request.privateKey,
      passphrase: request.authMethod === 'privateKey' ? request.passphrase : undefined,
    }).then(() => setRecentsRefreshToken((n) => n + 1))
  }

  async function handleQuickConnectSubmit(values: ConnectionFormValues) {
    const request: ConnectRequest = {
      host: values.host,
      port: values.port,
      username: values.username,
      authMethod: values.authMethod,
      password: values.password,
      privateKey: values.privateKey,
      passphrase: values.passphrase,
      columns: 80,
      rows: 24,
    }
    if (await onConnect(request)) rememberRecent(request)
  }

  function handleSsh(host: SavedHost) {
    const request = resolveConnectRequest(host)
    if (request) void onConnect(request)
  }

  function handleSftp(host: SavedHost) {
    const request = resolveConnectRequest(host)
    if (request) void onConnectSftp(request, host.host.name)
  }

  async function handleRecentSsh(recent: SavedRecentConnection) {
    const request = resolveRecentConnectRequest(recent)
    if (await onConnect(request)) rememberRecent(request)
  }

  async function handleRecentSftp(recent: SavedRecentConnection) {
    const request = resolveRecentConnectRequest(recent)
    if (await onConnectSftp(request, `${recent.connection.username}@${recent.connection.host}`)) rememberRecent(request)
  }

  const selectedHost = selection !== 'none' && selection !== 'new' ? hosts.find((h) => h.id === selection) : undefined

  // 'new' mode and the Quick Connect modal both already show this inline via
  // ConnectionForm's own errorMessage prop - showing it a second time here would be
  // redundant (and, for the modal specifically, an ambiguous duplicate match in tests).
  const showBannerHere = selection !== 'new' && !quickConnectOpen

  return (
    <VaultGate>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {showBannerHere && errorMessage && (
            <p className="mx-3 mt-3 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300 sm:mx-4 sm:mt-4">
              {errorMessage}
            </p>
          )}
          <HostGrid
            hosts={hosts}
            selectedId={selection === 'new' || selection === 'none' ? null : selection}
            onSelect={setSelection}
            onNewHost={() => setSelection('new')}
            onQuickConnect={() => setQuickConnectOpen(true)}
            onSsh={handleSsh}
            onSftp={handleSftp}
            isConnecting={isConnecting}
          />
          <RecentConnections
            refreshToken={recentsRefreshToken}
            onSsh={handleRecentSsh}
            onSftp={handleRecentSftp}
            isConnecting={isConnecting}
          />
        </div>
        <HostDetailsPanel
          mode={selection === 'new' ? 'new' : selection === 'none' ? 'empty' : 'view'}
          host={selectedHost}
          onConnect={onConnect}
          onDeleted={() => {
            setSelection('none')
            refreshHosts()
          }}
          onSaved={() => {
            setSelection('none')
            refreshHosts()
          }}
          onClose={() => setSelection('none')}
          isConnecting={isConnecting}
        />
      </div>
      {quickConnectOpen && (
        <QuickConnectModal
          onSubmit={handleQuickConnectSubmit}
          onClose={() => setQuickConnectOpen(false)}
          errorMessage={errorMessage}
          isConnecting={isConnecting}
        />
      )}
    </VaultGate>
  )
}
