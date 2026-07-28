import { useEffect, useState } from 'react'
import { listSshConfigHosts, type SshConfigHostEntry } from '../lib/api'
import { resolveSshConfigConnectRequest } from '../lib/hosts'
import { isMobileApp } from '../lib/androidBridge'
import { HostCard } from './HostCard'

interface SshConfigHostsProps {
  enabled: boolean
  onSsh: (entry: SshConfigHostEntry) => void
  onSftp: (entry: SshConfigHostEntry) => void
  isConnecting?: boolean
}

// Sits below Recent on the Hosts screen, behind Settings' "Show hosts from ~/.ssh/config"
// toggle (off by default). Read-only cards sourced live from the file on every mount -
// never a second host store, and there's nothing here to edit/delete through the app
// (no onEdit/onContextMenu, same as RecentConnections). An alias with no resolvable
// private key (relies on ssh-agent/interactive auth) still gets a card, just with
// disabled SSH/SFTP buttons - it's still a useful at-a-glance list of what's in the file.
// Same best-effort fetch posture as Recent/Keychain: a failed/missing config just renders
// nothing.
export function SshConfigHosts({ enabled, onSsh, onSftp, isConnecting }: SshConfigHostsProps) {
  const [entries, setEntries] = useState<SshConfigHostEntry[]>([])

  useEffect(() => {
    if (!enabled || isMobileApp()) {
      setEntries([])
      return
    }
    listSshConfigHosts()
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [enabled])

  if (!enabled || entries.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col gap-2 p-3 pt-0 sm:p-4 sm:pt-0">
      <h2 className="text-sm font-medium text-slate-300">From ~/.ssh/config</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
        {entries.map((entry) => (
          <HostCard
            key={entry.alias}
            name={entry.alias}
            summary={`${entry.username}@${entry.hostName}${entry.port === 22 ? '' : `:${entry.port}`}`}
            authLabel={entry.privateKey ? 'Private key' : 'No key found - not connectable'}
            canConnect={resolveSshConfigConnectRequest(entry) !== undefined}
            isConnecting={isConnecting}
            onSsh={() => onSsh(entry)}
            onSftp={() => onSftp(entry)}
          />
        ))}
      </div>
    </div>
  )
}
