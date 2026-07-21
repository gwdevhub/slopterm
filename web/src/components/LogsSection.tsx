import { useEffect, useState } from 'react'
import { clearLogs, listLogs, type SavedLogEntry } from '../lib/api'
import { VaultGate } from './VaultGate'

const EVENT_STYLES: Record<SavedLogEntry['entry']['event'], string> = {
  connected: 'text-emerald-400',
  connect_failed: 'text-red-400',
  disconnected: 'text-slate-400',
}

const EVENT_LABELS: Record<SavedLogEntry['entry']['event'], string> = {
  connected: 'Connected',
  connect_failed: 'Connect failed',
  disconnected: 'Disconnected',
}

export function LogsSection() {
  return (
    <VaultGate>
      <LogsList />
    </VaultGate>
  )
}

function LogsList() {
  const [logs, setLogs] = useState<SavedLogEntry[]>([])

  useEffect(() => {
    refresh()
  }, [])

  function refresh() {
    listLogs().then(setLogs)
  }

  async function handleClear() {
    await clearLogs()
    refresh()
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-100">Logs</h2>
        {logs.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            className="rounded bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700"
          >
            Clear logs
          </button>
        )}
      </div>

      <ul className="flex flex-col gap-1">
        {logs.map((log) => (
          <li key={log.id} className="rounded border border-slate-800 bg-slate-900 px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className={EVENT_STYLES[log.entry.event]}>{EVENT_LABELS[log.entry.event]}</span>
              <span className="shrink-0 text-xs text-slate-500">{new Date(log.timestamp).toLocaleString()}</span>
            </div>
            <p className="truncate text-slate-400">
              {log.entry.username}@{log.entry.host}:{log.entry.port}
              {log.entry.detail ? ` — ${log.entry.detail}` : ''}
            </p>
          </li>
        ))}
        {logs.length === 0 && <p className="text-sm text-slate-500">No connection history yet.</p>}
      </ul>
    </div>
  )
}
