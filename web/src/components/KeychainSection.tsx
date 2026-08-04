import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  createKeychainEntry,
  deleteKeychainEntry,
  listCollections,
  listKeychainEntries,
  updateKeychainEntry,
  type Collection,
  type SavedKeychainEntry,
} from '../lib/api'
import { VaultGate } from './VaultGate'
import { CardGrid, EntityCard, cardSecondaryButton } from './CardGrid'
import { KeychainIcon } from './icons'

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'

// Saved SSH private keys, reusable from the shared ConnectionForm (Quick Connect and the
// "new host" form) instead of re-pasting a key each time - see ConnectionForm.tsx. Same
// card-grid layout as the Hosts tab (see CardGrid), with create/edit in a modal.
//
// Key material is never shown, in any collection, to anyone: the backend's listing carries
// only names and "has a key" flags, and editing REPLACES rather than reveals. That's a
// product decision, not a permission - a saved secret is something the app uses, not
// something it shows back to you - and it stops casual copying and shoulder-surfing, not a
// patched build or someone reading the vault file.
//
// An entry's NAME is also the join key for a host that resolves its credential by name (see
// CredentialResolver), which is why names have to be unique within a collection.
export function KeychainSection() {
  return (
    <VaultGate>
      <KeychainList />
    </VaultGate>
  )
}

function KeychainList() {
  const [entries, setEntries] = useState<SavedKeychainEntry[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<SavedKeychainEntry | 'new' | null>(null)

  useEffect(() => {
    refresh()
  }, [])

  function refresh() {
    listKeychainEntries().then(setEntries)
    listCollections().then(setCollections).catch(() => setCollections([]))
  }

  const collectionName = (id: string) => collections.find((c) => c.id === id)?.name

  async function handleDelete(id: string) {
    await deleteKeychainEntry(id)
    refresh()
  }

  const q = query.trim().toLowerCase()
  const filtered = q ? entries.filter((e) => e.entry.name.toLowerCase().includes(q)) : entries

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <CardGrid
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="Find a key…"
          newLabel="New key"
          onNew={() => setEditing('new')}
          isEmpty={filtered.length === 0}
          emptyText={entries.length === 0 ? 'No saved keys yet.' : 'No keys match your search.'}
        >
          {filtered.map((e) => (
            <EntityCard
              key={e.id}
              icon={<KeychainIcon aria-hidden="true" className="h-5 w-5 text-slate-400" />}
              title={
                <>
                  <span className="truncate font-medium text-slate-100">{e.entry.name}</span>
                  {collectionName(e.collectionId) && (
                    <span className="shrink-0 truncate rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-slate-400 uppercase">
                      {collectionName(e.collectionId)}
                    </span>
                  )}
                </>
              }
              subtitle={<span>Stored, not shown{e.entry.hasPassphrase ? ' · passphrase set' : ''}</span>}
              actions={
                <>
                  <button type="button" onClick={() => setEditing(e)} className={cardSecondaryButton}>
                    Edit
                  </button>
                  <button type="button" onClick={() => handleDelete(e.id)} className={cardSecondaryButton}>
                    Delete
                  </button>
                </>
              }
            />
          ))}
        </CardGrid>
      </div>

      {editing && (
        <KeychainModal
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refresh()
          }}
        />
      )}
    </>
  )
}

function KeychainModal({ entry, onClose, onSaved }: { entry: SavedKeychainEntry | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(entry?.entry.name ?? '')
  // Empty on an edit and it stays empty: the stored key was never sent here. Typing or
  // browsing one replaces it; leaving it alone keeps what's saved.
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleBrowseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setPrivateKey(await file.text())
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      if (entry) await updateKeychainEntry(entry.id, { name, privateKey, passphrase })
      else await createKeychainEntry({ name, privateKey, passphrase: passphrase || undefined })
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form onSubmit={handleSubmit} className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-5">
        <h3 className="font-semibold text-slate-100">{entry ? 'Edit key' : 'New key'}</h3>
        <input className={inputClasses} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <div className="flex items-center justify-between">
          <label className="text-xs tracking-wide text-slate-500 uppercase" htmlFor="keychain-private-key">Private key</label>
          <button type="button" onClick={() => fileInputRef.current?.click()} className="text-sm text-indigo-400 hover:text-indigo-300">
            Browse…
          </button>
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleBrowseFile} />
        </div>
        <textarea
          id="keychain-private-key"
          className={`${inputClasses} h-32 font-mono text-xs`}
          placeholder={entry ? 'Stored — paste a new key to replace it' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          required={!entry}
        />
        <input
          type="password"
          className={inputClasses}
          placeholder={entry?.entry.hasPassphrase ? 'Stored — type to replace' : 'Passphrase (optional)'}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="new-password"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700">
            Cancel
          </button>
          <button type="submit" className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500">
            {entry ? 'Save changes' : 'Save key'}
          </button>
        </div>
      </form>
    </div>
  )
}
