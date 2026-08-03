import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  createKeychainEntry,
  listCollections,
  listHosts,
  listKeychainEntries,
  listSnippets,
  type Collection,
  type SavedKeychainEntry,
  type SavedSnippet,
} from '../lib/api'

export interface ConnectionFormValues {
  name?: string
  host: string
  port: number
  username: string
  // 'keychain' names a key rather than carrying one - the mode that lets a team share a host
  // while every member connects with their own key (see the backend's CredentialResolver).
  authMethod: 'password' | 'privateKey' | 'keychain'
  password?: string
  privateKey?: string
  passphrase?: string
  keychainName?: string
  startupSnippetIds?: string[]
  groupName?: string
  // Which collection a newly saved host goes into ('local' = private to this device).
  collectionId?: string
  // Carried through an edit so the backend can match the credential it's replacing - a fresh
  // id every save would orphan the stored secret this form never received.
  credentialId?: string
  // True when the host already has a secret saved that this form deliberately didn't get.
  hasStoredSecret?: boolean
}

interface ConnectionFormProps {
  // Quick Connect has no name field (it doesn't save anything); the "new host" form does.
  includeName?: boolean
  submitLabel: string
  onSubmit: (values: ConnectionFormValues) => void
  errorMessage?: string | null
  isSubmitting?: boolean
  // Pre-fills the fields (the "Edit host" flow). Read once on mount, so callers that switch
  // the edited host must remount the form (key it by the host id) for new values to take.
  initialValues?: ConnectionFormValues
  // Shows the collection picker. Only the saved-host form has anywhere to put one; Quick
  // Connect saves nothing, so it has no collection to choose.
  includeCollection?: boolean
}

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'
const labelClasses = 'mb-1 block text-sm font-medium text-slate-300'

