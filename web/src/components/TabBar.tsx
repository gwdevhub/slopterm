import { CloseIcon, PlusIcon } from './icons'

export interface SessionTab {
  id: string
  label: string
}

interface TabBarProps {
  tabs: SessionTab[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

// One tab per open SSH session (issue #9) - switching tabs must not kill the underlying
// WebSocket of the inactive ones (App.tsx keeps every TerminalView mounted, just hidden).
export function TabBar({ tabs, activeId, onSelect, onClose, onNew }: TabBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-800 bg-slate-900 px-1 py-1">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`flex shrink-0 items-center gap-2 rounded px-3 py-1.5 text-sm ${
            activeId === tab.id ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800'
          }`}
        >
          <button type="button" onClick={() => onSelect(tab.id)} className="max-w-40 truncate">
            {tab.label}
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
      ))}
      <button
        type="button"
        aria-label="New tab"
        onClick={onNew}
        className={`shrink-0 rounded px-3 py-1.5 text-sm ${
          activeId === null ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'
        }`}
      >
        <PlusIcon aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  )
}
