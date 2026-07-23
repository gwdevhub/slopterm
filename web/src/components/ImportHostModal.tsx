import { useState } from 'react'
import { importHostShare } from '../lib/api'

interface ImportHostModalProps {
  onImported: (name: string) => void
  onClose: () => void
}

// The paste side of the host-share round-trip: a token copied from another slopterm
// instance's "Copy" action is decoded and saved here as a new host (see server
// HostShareCodec / the /import-share endpoint).
export function ImportHostModal({ onImported, onClose }: ImportHostModalProps) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleImport() {
    setBusy(true)
    setError(null)
    try {
      await importHostShare(token.trim())
      onImported('host')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import host')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded border border-slate-700 bg-slate-900 p-5">
        <h3 className="font-semibold text-slate-100">Import a shared host</h3>
        <p className="mt-2 text-sm text-slate-400">
          Paste a host share token from another slopterm instance. It's saved as a new host here,
          credentials and all.
        </p>
        <textarea
          className="mt-3 h-28 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 focus:border-slate-400 focus:outline-none"
          placeholder="slopterm:host:v1:…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={busy || token.trim().length === 0}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
