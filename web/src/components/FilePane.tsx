import { useEffect, useState } from 'react'
import type { FsListing } from '../lib/api'
import { FileIcon, FolderIcon } from './icons'

interface FilePaneProps {
  title: string
  initialPath?: string
  list: (path?: string) => Promise<FsListing>
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

// One side of the dual-pane SFTP browser (issue: host card "SFTP" button) - identical UI
// for both the local pane and the remote pane, since the backend normalizes both to the
// same FsListing shape (server/SftpSession.cs's ListDirectory / LocalFileSystem.cs).
// Browsing only for now - upload/download/transfer between the two panes is a natural
// follow-up, not implemented here.
export function FilePane({ title, initialPath, list }: FilePaneProps) {
  const [path, setPath] = useState<string | undefined>(initialPath)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    list(path)
      .then((result) => {
        if (!cancelled) {
          setListing(result)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to list directory')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  return (
    <div role="region" aria-label={title} className="flex min-h-0 min-w-0 flex-1 flex-col border-slate-800 sm:border-r last:border-r-0">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-2 text-sm">
        <span className="shrink-0 font-medium text-slate-200">{title}</span>
        <span className="min-w-0 flex-1 truncate text-slate-500">{listing?.path ?? ''}</span>
      </div>

      {error && <p className="p-3 text-sm text-red-300">{error}</p>}

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {listing?.parent != null && (
          <li>
            <button
              type="button"
              onClick={() => setPath(listing.parent!)}
              className="w-full px-3 py-1.5 text-left text-sm text-slate-400 hover:bg-slate-800"
            >
              ..
            </button>
          </li>
        )}
        {listing?.entries.map((entry) => (
          <li key={entry.name}>
            <button
              type="button"
              disabled={!entry.isDirectory}
              onClick={() => {
                if (!entry.isDirectory || !listing) return
                const base = listing.path.endsWith('/') ? listing.path : `${listing.path}/`
                setPath(`${base}${entry.name}`)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-300 hover:bg-slate-800 disabled:hover:bg-transparent"
            >
              {entry.isDirectory ? (
                <FolderIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
              ) : (
                <FileIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-500" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {!entry.isDirectory && <span className="ml-auto shrink-0 text-xs text-slate-500">{formatSize(entry.size)}</span>}
            </button>
          </li>
        ))}
        {listing && listing.entries.length === 0 && (
          <li className="px-3 py-2 text-sm text-slate-500">Empty directory.</li>
        )}
      </ul>
    </div>
  )
}
