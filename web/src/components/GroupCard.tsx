import { FolderIcon } from './icons'

interface GroupCardProps {
  name: string
  hostCount: number
  onOpen: () => void
}

// A folder-style card standing in for every host sharing the same HostRecord.ParentGroupId
// - shown instead of those hosts' own individual cards on the top-level grid (issue #14).
// Clicking it drills into just that group's members (HostGrid owns the "which group is
// expanded" state); there's no direct connect affordance here since a group has no single
// connection target of its own.
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
