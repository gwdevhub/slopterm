import { useEffect, useRef, useState } from 'react'
import type { ConnectRequest } from '../lib/api'
import { ContextMenu } from './ContextMenu'
import { CloseIcon, LocalTerminalTabIcon, SftpTabIcon, TerminalTabIcon } from './icons'

export interface SessionTab {
  // Stable client-generated key for the tab's whole lifetime - independent of the backend
  // session id, which doesn't exist yet while a restored tab is still reconnecting (see
  // App.tsx's attemptConnectTab/reconnectAllTabs).
  id: string
  sessionId: string | null
  label: string
  kind: 'ssh' | 'sftp' | 'local'
  // Only set for 'sftp' tabs - the remote pane's starting directory (see SftpView).
  homeDirectory?: string
  // Kept alongside the tab so it can be persisted (see App.tsx's saveOpenTabs effect) and
  // retried without the user re-entering anything - restoring tabs across restarts is the
  // whole reason a tab needs to remember its own ConnectRequest at all.
  // Undefined for a 'local' tab, which has no destination to dial and nothing to retry -
  // opening another one is always just "start a shell here".
  request?: ConnectRequest
  status: 'connecting' | 'connected' | 'error'
  errorMessage?: string
  // Resolved from the saved host's attached snippets at the moment this tab was created
  // (see lib/hosts.ts's resolveStartupCommands) - only meaningful for 'ssh' tabs.
  startupCommands?: string[]
}

interface TabBarProps {
  tabs: SessionTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  // Commit a new label for a tab (renameable tabs). Only ever called with a non-empty,
  // trimmed name - TabBar rejects blank renames before calling this.
  onRename: (id: string, label: string) => void
}

// One tab per open SSH/SFTP session (issue #9) - switching tabs must not kill the
// underlying WebSocket/SFTP connection of the inactive ones (App.tsx keeps every
// TerminalView/SftpView mounted, just hidden). New sessions are started from the
// sidebar's Hosts screen now (SSH/SFTP buttons on each host card), not from this bar -
// see Sidebar.tsx - so there's no "+" button here anymore.
//
// A tab can be renamed (double-click it, or right-click -> Rename) - the label is just a
// display string, so an inline <input> swaps in for the label button while editing and the
// committed name persists/restores for free (App.tsx already snapshots label). Mirrors the
// host-card gesture set: double-click for the common action, right-click for a menu.
export function TabBar({ tabs, activeId, onSelect, onClose, onRename }: TabBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus (and select-all, so typing replaces the old name) the edit field whenever one
  // opens - it's freshly mounted each time, so an effect keyed on editingId is enough.
  useEffect(() => {
    if (editingId) inputRef.current?.select()
  }, [editingId])

  function startEditing(tab: SessionTab) {
    setMenu(null)
    setDraft(tab.label)
    setEditingId(tab.id)
  }

  function commitEditing() {
    const id = editingId
    if (!id) return
    const trimmed = draft.trim()
    // A blank name is meaningless for a tab, so an empty/whitespace commit just cancels
    // and leaves the existing label untouched rather than wiping it.
    if (trimmed) onRename(id, trimmed)
    setEditingId(null)
  }

  return (
    <div className="flex h-[42px] shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-800 bg-slate-900 px-1">
      {tabs.map((tab) => {
        const TabIcon =
          tab.kind === 'sftp' ? SftpTabIcon : tab.kind === 'local' ? LocalTerminalTabIcon : TerminalTabIcon
        const isEditing = editingId === tab.id
        return (
          <div
            key={tab.id}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ id: tab.id, x: event.clientX, y: event.clientY })
            }}
            className={`flex shrink-0 items-center gap-2 rounded px-3 py-1.5 text-sm ${
              activeId === tab.id ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800'
            } ${tab.status !== 'connected' ? 'opacity-70' : ''}`}
          >
            {isEditing ? (
              <div className="flex items-center gap-1.5">
                <TabIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
                <input
                  ref={inputRef}
                  value={draft}
                  aria-label={`Rename ${tab.label}`}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commitEditing}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitEditing()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      setEditingId(null)
                    }
                  }}
                  // Stop clicks/double-clicks inside the field from re-selecting the tab or
                  // re-triggering the double-click-to-edit handler on the row.
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="w-32 rounded bg-slate-950/60 px-1 text-sm text-white outline-none ring-1 ring-indigo-400"
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                onDoubleClick={() => startEditing(tab)}
                className="flex max-w-40 items-center gap-1.5 truncate"
              >
                {tab.status === 'connecting' ? (
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
                  />
                ) : (
                  <TabIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
                )}
                <span className="truncate">{tab.label}</span>
                {tab.status === 'error' && <span aria-hidden="true" className="shrink-0 text-amber-400">⚠</span>}
              </button>
            )}
            <button
              type="button"
              aria-label={`Close ${tab.label}`}
              onClick={() => onClose(tab.id)}
              className="opacity-70 hover:opacity-100"
            >
              <CloseIcon aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Rename',
              onClick: () => {
                const tab = tabs.find((t) => t.id === menu.id)
                if (tab) startEditing(tab)
              },
            },
            { label: 'Close', danger: true, onClick: () => onClose(menu.id) },
          ]}
        />
      )}
    </div>
  )
}
