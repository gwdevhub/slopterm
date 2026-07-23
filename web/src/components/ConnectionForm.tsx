import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { createKeychainEntry, listKeychainEntries, listSnippets, type SavedKeychainEntry, type SavedSnippet } from '../lib/api'

export interface ConnectionFormValues {
  name?: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
  startupSnippetIds?: string[]
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
}: ConnectionFormProps) {
  const [name, setName] = useState(initialValues?.name ?? '')
  const [host, setHost] = useState(initialValues?.host ?? '')
  const [port, setPort] = useState(initialValues?.port ?? 22)
  const [username, setUsername] = useState(initialValues?.username ?? '')
  const [authMethod, setAuthMethod] = useState<'password' | 'privateKey'>(initialValues?.authMethod ?? 'password')
  const [password, setPassword] = useState(initialValues?.password ?? '')
  const [privateKey, setPrivateKey] = useState(initialValues?.privateKey ?? '')
  const [passphrase, setPassphrase] = useState(initialValues?.passphrase ?? '')

  const [keychainEntries, setKeychainEntries] = useState<SavedKeychainEntry[]>([])
  const [selectedKeychainId, setSelectedKeychainId] = useState('')
  const [saveToKeychain, setSaveToKeychain] = useState(false)
  const [keychainName, setKeychainName] = useState('')
  const [keychainError, setKeychainError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [snippets, setSnippets] = useState<SavedSnippet[]>([])
  const [startupSnippetIds, setStartupSnippetIds] = useState<string[]>(initialValues?.startupSnippetIds ?? [])

  useEffect(() => {
    listKeychainEntries()
      .then(setKeychainEntries)
      .catch(() => setKeychainEntries([]))
  }, [])

  // Only the "new host" form (includeName) saves a host at all, so only it needs this -
  // Quick Connect has nothing to attach a startup snippet to.
  useEffect(() => {
    if (!includeName) return
    listSnippets()
      .then(setSnippets)
      .catch(() => setSnippets([]))
  }, [includeName])

  function toggleStartupSnippet(id: string) {
    setStartupSnippetIds((prev) => (prev.includes(id) ? prev.filter((existing) => existing !== id) : [...prev, id]))
  }

  function handleUseKeychainEntry(id: string) {
    setSelectedKeychainId(id)
    const entry = keychainEntries.find((e) => e.id === id)
    if (!entry) return
    setPrivateKey(entry.entry.privateKey)
    setPassphrase(entry.entry.passphrase ?? '')
    setSaveToKeychain(false)
  }

  async function handleBrowseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setPrivateKey(await file.text())
    setSelectedKeychainId('')
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setKeychainError(null)

    if (authMethod === 'privateKey' && saveToKeychain && !selectedKeychainId) {
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
      startupSnippetIds: includeName ? startupSnippetIds : undefined,
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
        <div className="flex gap-4 text-sm text-slate-300">
          <label className="flex items-center gap-2">
            <input type="radio" checked={authMethod === 'password'} onChange={() => setAuthMethod('password')} />
            Password
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={authMethod === 'privateKey'} onChange={() => setAuthMethod('privateKey')} />
            Private key
          </label>
        </div>
      </div>

      {authMethod === 'password' ? (
        <div>
          <label className={labelClasses} htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className={inputClasses}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
      ) : (
        <>
          {keychainEntries.length > 0 && (
            <div>
              <label className={labelClasses} htmlFor="keychainEntry">Use a saved key</label>
              <select
                id="keychainEntry"
                className={inputClasses}
                value={selectedKeychainId}
                onChange={(e) => handleUseKeychainEntry(e.target.value)}
              >
                <option value="">Paste or browse a key below…</option>
                {keychainEntries.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.entry.name}</option>
                ))}
              </select>
            </div>
          )}

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
              onChange={(e) => {
                setPrivateKey(e.target.value)
                setSelectedKeychainId('')
              }}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              required
            />
          </div>

          <div>
            <label className={labelClasses} htmlFor="passphrase">Passphrase (optional)</label>
            <input
              id="passphrase"
              type="password"
              className={inputClasses}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>

          {!selectedKeychainId && (
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
