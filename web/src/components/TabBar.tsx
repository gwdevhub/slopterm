import type { ConnectRequest } from '../lib/api'
import { CloseIcon, SftpTabIcon, TerminalTabIcon } from './icons'

export interface SessionTab {
  // Stable client-generated key for the tab's whole lifetime - independent of the backend
  // session id, which doesn't exist yet while a restored tab is still reconnecting (see
  // App.tsx's attemptConnectTab/reconnectAllTabs).
  id: string
  sessionId: string | null
  label: string
  kind: 'ssh' | 'sftp'
  // Only set for 'sftp' tabs - the remote pane's starting directory (see SftpView).
  homeDirectory?: string
  // Kept alongside the tab so it can be persisted (see App.tsx's saveOpenTabs effect) and
  // retried without the user re-entering anything - restoring tabs across restarts is the
  // whole reason a tab needs to remember its own ConnectRequest at all.
  request: ConnectRequest
  status: 'connecting' | 'connected' | 'error'
  errorMessage?: string
}

interface TabBarProps {
  tabs: SessionTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
}

// One tab per open SSH/SFTP session (issue #9) - switching tabs must not kill the
// underlying WebSocket/SFTP connection of the inactive ones (App.tsx keeps every
// TerminalView/SftpView mounted, just hidden). New sessions are started from the
// sidebar's Hosts screen now (SSH/SFTP buttons on each host card), not from this bar -
// see Sidebar.tsx - so there's no "+" button here anymore.
export function TabBar({ tabs, activeId, onSelect, onClose }: TabBarProps) {
  return (
    <div className="flex h-[42px] shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-800 bg-slate-900 px-1">
      {tabs.map((tab) => {
        const TabIcon = tab.kind === 'sftp' ? SftpTabIcon : TerminalTabIcon
        return (
          <div
            key={tab.id}
            className={`flex shrink-0 items-center gap-2 rounded px-3 py-1.5 text-sm ${
              activeId === tab.id ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800'
            } ${tab.status !== 'connected' ? 'opacity-70' : ''}`}
          >
            <button type="button" onClick={() => onSelect(tab.id)} className="flex max-w-40 items-center gap-1.5 truncate">
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
    </div>
  )
}
