import { useMemo, useState } from 'react'
import type { SavedHost } from '../lib/api'
import { resolveConnectRequest } from '../lib/hosts'
import { HostCard } from './HostCard'
import { GroupCard } from './GroupCard'
import { ArrowLeftIcon, PlusIcon } from './icons'

interface HostGridProps {
  hosts: SavedHost[]
  onNewHost: () => void
  onQuickConnect: () => void
  onImport: () => void
  onSsh: (host: SavedHost) => void
  onSftp: (host: SavedHost) => void
  onEditHost: (host: SavedHost) => void
  onHostContextMenu: (host: SavedHost, x: number, y: number) => void
  isConnecting?: boolean
}

function matchesQuery(host: SavedHost, q: string): boolean {
  return (
    host.host.name.toLowerCase().includes(q) ||
    host.host.address.toLowerCase().includes(q) ||
    host.host.credentials.some((c) => c.username?.toLowerCase().includes(q))
  )
}

// The searchable card grid from the Termius reference (issue #10). Single column on
// narrow screens, more columns as space allows - full mobile spec is issue #11. Hosts
// sharing the same HostRecord.ParentGroupId collapse into a single GroupCard (issue #14)
// instead of a card each - clicking it drills into just that group's members.
export function HostGrid({
  hosts,
  onNewHost,
  onQuickConnect,
  onImport,
  onSsh,
  onSftp,
  onEditHost,
  onHostContextMenu,
  isConnecting,
}: HostGridProps) {
  const [query, setQuery] = useState('')
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)

  const q = query.trim().toLowerCase()

  // Searching flattens every group into individual results - a group is purely an
  // organizational aid for *browsing*, not something worth navigating through once the
  // user already knows what they're looking for. Clearing the search resumes whichever
  // group was expanded (expandedGroup itself is left untouched while searching).
  const { groups, individualHosts } = useMemo(() => {
    if (q) {
      return { groups: [], individualHosts: hosts.filter((h) => matchesQuery(h, q)) }
    }

    if (expandedGroup !== null) {
      return { groups: [], individualHosts: hosts.filter((h) => h.host.parentGroupId === expandedGroup) }
    }

    const byGroup = new Map<string, SavedHost[]>()
    for (const h of hosts) {
      const groupName = h.host.parentGroupId
      if (!groupName) continue
      const members = byGroup.get(groupName)
      if (members) members.push(h)
      else byGroup.set(groupName, [h])
    }

    // A "group" of exactly one host isn't worth folding into a folder card - it just
    // renders as a normal individual card, same as an ungrouped host (its Group field is
    // still visible/editable in the details panel, it just doesn't collapse anything on
    // the grid until a second host actually joins it).
    const realGroups: { name: string; members: SavedHost[] }[] = []
    const ungrouped: SavedHost[] = []
    for (const h of hosts) {
      const groupName = h.host.parentGroupId
      const members = groupName ? byGroup.get(groupName) : undefined
      if (!members || members.length < 2) {
        ungrouped.push(h)
      }
    }
    for (const [name, members] of byGroup) {
      if (members.length >= 2) realGroups.push({ name, members })
    }

    return { groups: realGroups, individualHosts: ungrouped }
  }, [hosts, q, expandedGroup])

  return (
    <div className="flex flex-1 flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className="flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none"
          placeholder="Find a host or ssh user@hostname…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          onClick={onQuickConnect}
          className="flex items-center gap-1.5 rounded bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
        >
          Quick connect
        </button>
        <button
          type="button"
          onClick={onImport}
          className="flex items-center gap-1.5 rounded bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
        >
          Import
        </button>
        <button
          type="button"
          onClick={onNewHost}
          className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          <PlusIcon aria-hidden="true" className="h-4 w-4" />
          New host
        </button>
      </div>

      {expandedGroup !== null && !q && (
        <button
          type="button"
          onClick={() => setExpandedGroup(null)}
          className="flex w-fit items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200"
        >
          <ArrowLeftIcon aria-hidden="true" className="h-4 w-4" />
          All hosts
        </button>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
        {groups.map((group) => (
          <GroupCard
            key={group.name}
            name={group.name}
            hostCount={group.members.length}
            onOpen={() => setExpandedGroup(group.name)}
          />
        ))}
        {individualHosts.map((saved) => {
          const request = resolveConnectRequest(saved)
          const canConnect = request !== undefined
          // The port only earns a place in the at-a-glance summary when it's non-default -
          // ":22" on every single card would just be repetitive noise.
          const summary = request
            ? request.port === 22
              ? `${request.username}@${request.host}`
              : `${request.username}@${request.host}:${request.port}`
            : saved.host.address
          const authLabel = request ? (request.authMethod === 'privateKey' ? 'Private key' : 'Password') : null
          return (
            <HostCard
              key={saved.id}
              name={saved.host.name}
              summary={summary}
              authLabel={authLabel}
              canConnect={canConnect}
              isConnecting={isConnecting}
              hasStartupSnippets={(saved.host.startupSnippetIds?.length ?? 0) > 0}
              onSsh={() => onSsh(saved)}
              onSftp={() => onSftp(saved)}
              onEdit={() => onEditHost(saved)}
              onContextMenu={(event) => {
                event.preventDefault()
                onHostContextMenu(saved, event.clientX, event.clientY)
              }}
            />
          )
        })}
      </div>

      {groups.length === 0 && individualHosts.length === 0 && (
        <p className="text-sm text-slate-500">
          {hosts.length === 0 ? 'No saved hosts yet.' : q ? 'No hosts match your search.' : 'No hosts in this group.'}
        </p>
      )}
    </div>
  )
}
