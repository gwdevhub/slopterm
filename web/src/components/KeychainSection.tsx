import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  createKeychainEntry,
  deleteKeychainEntry,
  listKeychainEntries,
  updateKeychainEntry,
  type SavedKeychainEntry,
} from '../lib/api'
import { VaultGate } from './VaultGate'

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'

// Saved SSH private keys, reusable from the shared ConnectionForm (Quick Connect and the
// "new host" form) instead of re-pasting a key each time - see ConnectionForm.tsx.
export function KeychainSection() {
  return (
    <VaultGate>
      <KeychainList />
    </VaultGate>
  )
}

function KeychainList() {
  const [entries, setEntries] = useState<SavedKeychainEntry[]>([])
  const [name, setName] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Set while the form below is editing an existing entry rather than creating a new
  // one - the PUT endpoint already existed (same pattern as hosts before someone wired
  // that one up), this was just missing a frontend caller/UI entirely. Safe to pre-fill
  // the actual key/passphrase here since listKeychainEntries() already returns them in
  // full - ConnectionForm's own "use a saved key" dropdown already relies on that.
  const [editingId, setEditingId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    refresh()
  }, [])

  function refresh() {
    listKeychainEntries().then(setEntries)
  }

  async function handleBrowseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setPrivateKey(await file.text())
  }

  function handleEdit(entry: SavedKeychainEntry) {
    setEditingId(entry.id)
    setName(entry.entry.name)
    setPrivateKey(entry.entry.privateKey)
    setPassphrase(entry.entry.passphrase ?? '')
    setError(null)
  }

  function handleCancelEdit() {
    setEditingId(null)
    setName('')
    setPrivateKey('')
    setPassphrase('')
    setError(null)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      if (editingId) {
        await updateKeychainEntry(editingId, { name, privateKey, passphrase: passphrase || undefined })
      } else {
        await createKeychainEntry({ name, privateKey, passphrase: passphrase || undefined })
      }
      setEditingId(null)
      setName('')
      setPrivateKey('')
      setPassphrase('')
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key')
    }
  }

  async function handleDelete(id: string) {
    await deleteKeychainEntry(id)
    if (editingId === id) handleCancelEdit()
    refresh()
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-slate-100">Keychain</h2>

      <ul className="flex flex-col gap-2">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-2 rounded border border-slate-700 bg-slate-900 p-3">
            <p className="truncate font-medium text-slate-100">{e.entry.name}</p>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => handleEdit(e)}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => handleDelete(e.id)}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
        {entries.length === 0 && <p className="text-sm text-slate-500">No saved keys yet.</p>}
      </ul>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-slate-800 pt-4">
        <h3 className="text-sm font-medium text-slate-300">{editingId ? 'Edit key' : 'Add a key'}</h3>
        <input className={inputClasses} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <div className="flex items-center justify-between">
          <label className="text-xs tracking-wide text-slate-500 uppercase" htmlFor="keychain-private-key">Private key</label>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-sm text-indigo-400 hover:text-indigo-300"
          >
            Browse…
          </button>
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleBrowseFile} />
        </div>
        <textarea
          id="keychain-private-key"
          className={`${inputClasses} h-32 font-mono text-xs`}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          required
        />
        <input
          type="password"
          className={inputClasses}
          placeholder="Passphrase (optional)"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" className="flex-1 rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500">
            {editingId ? 'Save changes' : 'Save key'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={handleCancelEdit}
              className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
