import { useEffect, useState } from 'react'
import { listHosts, type ConnectRequest, type SavedHost } from '../lib/api'
import { VaultGate } from './VaultGate'
import { HostGrid } from './HostGrid'
import { HostDetailsPanel } from './HostDetailsPanel'

interface HostsSectionProps {
  onConnect: (request: ConnectRequest) => void
}

export function HostsSection({ onConnect }: HostsSectionProps) {
  const [hosts, setHosts] = useState<SavedHost[]>([])
  const [selection, setSelection] = useState<'none' | 'new' | string>('none')

  useEffect(() => {
    refreshHosts()
  }, [])

  function refreshHosts() {
    listHosts().then(setHosts)
  }

  const selectedHost = selection !== 'none' && selection !== 'new' ? hosts.find((h) => h.id === selection) : undefined

  return (
    <VaultGate>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <HostGrid
          hosts={hosts}
          selectedId={selection === 'new' ? null : selection === 'none' ? null : selection}
          onSelect={setSelection}
          onNewHost={() => setSelection('new')}
        />
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
        />
      </div>
    </VaultGate>
  )
}
