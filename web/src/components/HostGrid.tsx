import { useMemo, useState } from 'react'
import type { Collection, SavedHost } from '../lib/api'
import { describeCredentialResolution, resolveConnectRequest } from '../lib/hosts'
import { HostCard } from './HostCard'
import { GroupCard } from './GroupCard'
import { ArrowLeftIcon, LocalTerminalTabIcon, PlusIcon } from './icons'

interface HostGridProps {
  hosts: SavedHost[]
  onNewHost: () => void
  onQuickConnect: () => void
  onLocalShell: () => void
  // What a local shell would open here ("bash" on "Linux"), or null where this device
  // can't open one at all - in which case the button isn't rendered rather than rendered
  // and disabled, since there is nothing the user could do about it.
  localShell: { platform: string; shell: string } | null
  onImport: () => void
  onSsh: (host: SavedHost) => void
  onSftp: (host: SavedHost) => void
  onEditHost: (host: SavedHost) => void
  onHostContextMenu: (host: SavedHost, x: number, y: number) => void
  isConnecting?: boolean
  // Collection id -> name, for the badge on a shared host's card. Absent while the list is
  // still loading, or when this device holds no collections at all.
  collectionNames?: Record<string, string>
  collections: Collection[]
  selectedHostIds: Set<string>
  selectionMode: boolean
  bulkBusy: boolean
  onSelectionModeChange: (enabled: boolean) => void
  onSelectionChange: (ids: Set<string>) => void
  onMoveSelected: (collectionId: string) => void
  onDeleteSelected: () => void
}

function matchesQuery(host: SavedHost, q: string): boolean {
  return (
    host.host.name.toLowerCase().includes(q) ||
    host.host.address.toLowerCase().includes(q) ||
    host.host.credentials.some((c) => c.username?.toLowerCase().includes(q))
  )
}

function compareHosts(a: SavedHost, b: SavedHost): number {
  const aName = a.host.name.trim()
  const bName = b.host.name.trim()
  const options: Intl.CollatorOptions = { sensitivity: 'base', numeric: true }

  if (aName && bName) {
    const byName = aName.localeCompare(bName, undefined, options)
    if (byName !== 0) return byName
  } else if (aName || bName) {
    return aName ? -1 : 1
  }

  return a.host.address.localeCompare(b.host.address, undefined, options)
}

// The searchable card grid from the Termius reference (issue #10). Single column on
// narrow screens, more columns as space allows - full mobile spec is issue #11. Hosts
// sharing the same HostRecord.ParentGroupId collapse into a single GroupCard (issue #14)
// instead of a card each - clicking it drills into just that group's members.
export function HostGrid({
  hosts,
  onNewHost,
  onQuickConnect,
  onLocalShell,
  localShell,
  onImport,
  onSsh,
  onSftp,
  onEditHost,
  onHostContextMenu,
  isConnecting,
  collectionNames,
  collections,
  selectedHostIds,
  selectionMode,
  bulkBusy,
  onSelectionModeChange,
  onSelectionChange,
  onMoveSelected,
  onDeleteSelected,
}: HostGridProps) {
  const [query, setQuery] = useState('')
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [targetCollectionId, setTargetCollectionId] = useState('')

  const q = query.trim().toLowerCase()

  // Searching flattens every group into individual results - a group is purely an
  // organizational aid for *browsing*, not something worth navigating through once the
  // user already knows what they're looking for. Clearing the search resumes whichever
  // group was expanded (expandedGroup itself is left untouched while searching).
  const { groups, individualHosts } = useMemo(() => {
    const sortedHosts = hosts.toSorted(compareHosts)

    if (q || selectionMode) {
      return { groups: [], individualHosts: sortedHosts.filter((h) => matchesQuery(h, q)) }
    }

    if (expandedGroup !== null) {
      return { groups: [], individualHosts: sortedHosts.filter((h) => h.host.parentGroupId === expandedGroup) }
    }

    const byGroup = new Map<string, SavedHost[]>()
    for (const h of sortedHosts) {
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
    for (const h of sortedHosts) {
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
  }, [hosts, q, expandedGroup, selectionMode])

  const visibleIds = individualHosts.map((host) => host.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedHostIds.has(id))

  function toggleHost(id: string) {
    const next = new Set(selectedHostIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectionChange(next)
  }

  function toggleAllVisible() {
    const next = new Set(selectedHostIds)
    if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id))
    else visibleIds.forEach((id) => next.add(id))
    onSelectionChange(next)
  }

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
          onClick={() => onSelectionModeChange(!selectionMode)}
          disabled={hosts.length === 0 || bulkBusy}
          className="rounded bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
        >
          {selectionMode ? 'Cancel selection' : 'Select'}
        </button>
        <button
          type="button"
          onClick={onQuickConnect}
          className="flex items-center gap-1.5 rounded bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
        >
          Quick connect
        </button>
        {localShell && (
          <button
            type="button"
            onClick={onLocalShell}
            title={`Open a ${localShell.shell} shell on this ${localShell.platform} machine`}
            className="flex items-center justify-center gap-1.5 rounded bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
          >
            <LocalTerminalTabIcon aria-hidden="true" className="h-4 w-4" />
            Local shell
          </button>
        )}
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

      {selectionMode && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-slate-800 bg-slate-900/60 p-2">
          <label className="flex items-center gap-2 px-1 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleAllVisible}
              className="h-4 w-4 accent-indigo-500"
            />
            Select {q ? 'matches' : 'all'}
          </label>
          <span className="text-sm text-slate-400">{selectedHostIds.size} selected</span>
          <select
            aria-label="Destination collection"
            value={targetCollectionId}
            onChange={(event) => setTargetCollectionId(event.target.value)}
            className="min-w-44 flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-slate-500 focus:outline-none"
          >
            <option value="">Move to collection...</option>
            <option value="local">Private (this device)</option>
            {collections.map((collection) => (
              <option key={collection.id} value={collection.id}>{collection.name}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={selectedHostIds.size === 0 || !targetCollectionId || bulkBusy}
            onClick={() => onMoveSelected(targetCollectionId)}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Move
          </button>
          <button
            type="button"
            disabled={selectedHostIds.size === 0 || bulkBusy}
            onClick={onDeleteSelected}
            className="rounded bg-red-900/60 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      )}

      {expandedGroup !== null && !q && !selectionMode && (
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
          const canConnect = saved.canConnect
          const credential = saved.host.credentials[0]
          const username = request?.username ?? credential?.username ?? ''
          // The port only earns a place in the at-a-glance summary when it's non-default -
          // ":22" on every single card would just be repetitive noise.
          const summary = username
            ? saved.host.port === 22
              ? `${username}@${saved.host.address}`
              : `${username}@${saved.host.address}:${saved.host.port}`
            : saved.host.address
          // For a host that names its key, say which key actually resolved on THIS device -
          // a host must never silently connect with something other than what its card
          // claims, and "no key on this device" is a state worth showing rather than hiding.
          const authLabel =
            describeCredentialResolution(saved) ??
            (credential?.kind === 'privateKey' ? 'Private key' : credential?.kind === 'password' ? 'Password' : null)
          return (
            <HostCard
              key={saved.id}
              name={saved.host.name}
              summary={summary}
              authLabel={authLabel}
              selected={selectedHostIds.has(saved.id)}
              selectable={selectionMode}
              canConnect={canConnect}
              collectionName={collectionNames?.[saved.collectionId]}
              isConnecting={isConnecting}
              hasStartupSnippets={(saved.host.startupSnippetIds?.length ?? 0) > 0}
              onSelect={selectionMode ? () => toggleHost(saved.id) : undefined}
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
