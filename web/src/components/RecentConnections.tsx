import { useEffect, useState } from 'react'
import { listRecentConnections, type SavedRecentConnection } from '../lib/api'
import { HostCard } from './HostCard'

interface RecentConnectionsProps {
  // Bumped whenever a new ad hoc connection is remembered so this list re-fetches; there's
  // no push channel from the backend.
  refreshToken: number
  onSsh: (recent: SavedRecentConnection) => void
  onSftp: (recent: SavedRecentConnection) => void
  isConnecting?: boolean
}

// Sits below the host card grid: unlike the old log-derived list, these entries retain the
// credential used, so reconnecting is one click away.
export function RecentConnections({ refreshToken, onSsh, onSftp, isConnecting }: RecentConnectionsProps) {
  const [recents, setRecents] = useState<SavedRecentConnection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    listRecentConnections()
      .then(setRecents)
      .catch(() => setRecents([]))
  }, [refreshToken])

  if (recents.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col gap-2 p-3 pt-0 sm:p-4 sm:pt-0">
      <h2 className="text-sm font-medium text-slate-300">Recent</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
        {recents.map((recent) => (
          <HostCard
            key={recent.id}
            name={recent.connection.host}
            summary={`${recent.connection.username}@${recent.connection.host}:${recent.connection.port}`}
            authLabel={recent.connection.authMethod === 'privateKey' ? 'Private key' : 'Password'}
            selected={selectedId === recent.id}
            canConnect
            isConnecting={isConnecting}
            onSelect={() => setSelectedId(recent.id)}
            onSsh={() => onSsh(recent)}
            onSftp={() => onSftp(recent)}
          />
        ))}
      </div>
    </div>
  )
}
