import type { MouseEvent } from 'react'
import { HostsIcon, PencilIcon, SnippetsIcon } from './icons'

interface HostCardProps {
  name: string
  summary: string
  authLabel: string | null
  // Purely a local/visual highlight for whichever list is rendering this card (e.g.
  // RecentConnections tracks its own selected id) - optional since the main Hosts grid
  // has nothing to select *into* anymore now that host details are a modal, not a
  // persistent side panel.
  selected?: boolean
  canConnect: boolean
  isConnecting?: boolean
  // True if this host has one or more startup snippets attached - shown as a small
  // unobtrusive badge so that's visible without having to open the edit modal.
  hasStartupSnippets?: boolean
  onSelect?: () => void
  onSsh: () => void
  onSftp: () => void
  // Small pencil button in the card's bottom-right corner opening the edit modal -
  // omitted for lists with nothing to edit (e.g. Recent connections, which aren't saved
  // Host records).
  onEdit?: () => void
  // Right-click anywhere on the card opens our own context menu (Connect/Edit/…) instead
  // of the browser's - omitted for lists that don't offer one (e.g. Recent connections).
  onContextMenu?: (event: MouseEvent) => void
}

// The card look from the Termius reference (issue #10) - shared by HostGrid (saved
// hosts) and RecentConnections so both lists render identically instead of Recent having
// its own, different-looking row style.
export function HostCard({
  name,
  summary,
  authLabel,
  selected,
  canConnect,
  isConnecting,
  hasStartupSnippets,
  onSelect,
  onSsh,
  onSftp,
  onEdit,
  onContextMenu,
}: HostCardProps) {
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
        <span className="flex min-w-0 items-center gap-1 truncate text-xs text-slate-400">
          <span className="truncate">{summary}</span>
          {hasStartupSnippets && (
            <span title="Has startup snippets" className="shrink-0">
              <SnippetsIcon aria-hidden="true" className="h-3 w-3" />
            </span>
          )}
        </span>
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
        {onEdit && (
          <button
            type="button"
            aria-label={`Edit ${name}`}
            onClick={onEdit}
            className="flex items-center justify-center rounded bg-slate-800 px-2 py-1 text-slate-300 hover:bg-slate-700"
          >
            <PencilIcon aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
