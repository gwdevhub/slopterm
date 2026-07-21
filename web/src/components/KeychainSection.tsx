import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { createKeychainEntry, deleteKeychainEntry, listKeychainEntries, type SavedKeychainEntry } from '../lib/api'
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

  async function handleAdd(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await createKeychainEntry({ name, privateKey, passphrase: passphrase || undefined })
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
    refresh()
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-slate-100">Keychain</h2>

      <ul className="flex flex-col gap-2">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-2 rounded border border-slate-700 bg-slate-900 p-3">
            <p className="truncate font-medium text-slate-100">{e.entry.name}</p>
            <button
              type="button"
              onClick={() => handleDelete(e.id)}
              className="shrink-0 rounded bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700"
            >
              Delete
            </button>
          </li>
        ))}
        {entries.length === 0 && <p className="text-sm text-slate-500">No saved keys yet.</p>}
      </ul>

      <form onSubmit={handleAdd} className="flex flex-col gap-2 border-t border-slate-800 pt-4">
        <h3 className="text-sm font-medium text-slate-300">Add a key</h3>
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
        <button type="submit" className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500">
          Save key
        </button>
      </form>
    </div>
  )
}
