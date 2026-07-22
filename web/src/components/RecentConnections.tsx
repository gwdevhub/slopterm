import { useEffect, useState } from 'react'
import { listLogs, type SavedLogEntry } from '../lib/api'

export interface RecentConnection {
  host: string
  port: number
  username: string
}

interface RecentConnectionsProps {
  onSelect: (recent: RecentConnection) => void
}

const MAX_RECENTS = 5

// logs are already newest-first (see VaultService.ListLogs), so the first "connected"
// entry seen for a given host/port/username is already its most recent one.
function recentsFromLogs(logs: SavedLogEntry[]): (RecentConnection & { key: string; timestamp: string })[] {
  const seen = new Set<string>()
  const recents: (RecentConnection & { key: string; timestamp: string })[] = []
  for (const log of logs) {
    if (log.entry.event !== 'connected') continue
    const key = `${log.entry.username}@${log.entry.host}:${log.entry.port}`
    if (seen.has(key)) continue
    seen.add(key)
    recents.push({ key, host: log.entry.host, port: log.entry.port, username: log.entry.username, timestamp: log.timestamp })
    if (recents.length >= MAX_RECENTS) break
  }
  return recents
}

// Sits above the host card grid on the Hosts screen (replaces the old standalone Quick
// Connect page) so a previous destination is one click away instead of retyping
// host/port/username. Only host/port/username are logged (see LogEntryRecord), never
// credentials, so selecting a recent just prefills the connect form - the user still
// supplies a password/key. HostsSection is always vault-gated, but the fetch stays
// best-effort (like the Keychain lookup in ConnectionForm) so a transient failure just
// means this section renders nothing rather than blocking the rest of the page.
export function RecentConnections({ onSelect }: RecentConnectionsProps) {
  const [recents, setRecents] = useState<(RecentConnection & { key: string; timestamp: string })[]>([])

  useEffect(() => {
    listLogs()
      .then((logs) => setRecents(recentsFromLogs(logs)))
      .catch(() => setRecents([]))
  }, [])

  if (recents.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col gap-2 p-3 pb-0 sm:p-4 sm:pb-0">
      <h2 className="text-sm font-medium text-slate-300">Recent</h2>
      <ul className="flex flex-col gap-1">
        {recents.map((recent) => (
          <li key={recent.key}>
            <button
              type="button"
              onClick={() => onSelect(recent)}
              className="flex w-full items-center justify-between rounded border border-slate-800 bg-slate-900 px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-800"
            >
              <span className="truncate">{recent.username}@{recent.host}:{recent.port}</span>
              <span className="shrink-0 text-xs text-slate-500">{new Date(recent.timestamp).toLocaleString()}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
