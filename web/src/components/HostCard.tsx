import type { MouseEvent } from 'react'
import { HostsIcon } from './icons'

interface HostCardProps {
  name: string
  summary: string
  authLabel: string | null
  selected: boolean
  canConnect: boolean
  isConnecting?: boolean
  onSelect: () => void
  onSsh: () => void
  onSftp: () => void
  // Right-click anywhere on the card opens our own context menu (Connect/Edit/…) instead
  // of the browser's - omitted for lists that don't offer one (e.g. Recent connections).
  onContextMenu?: (event: MouseEvent) => void
}

// The card look from the Termius reference (issue #10) - shared by HostGrid (saved
// hosts) and RecentConnections so both lists render identically instead of Recent having
// its own, different-looking row style.
export function HostCard({ name, summary, authLabel, selected, canConnect, isConnecting, onSelect, onSsh, onSftp, onContextMenu }: HostCardProps) {
  return (
    <div
      onContextMenu={onContextMenu}
      className={`flex items-stretch gap-2 rounded border p-3 text-left ${
        selected ? 'border-indigo-500 bg-slate-900' : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => canConnect && onSsh()}
        title={canConnect ? 'Double-click to connect via SSH' : undefined}
        className="flex min-w-0 flex-1 flex-col items-start gap-1"
      >
        <HostsIcon aria-hidden="true" className="h-5 w-5 text-slate-400" />
        <span className="truncate font-medium text-slate-100">{name}</span>
        <span className="truncate text-xs text-slate-400">{summary}</span>
        {authLabel && <span className="truncate text-xs text-slate-500">{authLabel}</span>}
      </button>
      <div className="flex shrink-0 flex-col justify-center gap-1">
        <button
          type="button"
          aria-label={`SSH to ${name}`}
          disabled={!canConnect || isConnecting}
          onClick={onSsh}
          className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          SSH
        </button>
        <button
          type="button"
          aria-label={`SFTP to ${name}`}
          disabled={!canConnect || isConnecting}
          onClick={onSftp}
          className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
        >
          SFTP
        </button>
      </div>
    </div>
  )
}
