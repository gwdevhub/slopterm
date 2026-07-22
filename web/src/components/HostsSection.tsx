import { useEffect, useState } from 'react'
import { listHosts, type ConnectRequest, type SavedHost } from '../lib/api'
import { resolveConnectRequest } from '../lib/hosts'
import { VaultGate } from './VaultGate'
import { HostGrid } from './HostGrid'
import { HostDetailsPanel } from './HostDetailsPanel'
import { RecentConnections, type RecentConnection } from './RecentConnections'
import type { ConnectionFormInitialValues } from './ConnectionForm'

interface HostsSectionProps {
  onConnect: (request: ConnectRequest) => void
  onConnectSftp: (request: ConnectRequest, label: string) => void
  errorMessage: string | null
  isConnecting: boolean
}

export function HostsSection({ onConnect, onConnectSftp, errorMessage, isConnecting }: HostsSectionProps) {
  const [hosts, setHosts] = useState<SavedHost[]>([])
  const [selection, setSelection] = useState<'none' | 'new' | 'connect' | string>('none')
  const [connectPrefill, setConnectPrefill] = useState<ConnectionFormInitialValues | undefined>(undefined)

  useEffect(() => {
    refreshHosts()
  }, [])

  function refreshHosts() {
    listHosts().then(setHosts)
  }

  function handleRecentSelect(recent: RecentConnection) {
    setConnectPrefill(recent)
    setSelection('connect')
  }

  function handleSsh(host: SavedHost) {
    const request = resolveConnectRequest(host)
    if (request) onConnect(request)
  }

  function handleSftp(host: SavedHost) {
    const request = resolveConnectRequest(host)
    if (request) onConnectSftp(request, host.host.name)
  }

  const selectedHost = selection !== 'none' && selection !== 'new' && selection !== 'connect' ? hosts.find((h) => h.id === selection) : undefined

  // The 'new'/'connect' modes already show this inline via ConnectionForm's own
  // errorMessage prop - showing it a second time here would be redundant.
  const showBannerHere = selection !== 'new' && selection !== 'connect'

  return (
    <VaultGate>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          {showBannerHere && errorMessage && (
            <p className="mx-3 mt-3 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300 sm:mx-4 sm:mt-4">
              {errorMessage}
            </p>
          )}
          <RecentConnections onSelect={handleRecentSelect} />
          <HostGrid
            hosts={hosts}
            selectedId={selection === 'new' || selection === 'connect' ? null : selection === 'none' ? null : selection}
            onSelect={setSelection}
            onNewHost={() => setSelection('new')}
            onSsh={handleSsh}
            onSftp={handleSftp}
            isConnecting={isConnecting}
          />
        </div>
        <HostDetailsPanel
          mode={selection === 'new' ? 'new' : selection === 'connect' ? 'connect' : selection === 'none' ? 'empty' : 'view'}
          host={selectedHost}
          connectPrefill={connectPrefill}
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
          errorMessage={selection === 'connect' ? errorMessage : undefined}
          isConnecting={isConnecting}
        />
      </div>
    </VaultGate>
  )
}
