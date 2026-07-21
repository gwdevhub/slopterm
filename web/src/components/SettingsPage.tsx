import { useEffect, useState, type FormEvent } from 'react'
import { getSettings, setRequireMasterPassword } from '../lib/api'

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'

export function SettingsPage() {
  const [requireMasterPassword, setRequireMasterPasswordState] = useState<boolean | null>(null)
  const [mode, setMode] = useState<'idle' | 'confirmingDisable' | 'confirmingEnable'>('idle')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getSettings().then((s) => setRequireMasterPasswordState(s.requireMasterPassword))
  }, [])

  function handleToggleClick() {
    setError(null)
    setPassword('')
    setMode(requireMasterPassword ? 'confirmingDisable' : 'confirmingEnable')
  }

  async function handleConfirm(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result =
        mode === 'confirmingDisable'
          ? await setRequireMasterPassword(false, password)
          : await setRequireMasterPassword(true, undefined, password)
      setRequireMasterPasswordState(result.requireMasterPassword)
      setMode('idle')
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update setting')
    } finally {
      setBusy(false)
    }
  }

  if (requireMasterPassword === null) {
    return <p className="p-4 text-slate-400">Loading settings…</p>
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-slate-100">Settings</h2>

      <div className="flex items-center justify-between gap-4 rounded border border-slate-700 bg-slate-900 p-4">
        <div>
          <p className="font-medium text-slate-100">Require master password</p>
          <p className="text-sm text-slate-400">
            Prompt for a master password to unlock your saved hosts, snippets, and logs.
          </p>
        </div>
        <button
          type="button"
          onClick={handleToggleClick}
          className={`shrink-0 rounded px-4 py-2 text-sm font-medium ${
            requireMasterPassword ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
        >
          {requireMasterPassword ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      <p className="rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
        When disabled, your vault is still encrypted at rest, but with a fixed key built into
        slopterm's own (public) source code instead of a real secret. That only protects
        against casually opening the vault files - it does not protect against anyone who has
        both those files and this app, since they could derive the same key. Only turn this off
        if that trade-off is fine for your use case.
      </p>

      {mode !== 'idle' && (
        <form onSubmit={handleConfirm} className="flex flex-col gap-2 border-t border-slate-800 pt-4">
          <label htmlFor="settings-password" className="text-sm font-medium text-slate-300">
            {mode === 'confirmingDisable' ? 'Enter your current master password to disable it' : 'Choose a new master password'}
          </label>
          <input
            id="settings-password"
            type="password"
            className={inputClasses}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {mode === 'confirmingDisable' ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
