import { useEffect, useState, type FormEvent } from 'react'
import {
  createHost,
  deleteHost,
  getVaultStatus,
  listHosts,
  setupVault,
  unlockVault,
  type ConnectRequest,
  type SavedHost,
} from '../lib/api'

// Deliberately minimal/unstyled-to-the-final-design UI - the real Termius-style layout
// (nav rail, host card grid, host details panel) is tracked separately in issues #8/#10.
// This exists to prove the encrypted vault backend works end-to-end through the real UI,
// not just curl.

interface VaultPanelProps {
  onConnect: (request: ConnectRequest) => void
}

export function VaultPanel({ onConnect }: VaultPanelProps) {
  const [status, setStatus] = useState<'loading' | 'setup' | 'locked' | 'unlocked'>('loading')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hosts, setHosts] = useState<SavedHost[]>([])

  const [newName, setNewName] = useState('')
  const [newAddress, setNewAddress] = useState('')
  const [newPort, setNewPort] = useState(22)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')

  useEffect(() => {
    getVaultStatus()
      .then((s) => setStatus(s.exists ? (s.unlocked ? 'unlocked' : 'locked') : 'setup'))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load vault status'))
  }, [])

  useEffect(() => {
    if (status === 'unlocked') {
      refreshHosts()
    }
  }, [status])

  function refreshHosts() {
    listHosts()
      .then(setHosts)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load hosts'))
  }

  async function handleSetup(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await setupVault(password)
      setPassword('')
      setStatus('unlocked')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create vault')
    } finally {
      setBusy(false)
    }
  }

  async function handleUnlock(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await unlockVault(password)
      setPassword('')
      setStatus('unlocked')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlock vault')
    } finally {
      setBusy(false)
    }
  }

  async function handleAddHost(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await createHost({
        name: newName,
        address: newAddress,
        port: newPort,
        credentials: [{ id: crypto.randomUUID(), kind: 'password', username: newUsername, secret: newPassword }],
      })
      setNewName('')
      setNewAddress('')
      setNewPort(22)
      setNewUsername('')
      setNewPassword('')
      refreshHosts()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save host')
    }
  }

  async function handleDelete(id: string) {
    await deleteHost(id)
    refreshHosts()
  }

  function handleConnect(saved: SavedHost) {
    const credential = saved.host.credentials.find((c) => c.kind === 'password')
    if (!credential) return
    onConnect({
      host: saved.host.address,
      port: saved.host.port,
      username: credential.username ?? '',
      authMethod: 'password',
      password: credential.secret ?? '',
      columns: 80,
      rows: 24,
    })
  }

  const inputClasses =
    'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'

  if (status === 'loading') {
    return <p className="p-4 text-slate-400">Loading vault…</p>
  }

  if (status === 'setup' || status === 'locked') {
    return (
      <form
        onSubmit={status === 'setup' ? handleSetup : handleUnlock}
        className="mx-auto flex w-full max-w-sm flex-col gap-3 p-4 sm:p-6"
      >
        <h2 className="text-lg font-semibold text-slate-100">
          {status === 'setup' ? 'Create a vault master password' : 'Unlock your vault'}
        </h2>
        <input
          type="password"
          className={inputClasses}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Master password"
          required
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {status === 'setup' ? 'Create vault' : 'Unlock'}
        </button>
      </form>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-slate-100">Saved hosts</h2>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <ul className="flex flex-col gap-2">
        {hosts.map((saved) => (
          <li
            key={saved.id}
            className="flex items-center justify-between gap-2 rounded border border-slate-700 bg-slate-900 p-3"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-100">{saved.host.name}</p>
              <p className="truncate text-sm text-slate-400">{saved.host.address}:{saved.host.port}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => handleConnect(saved)}
                className="rounded bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-500"
              >
                Connect
              </button>
              <button
                type="button"
                onClick={() => handleDelete(saved.id)}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
        {hosts.length === 0 && <p className="text-sm text-slate-500">No saved hosts yet.</p>}
      </ul>

      <form onSubmit={handleAddHost} className="flex flex-col gap-2 border-t border-slate-800 pt-4">
        <h3 className="text-sm font-medium text-slate-300">Add a host</h3>
        <input className={inputClasses} placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} required />
        <div className="flex gap-2">
          <input
            className={inputClasses}
            placeholder="Address"
            value={newAddress}
            onChange={(e) => setNewAddress(e.target.value)}
            required
          />
          <input
            type="number"
            className={`${inputClasses} w-24`}
            value={newPort}
            onChange={(e) => setNewPort(Number(e.target.value))}
            required
          />
        </div>
        <input
          className={inputClasses}
          placeholder="Username"
          value={newUsername}
          onChange={(e) => setNewUsername(e.target.value)}
          required
        />
        <input
          type="password"
          className={inputClasses}
          placeholder="Password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
        />
        <button type="submit" className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500">
          Save host
        </button>
      </form>
    </div>
  )
}
