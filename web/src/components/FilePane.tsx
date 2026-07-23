import { useEffect, useState, type DragEvent } from 'react'
import type { FsListing } from '../lib/api'
import { FileIcon, FolderIcon } from './icons'

export type FilePaneSide = 'local' | 'remote'

export interface DraggedFile {
  side: FilePaneSide
  path: string
}

interface FilePaneProps {
  title: string
  side: FilePaneSide
  initialPath?: string
  list: (path?: string) => Promise<FsListing>
  // Bumped by the parent (SftpView) to force a re-fetch of the *current* path after a
  // transfer lands a new file here - path itself doesn't change, so it can't be a
  // useEffect dependency on its own.
  reloadToken: number
  onPathChange: (path: string) => void
  onDropFile: (file: DraggedFile) => void
  // OS files dragged from the file manager (Explorer/Finder/Nautilus) onto this pane -
  // distinct from onDropFile's in-app pane-to-pane drag, since these carry real bytes (a
  // FileList) rather than the app's custom application/x-slopterm-file payload.
  onDropOsFiles: (files: FileList) => void
}

// An OS-file drag (from the file manager) surfaces the real File objects in
// dataTransfer.files and lists "Files" in dataTransfer.types - neither is true for the
// app's own pane-to-pane drag, which uses a custom MIME type instead.
function isOsFileDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files')
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

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

// One side of the dual-pane SFTP browser (issue: host card "SFTP" button) - identical UI
// for both the local pane and the remote pane, since the backend normalizes both to the
// same FsListing shape (server/SftpSession.cs's ListDirectory / LocalFileSystem.cs).
// Files (not directories - dragging a folder isn't supported yet) are draggable onto the
// *other* pane to upload/download them; SftpView owns the actual transfer since it's the
// one thing here that needs to know about both panes at once.
export function FilePane({ title, side, initialPath, list, reloadToken, onPathChange, onDropFile, onDropOsFiles }: FilePaneProps) {
  const [path, setPath] = useState<string | undefined>(initialPath)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    let cancelled = false
    list(path)
      .then((result) => {
        if (!cancelled) {
          setListing(result)
          setError(null)
          onPathChange(result.path)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to list directory')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadToken])

  function handleDragOver(event: DragEvent) {
    // Accept both the app's own pane-to-pane drag and OS files dragged in from outside.
    if (!event.dataTransfer.types.includes('application/x-slopterm-file') && !isOsFileDrag(event.dataTransfer)) return
    event.preventDefault()
    setDragOver(true)
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault()
    setDragOver(false)
    if (isOsFileDrag(event.dataTransfer)) {
      if (event.dataTransfer.files.length > 0) onDropOsFiles(event.dataTransfer.files)
      return
    }
    const raw = event.dataTransfer.getData('application/x-slopterm-file')
    if (!raw) return
    const file: DraggedFile = JSON.parse(raw)
    if (file.side === side) return // dropped on its own pane - nothing to do
    onDropFile(file)
  }

  return (
    <div role="region" aria-label={title} className="flex min-h-0 min-w-0 flex-1 flex-col border-slate-800 sm:border-r last:border-r-0">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-2 text-sm">
        <span className="shrink-0 font-medium text-slate-200">{title}</span>
        <span className="min-w-0 flex-1 truncate text-slate-500">{listing?.path ?? ''}</span>
      </div>

      {error && <p className="p-3 text-sm text-red-300">{error}</p>}

      <ul
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`min-h-0 flex-1 overflow-y-auto ${dragOver ? 'bg-indigo-950/40 outline-dashed outline-2 -outline-offset-2 outline-indigo-500' : ''}`}
      >
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
              draggable={!entry.isDirectory}
              onDragStart={(event) => {
                if (!listing) return
                const file: DraggedFile = { side, path: joinPath(listing.path, entry.name) }
                event.dataTransfer.setData('application/x-slopterm-file', JSON.stringify(file))
                event.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => {
                if (!entry.isDirectory || !listing) return
                setPath(joinPath(listing.path, entry.name))
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
