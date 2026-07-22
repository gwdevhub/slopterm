import { useMemo, useState } from 'react'
import type { SavedHost } from '../lib/api'
import { HostsIcon, PlusIcon } from './icons'

interface HostGridProps {
  hosts: SavedHost[]
  selectedId: string | null
  onSelect: (id: string) => void
  onNewHost: () => void
}

// The searchable card grid from the Termius reference (issue #10). Single column on
// narrow screens, more columns as space allows - full mobile spec is issue #11.
export function HostGrid({ hosts, selectedId, onSelect, onNewHost }: HostGridProps) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return hosts
    return hosts.filter(
      (h) =>
        h.host.name.toLowerCase().includes(q) ||
        h.host.address.toLowerCase().includes(q) ||
        h.host.credentials.some((c) => c.username?.toLowerCase().includes(q)),
    )
  }, [hosts, query])

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
          onClick={onNewHost}
          className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          <PlusIcon aria-hidden="true" className="h-4 w-4" />
          New host
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((saved) => {
          const usernames = [...new Set(saved.host.credentials.map((c) => c.username).filter(Boolean))]
          return (
            <button
              key={saved.id}
              type="button"
              onClick={() => onSelect(saved.id)}
              className={`flex flex-col items-start gap-1 rounded border p-3 text-left ${
                selectedId === saved.id
                  ? 'border-indigo-500 bg-slate-900'
                  : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
              }`}
            >
              <HostsIcon aria-hidden="true" className="h-5 w-5 text-slate-400" />
              <span className="truncate font-medium text-slate-100">{saved.host.name}</span>
              <span className="truncate text-xs text-slate-400">
                {usernames.length > 0 ? usernames.join(', ') : saved.host.address}
              </span>
            </button>
          )
        })}
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-slate-500">
          {hosts.length === 0 ? 'No saved hosts yet.' : 'No hosts match your search.'}
        </p>
      )}
    </div>
  )
}
