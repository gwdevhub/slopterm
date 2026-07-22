import type { SessionTab } from './TabBar'

interface ReconnectingPaneProps {
  tab: SessionTab
  onRetryNow: () => void
}

// Shown in place of TerminalView/SftpView for a tab that isn't connected yet - either a
// tab restored from a previous run still working through its automatic retry loop
// (App.tsx's attemptConnectTab), or one that failed and is waiting for its next scheduled
// attempt. The tab itself stays in the bar the whole time (see TabBar's spinner/warning
// icon) so "reconnecting" reads as a temporary state of an existing tab, not a missing one.
export function ReconnectingPane({ tab, onRetryNow }: ReconnectingPaneProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-black p-4 text-center">
      {tab.status === 'connecting' ? (
        <>
          <span
            aria-hidden="true"
            className="h-6 w-6 animate-spin rounded-full border-2 border-slate-400 border-t-transparent"
          />
          <p className="text-sm text-slate-300">Reconnecting to {tab.label}…</p>
        </>
      ) : (
        <>
          <p className="text-sm text-amber-300">Couldn't reconnect to {tab.label}</p>
          {tab.errorMessage && <p className="max-w-sm text-xs text-slate-500">{tab.errorMessage}</p>}
          <p className="text-xs text-slate-500">Retrying automatically…</p>
          <button
            type="button"
            onClick={onRetryNow}
            className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700"
          >
            Retry now
          </button>
        </>
      )}
    </div>
  )
}
