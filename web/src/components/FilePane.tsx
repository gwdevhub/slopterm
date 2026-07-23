import { useEffect, useState, type DragEvent, type MouseEvent } from 'react'
import type { FsEntry, FsListing } from '../lib/api'
import { ConfirmDialog } from './ConfirmDialog'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { FileIcon, FolderIcon } from './icons'

export type FilePaneSide = 'local' | 'remote'

export interface DraggedFile {
  side: FilePaneSide
  path: string
}

// A file-management action the parent (SftpView) carries out on a full entry path - it's
// the one place that knows about both panes, so rename/delete/mkdir/transfer all live
// there and FilePane just drives the UI (selection, menu, confirm/prompt) that invokes them.
export interface FilePaneActions {
  rename: (path: string, newName: string) => Promise<void>
  remove: (paths: string[]) => Promise<void>
  makeDirectory: (parentDir: string, name: string) => Promise<void>
  // Uploads (local pane) or downloads (remote pane) the given entries onto the other pane.
  transfer: (paths: string[]) => Promise<void>
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
  actions: FilePaneActions
  // Verb shown for the transfer menu item ("Upload" on the local pane, "Download" on the
  // remote one) - the direction is inherent to which side this pane is.
  transferLabel: string
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
// one thing here that needs to know about both panes at once. Right-clicking an entry (or
// the pane background) opens a context menu of file-management actions, and Ctrl/Shift+
// click builds a multi-selection those actions apply to in bulk.
export function FilePane({ title, side, initialPath, list, reloadToken, onPathChange, onDropFile, onDropOsFiles, actions, transferLabel }: FilePaneProps) {
  const [path, setPath] = useState<string | undefined>(initialPath)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  // Selected entry *names* (unique within a listing), plus the last-clicked name so a
  // subsequent Shift+click knows where the range starts.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null)
  const [renaming, setRenaming] = useState<FsEntry | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [confirming, setConfirming] = useState<FsEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    list(path)
      .then((result) => {
        if (!cancelled) {
          setListing(result)
          setError(null)
          onPathChange(result.path)
          // A fresh listing invalidates any selection carried over from the old directory.
          setSelected(new Set())
          setAnchor(null)
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

  const entries = listing?.entries ?? []
  // The entries backing the current selection, in listing order (bulk actions apply to these).
  const selectedEntries = entries.filter((e) => selected.has(e.name))

  function fullPath(entry: FsEntry): string {
    return joinPath(listing!.path, entry.name)
  }

  // Ctrl/Cmd toggles one entry; Shift extends a contiguous range from the anchor; a plain
  // click replaces the whole selection with just this entry (and re-anchors here).
  function selectEntry(entry: FsEntry, event: MouseEvent) {
    if (event.shiftKey && anchor) {
      const names = entries.map((e) => e.name)
      const from = names.indexOf(anchor)
      const to = names.indexOf(entry.name)
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        setSelected(new Set(names.slice(lo, hi + 1)))
        return
      }
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(entry.name)) next.delete(entry.name)
        else next.add(entry.name)
        return next
      })
      setAnchor(entry.name)
      return
    }
    setSelected(new Set([entry.name]))
    setAnchor(entry.name)
  }

