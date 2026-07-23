import { useState } from 'react'

interface ShareTokenModalProps {
  token: string
  onClose: () => void
}

// Fallback for "Copy" when the clipboard API is unavailable (e.g. blocked by policy): shows
// the share token in a selectable field so it can still be copied by hand. The normal path
// writes straight to the clipboard and never opens this.
export function ShareTokenModal({ token, onClose }: ShareTokenModalProps) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
    } catch {
      // Still blocked - the field is selected/selectable for a manual copy instead.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded border border-slate-700 bg-slate-900 p-5">
        <h3 className="font-semibold text-slate-100">Share host</h3>
        <p className="mt-2 text-sm text-slate-400">
          Copy this token and paste it into another slopterm instance's “Import”.
        </p>
        <textarea
          readOnly
          className="mt-3 h-28 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100"
          value={token}
          onFocus={(e) => e.currentTarget.select()}
          autoFocus
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700">
            Close
          </button>
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  )
}
