import type { MouseEvent } from 'react'
import { HostsIcon, PencilIcon, SnippetsIcon } from './icons'

interface HostCardProps {
  name: string
  summary: string
  authLabel: string | null
  // A local/visual highlight for whichever list renders this card; the main Hosts grid has
  // nothing to select into now that host details are a modal.
  selected?: boolean
  selectable?: boolean
  canConnect: boolean
  // Name of the collection this host is shared through, if any - so it's visible at a glance
  // that a host is one the whole team sees rather than a private one.
  collectionName?: string
  isConnecting?: boolean
  // True if this host has one or more startup snippets attached - shown as a small
  // unobtrusive badge so that's visible without having to open the edit modal.
  hasStartupSnippets?: boolean
  onSelect?: () => void
  onSsh: () => void
  onSftp: () => void
  // Pencil button opening the edit modal - omitted where there's nothing to edit.
  onEdit?: () => void
  // Right-click opens our own context menu instead of the browser's - omitted where none is offered.
  onContextMenu?: (event: MouseEvent) => void
}

// The card look from the Termius reference (issue #10), shared by HostGrid and
// RecentConnections so both render identically.
export function HostCard({
  name,
  summary,
  authLabel,
  selected,
  selectable,
  canConnect,
  collectionName,
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
      onContextMenu={selectable ? undefined : onContextMenu}
      className={`flex items-stretch gap-2 rounded border p-3 text-left ${
        selected ? 'border-indigo-500 bg-slate-900' : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
      }`}
    >
      {selectable && (
        <input
          type="checkbox"
          aria-label={`Select ${name}`}
          checked={selected}
          onChange={onSelect}
          className="mt-1 h-4 w-4 shrink-0 accent-indigo-500"
        />
      )}
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => !selectable && canConnect && onSsh()}
        title={selectable ? `Select ${name}` : canConnect ? 'Double-click to connect via SSH' : undefined}
        className="flex min-w-0 flex-1 flex-col items-start gap-1"
      >
        <HostsIcon aria-hidden="true" className="h-5 w-5 text-slate-400" />
        <span className="flex w-full min-w-0 items-center gap-1">
          <span className="truncate font-medium text-slate-100">{name}</span>
          {collectionName && (
            <span
              title={`Shared through ${collectionName}`}
              className="shrink-0 truncate rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-slate-400 uppercase"
            >
              {collectionName}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-1 truncate text-xs text-slate-400">
          <span className="truncate">{summary}</span>
          {hasStartupSnippets && (
            <span title="Has startup snippets" className="shrink-0">
              <SnippetsIcon aria-hidden="true" className="h-3 w-3" />
            </span>
          )}
        </span>
        {authLabel && (
          <span className={`truncate text-xs ${canConnect ? 'text-slate-500' : 'text-amber-500'}`} title={authLabel}>
            {authLabel}
          </span>
        )}
      </button>
      {!selectable && <div className="flex shrink-0 flex-col justify-center gap-1">
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
      </div>}
    </div>
  )
}