  // A modifier-click is a pure selection gesture; a plain click on a directory still
  // navigates into it (matching the original single-click-to-open behavior).
  function handleEntryClick(entry: FsEntry, event: MouseEvent) {
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      selectEntry(entry, event)
      return
    }
    setSelected(new Set([entry.name]))
    setAnchor(entry.name)
    if (entry.isDirectory && listing) setPath(fullPath(entry))
  }

  // Right-clicking an unselected entry selects just it first, so the menu's bulk actions
  // act on what was clicked rather than a stale multi-selection; right-clicking one that's
  // already part of the selection keeps the whole set.
  function handleEntryContextMenu(entry: FsEntry, event: MouseEvent) {
    event.preventDefault()
    // Stop the event bubbling to the <ul>'s handlePaneContextMenu, which would otherwise
    // fire right after and overwrite this entry menu with the pane-level ("New folder"
    // only) one - leaving a right-clicked file with no Rename/Delete/etc.
    event.stopPropagation()
    if (!selected.has(entry.name)) {
      setSelected(new Set([entry.name]))
      setAnchor(entry.name)
    }
    setMenu({ x: event.clientX, y: event.clientY, entry })
  }

  // Right-clicking empty space in the pane offers the directory-level action (New folder)
  // without a target entry.
  function handlePaneContextMenu(event: MouseEvent) {
    event.preventDefault()
    setMenu({ x: event.clientX, y: event.clientY, entry: null })
  }

  async function handleMakeDirectory(name: string) {
    if (!listing) return
    setCreatingFolder(false)
    try {
      await actions.makeDirectory(listing.path, name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder')
    }
  }

  async function handleRenameConfirm(newName: string) {
    if (!renaming || !listing) return
    const entry = renaming
    setRenaming(null)
    try {
      await actions.rename(fullPath(entry), newName)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename')
    }
  }

  async function handleDeleteConfirm() {
    if (!confirming || !listing) return
    const targets = confirming
    setConfirming(null)
    try {
      await actions.remove(targets.map(fullPath))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  async function handleTransfer(targets: FsEntry[]) {
    if (!listing || targets.length === 0) return
    try {
      await actions.transfer(targets.map(fullPath))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transfer failed')
    }
  }

  async function copyPath(entry: FsEntry) {
    if (!listing) return
    try {
      await navigator.clipboard.writeText(fullPath(entry))
    } catch {
      // Clipboard access is best-effort - not worth surfacing an error for.
    }
  }

  function menuItems(): ContextMenuItem[] {
    const items: ContextMenuItem[] = []
    const target = menu?.entry
    if (target) {
      // Bulk actions act on the whole selection when the target is part of it; otherwise
      // just the clicked entry (handleEntryContextMenu already narrowed the selection).
      const targets = selected.has(target.name) ? selectedEntries : [target]
      const files = targets.filter((e) => !e.isDirectory)
      const single = targets.length === 1
      items.push({ label: 'Rename', onClick: () => setRenaming(target), disabled: !single })
      // Directories can't be transferred yet (recursive up/download isn't supported).
      items.push({ label: single ? transferLabel : `${transferLabel} ${files.length} files`, onClick: () => void handleTransfer(files), disabled: files.length === 0 })
      items.push({ label: 'Copy path', onClick: () => void copyPath(target), disabled: !single })
      items.push({ label: single ? 'Delete' : `Delete ${targets.length} items`, onClick: () => setConfirming(targets), danger: true })
    }
    items.push({ label: 'New folder', onClick: () => setCreatingFolder(true) })
    return items
  }

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
        <button
          type="button"
          aria-label={`New folder in ${title}`}
          onClick={() => setCreatingFolder(true)}
          className="shrink-0 rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-700"
        >
          New folder
        </button>
      </div>

      {error && <p className="p-3 text-sm text-red-300">{error}</p>}

      <ul
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onContextMenu={handlePaneContextMenu}
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
        {entries.map((entry) => (
          <li key={entry.name}>
            <button
              type="button"
              draggable={!entry.isDirectory}
              aria-pressed={selected.has(entry.name)}
              onDragStart={(event) => {
                if (!listing) return
                const file: DraggedFile = { side, path: fullPath(entry) }
                event.dataTransfer.setData('application/x-slopterm-file', JSON.stringify(file))
                event.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={(event) => handleEntryClick(entry, event)}
              onContextMenu={(event) => handleEntryContextMenu(entry, event)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-800 ${
                selected.has(entry.name) ? 'bg-indigo-950/60 text-slate-100' : 'text-slate-300'
              }`}
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

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}

      {renaming && (
        <NamePrompt
          title="Rename"
          submitLabel="Rename"
          initialValue={renaming.name}
          // A no-op rename (unchanged name) just closes, matching the original behavior.
          onSubmit={(name) => (name === renaming.name ? setRenaming(null) : void handleRenameConfirm(name))}
          onCancel={() => setRenaming(null)}
        />
      )}

      {creatingFolder && (
        <NamePrompt
          title="New folder"
          submitLabel="Create"
          initialValue=""
          onSubmit={(name) => void handleMakeDirectory(name)}
          onCancel={() => setCreatingFolder(false)}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title={confirming.length === 1 ? `Delete “${confirming[0].name}”?` : `Delete ${confirming.length} items?`}
          message={
            confirming.length === 1
              ? `This permanently deletes ${confirming[0].isDirectory ? 'the folder and its contents' : 'the file'}.`
              : 'This permanently deletes the selected items (folders include their contents).'
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  )
}

interface NamePromptProps {
  title: string
  submitLabel: string
  initialValue: string
  onSubmit: (name: string) => void
  onCancel: () => void
}

// A tiny styled prompt for entering a leaf name (Rename / New folder) - window.prompt()
// can't be driven by Playwright the way an in-DOM field can, and it matches the rest of
// the app's own-modal-over-browser-dialog convention (see ConfirmDialog's doc comment).
// Submitting an empty/whitespace name just cancels, so callers never get a blank name.
function NamePrompt({ title, submitLabel, initialValue, onSubmit, onCancel }: NamePromptProps) {
  const [value, setValue] = useState(initialValue)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = value.trim()
          if (trimmed) onSubmit(trimmed)
          else onCancel()
        }}
        className="w-full max-w-sm rounded border border-slate-700 bg-slate-900 p-5"
      >
        <h3 className="font-semibold text-slate-100">{title}</h3>
        <input
          aria-label="Name"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancel()
          }}
          className="mt-3 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700">
            Cancel
          </button>
          <button type="submit" className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
