import { FolderIcon } from './icons'

interface GroupCardProps {
  name: string
  hostCount: number
  onOpen: () => void
}

// A folder-style card standing in for every host sharing a HostRecord.ParentGroupId, shown
// on the top-level grid instead of those hosts' own cards (issue #14).
export function GroupCard({ name, hostCount, onOpen }: GroupCardProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col items-start gap-1 rounded border border-slate-800 bg-slate-900/60 p-3 text-left hover:border-slate-700"
    >
      <FolderIcon aria-hidden="true" className="h-5 w-5 text-slate-400" />
      <span className="truncate font-medium text-slate-100">{name}</span>
      <span className="truncate text-xs text-slate-400">
        {hostCount} host{hostCount === 1 ? '' : 's'}
      </span>
    </button>
  )
}