// Shared by Quick Connect and the "new host" form - they used to be two separately
// maintained forms and drifted (the host form had no private-key option at all). Quick
// Connect renders this with no vault present, so the Keychain lookup below is best-effort:
// a failed/locked-vault fetch just means the "use a saved key" dropdown doesn't appear,
// it never blocks connecting with a pasted/browsed key.
export function ConnectionForm({
  includeName,
  submitLabel,
  onSubmit,
  errorMessage,
  isSubmitting,
  initialValues,
  includeCollection,
}: ConnectionFormProps) {
  const [name, setName] = useState(initialValues?.name ?? '')
  const [host, setHost] = useState(initialValues?.host ?? '')
  const [port, setPort] = useState(initialValues?.port ?? 22)
  const [username, setUsername] = useState(initialValues?.username ?? '')
  const [authMethod, setAuthMethod] = useState<ConnectionFormValues['authMethod']>(initialValues?.authMethod ?? 'password')
  // Never pre-filled from a saved host: stored credential material isn't sent to the UI, so
  // an empty field on an edit means "keep it" and a typed one means "replace it".
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const hasStoredSecret = initialValues?.hasStoredSecret ?? false

  const [keychainEntries, setKeychainEntries] = useState<SavedKeychainEntry[]>([])
  const [namedKey, setNamedKey] = useState(initialValues?.keychainName ?? '')
  const [saveToKeychain, setSaveToKeychain] = useState(false)
  const [keychainName, setKeychainName] = useState('')
  const [keychainError, setKeychainError] = useState<string | null>(null)
  const [collections, setCollections] = useState<Collection[]>([])
  const [collectionId, setCollectionId] = useState(initialValues?.collectionId ?? 'local')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [snippets, setSnippets] = useState<SavedSnippet[]>([])
  const [startupSnippetIds, setStartupSnippetIds] = useState<string[]>(initialValues?.startupSnippetIds ?? [])
  const [groupName, setGroupName] = useState(initialValues?.groupName ?? '')
  const [existingGroupNames, setExistingGroupNames] = useState<string[]>([])

  useEffect(() => {
    listKeychainEntries()
      .then(setKeychainEntries)
      .catch(() => setKeychainEntries([]))
  }, [])

  useEffect(() => {
    if (!includeCollection) return
    listCollections()
      .then(setCollections)
      .catch(() => setCollections([]))
  }, [includeCollection])

  // Only the "new host"/"edit host" form (includeName) saves a host at all, so only it
  // needs these - Quick Connect has nothing to attach a startup snippet or group to.
  useEffect(() => {
    if (!includeName) return
    listSnippets()
      .then(setSnippets)
      .catch(() => setSnippets([]))
    listHosts()
      .then((hosts) => {
        const names = new Set(hosts.map((h) => h.host.parentGroupId).filter((name): name is string => !!name))
        setExistingGroupNames([...names])
      })
      .catch(() => setExistingGroupNames([]))
  }, [includeName])

  function toggleStartupSnippet(id: string) {
    setStartupSnippetIds((prev) => (prev.includes(id) ? prev.filter((existing) => existing !== id) : [...prev, id]))
  }

  async function handleBrowseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setPrivateKey(await file.text())
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setKeychainError(null)

    if (authMethod === 'privateKey' && saveToKeychain && privateKey) {
      try {
        await createKeychainEntry({ name: keychainName, privateKey, passphrase: passphrase || undefined })
      } catch (err) {
        setKeychainError(err instanceof Error ? err.message : 'Failed to save key to Keychain')
      }
    }

    onSubmit({
      name: includeName ? name : undefined,
      host,
      port,
      username,
      authMethod,
      password: authMethod === 'password' ? password : undefined,
      privateKey: authMethod === 'privateKey' ? privateKey : undefined,
      passphrase: authMethod === 'privateKey' ? passphrase : undefined,
      keychainName: authMethod === 'keychain' ? namedKey.trim() : undefined,
      startupSnippetIds: includeName ? startupSnippetIds : undefined,
      groupName: includeName ? groupName.trim() || undefined : undefined,
      collectionId: includeCollection ? collectionId : undefined,
      credentialId: initialValues?.credentialId,
      hasStoredSecret,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-md flex-col gap-4 p-4 sm:p-6">
      {includeName && (
        <div>
          <label className={labelClasses} htmlFor="name">Name</label>
          <input id="name" className={inputClasses} value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
      )}

      {includeName && (
        <div>
          <label className={labelClasses} htmlFor="group">Group (optional)</label>
          <input
            id="group"
            className={inputClasses}
            list="existing-group-names"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="e.g. Production servers"
          />
          <datalist id="existing-group-names">
            {existingGroupNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>
      )}

      {includeCollection && collections.length > 0 && (
        <div>
          <label className={labelClasses} htmlFor="collection">Collection</label>
          <select id="collection" className={inputClasses} value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
            <option value="local">Private to this device</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {collectionId !== 'local' && (
            <p className="mt-1 text-xs text-amber-400">
              Everyone in this collection will see this host
              {authMethod !== 'keychain' && ', including any password or key saved on it. "Use a key named…" shares the host without the key.'}
              {authMethod === 'keychain' && '. Its key stays on each device.'}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <label className={labelClasses} htmlFor="host">Host</label>
          <input
            id="host"
            className={inputClasses}
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.com"
            required
          />
        </div>
        <div className="w-full sm:w-24">
          <label className={labelClasses} htmlFor="port">Port</label>
          <input
            id="port"
            type="number"
            className={inputClasses}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            required
          />
        </div>
      </div>

      <div>
        <label className={labelClasses} htmlFor="username">Username</label>
        <input id="username" className={inputClasses} value={username} onChange={(e) => setUsername(e.target.value)} required />
      </div>

      <div>
        <span className={labelClasses}>Authentication</span>
        <div className="flex flex-wrap gap-4 text-sm text-slate-300">
          <label className="flex items-center gap-2">
            <input type="radio" checked={authMethod === 'password'} onChange={() => setAuthMethod('password')} />
            Password
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={authMethod === 'privateKey'} onChange={() => setAuthMethod('privateKey')} />
            Private key
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={authMethod === 'keychain'} onChange={() => setAuthMethod('keychain')} />
            Use a key named…
          </label>
        </div>
      </div>

      {authMethod === 'password' && (
        <div>
          <label className={labelClasses} htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className={inputClasses}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={hasStoredSecret ? 'Stored — type to replace' : ''}
            autoComplete="new-password"
            required={!hasStoredSecret}
          />
          {hasStoredSecret && (
            <p className="mt-1 text-xs text-slate-500">
              Stored, not shown. Leave this empty to keep the saved password.
            </p>
          )}
        </div>
      )}

      {authMethod === 'keychain' && (
        <>
          <div>
            <label className={labelClasses} htmlFor="namedKey">Key name</label>
            <input
              id="namedKey"
              className={inputClasses}
              list="keychain-names"
              value={namedKey}
              onChange={(e) => setNamedKey(e.target.value)}
              placeholder="e.g. prod-deploy"
              required
            />
            <datalist id="keychain-names">
              {keychainEntries.map((entry) => (
                <option key={entry.id} value={entry.entry.name} />
              ))}
            </datalist>
          </div>
          <p className="rounded border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
            This host carries no key — each device resolves the name against a key it holds itself, preferring your own
            Keychain, then the host's collection, then <code>~/.ssh</code>. Share the host with a team and everyone
            still connects with their own key.
          </p>
        </>
      )}

      {authMethod === 'privateKey' && (
        <>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-medium text-slate-300" htmlFor="privateKey">Private key</label>
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
              id="privateKey"
              className={`${inputClasses} h-32 font-mono text-xs`}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder={hasStoredSecret ? 'Stored — paste a new key to replace it' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
              required={!hasStoredSecret}
            />
            {hasStoredSecret && (
              <p className="mt-1 text-xs text-slate-500">Stored, not shown. Leave this empty to keep the saved key.</p>
            )}
          </div>

          <div>
            <label className={labelClasses} htmlFor="passphrase">Passphrase (optional)</label>
            <input
              id="passphrase"
              type="password"
              className={inputClasses}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="new-password"
            />
          </div>

          {privateKey && (
            <div className="rounded border border-slate-800 bg-slate-900/50 p-3">
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={saveToKeychain} onChange={(e) => setSaveToKeychain(e.target.checked)} />
                Save this key to Keychain for reuse
              </label>
              {saveToKeychain && (
                <input
                  className={`${inputClasses} mt-2`}
                  placeholder="Key name"
                  value={keychainName}
                  onChange={(e) => setKeychainName(e.target.value)}
                  required
                />
              )}
            </div>
          )}
          {keychainError && <p className="text-sm text-red-400">{keychainError}</p>}
        </>
      )}

      {includeName && snippets.length > 0 && (
        <div>
          <span className={labelClasses}>Startup snippets (optional)</span>
          <p className="mb-2 text-xs text-slate-500">Sent to the shell, in order, right after this host connects.</p>
          <ul className="flex flex-col gap-1">
            {snippets.map((s) => (
              <li key={s.id}>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={startupSnippetIds.includes(s.id)}
                    onChange={() => toggleStartupSnippet(s.id)}
                  />
                  {s.snippet.name}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {errorMessage && (
        <p className="rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">{errorMessage}</p>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {isSubmitting ? 'Working…' : submitLabel}
      </button>
    </form>
  )
}
