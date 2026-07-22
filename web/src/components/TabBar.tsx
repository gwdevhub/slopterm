import { CloseIcon, SftpTabIcon, TerminalTabIcon } from './icons'

export interface SessionTab {
  id: string
  label: string
  kind: 'ssh' | 'sftp'
  // Only set for 'sftp' tabs - the remote pane's starting directory (see SftpView).
  homeDirectory?: string
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
            }`}
          >
            <button type="button" onClick={() => onSelect(tab.id)} className="flex max-w-40 items-center gap-1.5 truncate">
              <TabIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span className="truncate">{tab.label}</span>
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
