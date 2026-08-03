import { useEffect, useState, type FormEvent } from 'react'
import {
  createCollection,
  getCollectionInviteToken,
  getCollectionStatus,
  getSyncConfigurationToken,
  joinCollection,
  leaveCollection,
  listCollectionMembers,
  listCollections,
  listSyncScopes,
  rotateCollectionKey,
  syncCollectionNow,
  updateCollection,
  type Collection,
  type CollectionInput,
  type CollectionMember,
  type CollectionStatus,
  type SyncScopeInfo,
} from '../lib/api'
import { VaultGate } from './VaultGate'
import { CardGrid, EntityCard, cardPrimaryButton, cardSecondaryButton } from './CardGrid'
import { CollectionsIcon } from './icons'

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'
const labelClasses = 'mb-1 block text-xs font-medium text-slate-400'

// Collections: a set of records that converge with a WebDAV URL across every device holding
// the collection's token, encrypted end to end. Teams share a collection by sharing its
// token; a person shares one with their own phone the same way.
//
// The hard part of this feature on a phone is typing a WebDAV URL and password, and the
// answer here is a single line of text you copy and paste - not a camera. Scanning a QR
// inside the WebView would mean the CAMERA manifest permission and a camera entry on the
// Play data-safety form, which is a permanent, visible cost on an SSH client in exchange for
// a one-time convenience.
export function CollectionsSection() {
  return (
    <VaultGate>
      <CollectionList />
    </VaultGate>
  )
}

function CollectionList() {
  const [collections, setCollections] = useState<Collection[]>([])
  const [status, setStatus] = useState<CollectionStatus[]>([])
  const [scopes, setScopes] = useState<SyncScopeInfo[]>([])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Collection | 'new' | null>(null)
  const [joining, setJoining] = useState(false)
  const [tokenFor, setTokenFor] = useState<Collection | 'all' | null>(null)
  const [membersFor, setMembersFor] = useState<Collection | null>(null)
  const [leaving, setLeaving] = useState<Collection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    refresh()
    listSyncScopes().then(setScopes).catch(() => setScopes([]))
  }, [])

  // Poll live sync state so Syncing/Idle/Error stays current without a manual reload - same
  // shape as Port Forwarding and Folder Sync.
  useEffect(() => {
    let alive = true
    const tick = () => getCollectionStatus().then((s) => alive && setStatus(s)).catch(() => {})
    tick()
    const interval = setInterval(tick, 2500)
    return () => {
      alive = false
      clearInterval(interval)
    }
  }, [])

  function refresh() {
    listCollections().then(setCollections).catch(() => setCollections([]))
    getCollectionStatus().then(setStatus).catch(() => {})
  }

  const statusOf = (id: string) => status.find((s) => s.collectionId === id)

  async function handleSyncNow(collection: Collection) {
    setError(null)
    setBusy(collection.id)
    try {
      await syncCollectionNow(collection.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setBusy(null)
      refresh()
    }
  }

  async function handleTogglePaused(collection: Collection) {
    setError(null)
    try {
      await updateCollection(collection.id, { enabled: !collection.enabled })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change collection')
    }
    refresh()
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? collections.filter((c) => c.name.toLowerCase().includes(q) || c.remoteUrl.toLowerCase().includes(q))
    : collections

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error && <p className="mx-3 mt-3 text-sm text-red-400 sm:mx-4">{error}</p>}

        <CardGrid
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="Find a collection…"
          newLabel="New collection"
          onNew={() => setEditing('new')}
          isEmpty={filtered.length === 0}
          emptyText={
            collections.length === 0
              ? 'No collections yet. Create one to sync hosts across your devices, or paste a token to join one.'
              : 'No collections match your search.'
          }
        >
          {filtered.map((collection) => {
            const st = statusOf(collection.id)
            return (
              <EntityCard
                key={collection.id}
                icon={<CollectionsIcon aria-hidden="true" className="h-5 w-5 text-slate-400" />}
                title={
                  <>
                    <StatusDot state={st?.state} />
                    <span className="truncate font-medium text-slate-100">{collection.name}</span>
                    {!collection.enabled && (
                      <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-slate-400 uppercase">
                        Paused
                      </span>
                    )}
                  </>
                }
                subtitle={
                  <span className="truncate font-mono text-xs" title={collection.remoteUrl}>
                    {collection.remoteUrl || 'no remote set'}
                  </span>
                }
                extra={
                  <div className="flex w-full flex-col gap-0.5">
                    <p className="truncate text-xs text-slate-500">
                      {(st?.recordCount ?? 0)} record{(st?.recordCount ?? 0) === 1 ? '' : 's'} ·{' '}
                      {(st?.memberCount ?? 0)} device{(st?.memberCount ?? 0) === 1 ? '' : 's'} ·{' '}
                      {describeLastSync(collection.lastSyncUtc)}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {collection.scopes.map((s) => scopes.find((sc) => sc.name === s)?.label ?? s).join(', ')}
                    </p>
                    {st?.error && (
                      <p className="w-full text-xs text-red-400" title={st.error}>
                        {st.error}
                      </p>
                    )}
                  </div>
                }
                actions={
                  <>
                    <button
                      type="button"
                      onClick={() => handleSyncNow(collection)}
                      disabled={busy === collection.id}
                      className={`${cardPrimaryButton} disabled:opacity-50`}
                    >
                      {busy === collection.id ? 'Syncing…' : 'Sync now'}
                    </button>
                    <button type="button" onClick={() => setTokenFor(collection)} className={cardSecondaryButton}>
                      Invite
                    </button>
                    <button type="button" onClick={() => setMembersFor(collection)} className={cardSecondaryButton}>
                      Devices
                    </button>
                    <button type="button" onClick={() => setEditing(collection)} className={cardSecondaryButton}>
                      Edit
                    </button>
                    <button type="button" onClick={() => handleTogglePaused(collection)} className={cardSecondaryButton}>
                      {collection.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button type="button" onClick={() => setLeaving(collection)} className={cardSecondaryButton}>
                      Leave
                    </button>
                  </>
                }
              />
            )
          })}
        </CardGrid>

        <div className="flex flex-col gap-2 px-3 pb-4 sm:flex-row sm:px-4">
          <button
            type="button"
            onClick={() => setJoining(true)}
            className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700"
          >
            Join with a token…
          </button>
          {collections.length > 0 && (
            <button
              type="button"
              onClick={() => setTokenFor('all')}
              className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700"
            >
              Copy sync configuration…
            </button>
          )}
        </div>
      </div>

      {editing && (
        <CollectionModal
          collection={editing === 'new' ? null : editing}
          scopes={scopes}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            refresh()
          }}
        />
      )}

      {joining && (
        <JoinModal
          onClose={() => setJoining(false)}
          onJoined={() => {
            setJoining(false)
            refresh()
          }}
        />
      )}

      {tokenFor && <TokenModal target={tokenFor} onClose={() => setTokenFor(null)} />}

      {membersFor && (
        <MembersModal
          collection={membersFor}
          onClose={() => setMembersFor(null)}
          onRotated={() => {
            setMembersFor(null)
            refresh()
          }}
        />
      )}

      {leaving && (
        <LeaveModal
          collection={leaving}
          onClose={() => setLeaving(null)}
          onLeft={() => {
            setLeaving(null)
            refresh()
          }}
        />
      )}
    </>
  )
}

interface FormState {
  name: string
  remoteUrl: string
  username: string
  password: string
  scopes: string[]
}

function CollectionModal({
  collection,
  scopes,
  onClose,
  onSaved,
}: {
  collection: Collection | null
  scopes: SyncScopeInfo[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(() => ({
    name: collection?.name ?? '',
    remoteUrl: collection?.remoteUrl ?? '',
    username: collection?.remoteUsername ?? '',
    password: '',
    scopes: collection?.scopes ?? scopes.filter((s) => s.defaultOn).map((s) => s.name),
  }))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function toggleScope(name: string) {
    setForm((prev) => ({
      ...prev,
      scopes: prev.scopes.includes(name) ? prev.scopes.filter((s) => s !== name) : [...prev.scopes, name],
    }))
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSaving(true)

    const input: CollectionInput = {
      name: form.name.trim(),
      remoteUrl: form.remoteUrl.trim(),
      username: form.username.trim(),
      scopes: form.scopes,
      // Omitted entirely when left blank on an edit, so saving the form doesn't wipe a
      // password the field was never allowed to show in the first place.
      ...(form.password ? { password: form.password } : collection ? {} : { password: '' }),
    }

    try {
      if (collection) await updateCollection(collection.id, input)
      else await createCollection(input)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save collection')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell onSubmit={handleSubmit} title={collection ? 'Edit collection' : 'New collection'}>
      <div>
        <label className={labelClasses} htmlFor="col-name">Name</label>
        <input
          id="col-name"
          className={inputClasses}
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          placeholder="e.g. Team hosts"
          required
        />
      </div>

      <div>
        <label className={labelClasses} htmlFor="col-url">WebDAV URL</label>
        <input
          id="col-url"
          className={inputClasses}
          value={form.remoteUrl}
          onChange={(e) => setForm((p) => ({ ...p, remoteUrl: e.target.value }))}
          placeholder="https://cloud.example.com/remote.php/dav/files/me/slopterm"
          required
        />
        <p className="mt-1 text-xs text-slate-500">
          Anything that speaks WebDAV. On Nextcloud, use an <strong>app password</strong> rather than your account
          password — it can be revoked on its own.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <label className={labelClasses} htmlFor="col-user">Username</label>
          <input
            id="col-user"
            className={inputClasses}
            value={form.username}
            onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
          />
        </div>
        <div className="flex-1">
          <label className={labelClasses} htmlFor="col-pass">Password</label>
          <input
            id="col-pass"
            type="password"
            className={inputClasses}
            value={form.password}
            onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
            placeholder={collection?.hasRemotePassword ? 'Stored — type to replace' : ''}
            autoComplete="new-password"
          />
        </div>
      </div>

      <div>
        <span className={labelClasses}>What this collection carries</span>
        <ul className="flex flex-col gap-2">
          {scopes.map((scope) => (
            <li key={scope.name}>
              <label className="flex items-start gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.scopes.includes(scope.name)}
                  onChange={() => toggleScope(scope.name)}
                />
                <span>
                  {scope.label}
                  {scope.warning && form.scopes.includes(scope.name) && (
                    <span className="mt-0.5 block text-xs text-amber-400">{scope.warning}</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <p className="rounded border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-400">
        Records are encrypted on this device before they're uploaded. The WebDAV server stores ciphertext and never
        sees the key — but everyone holding this collection's token can read everything in it.
      </p>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <ModalButtons onClose={onClose} submitLabel={collection ? 'Save changes' : 'Create collection'} busy={saving} />
    </ModalShell>
  )
}

function JoinModal({ onClose, onJoined }: { onClose: () => void; onJoined: () => void }) {
  const [token, setToken] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const joined = await joinCollection(token.trim(), passphrase || undefined)
      if (joined.length === 0) {
        setError('That token contained no collections.')
        return
      }

      onJoined()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell onSubmit={handleSubmit} title="Join a collection">
      <p className="text-sm text-slate-400">
        Paste an invite token, or a whole sync configuration from another device. Both are just text — move them the
        same way you'd move a password between your own devices.
      </p>

      <div>
        <label className={labelClasses} htmlFor="join-token">Token</label>
        <textarea
          id="join-token"
          className={`${inputClasses} h-28 font-mono text-xs`}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="slopterm:collection:v1:…"
          required
        />
      </div>

      <div>
        <label className={labelClasses} htmlFor="join-pass">Passphrase (only if the token was wrapped with one)</label>
        <input
          id="join-pass"
          type="password"
          className={inputClasses}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="off"
        />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <ModalButtons onClose={onClose} submitLabel="Join" busy={busy} />
    </ModalShell>
  )
}

// The token IS the access - possession is membership, there are no accounts - so it's hidden
// until asked for, and the copy explains what that means rather than just showing a blob.
function TokenModal({ target, onClose }: { target: Collection | 'all'; onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isAll = target === 'all'

  async function generate(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    setCopied(false)
    try {
      setToken(
        isAll
          ? await getSyncConfigurationToken(passphrase || undefined)
          : await getCollectionInviteToken(target.id, passphrase || undefined),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to build the token')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!token) return
    try {
      // 127.0.0.1 is a secure context, so the async clipboard API is available on every
      // platform this ships to - and the textarea below still works when it isn't.
      await navigator.clipboard.writeText(token)
      setCopied(true)
    } catch {
      setError('Copying failed — select the text below and copy it manually.')
    }
  }

  return (
    <ModalShell onSubmit={generate} title={isAll ? 'Copy sync configuration' : `Invite to ${target.name}`}>
      <p className="text-sm text-slate-400">
        {isAll
          ? 'One line of text covering every collection on this device, so a new phone or laptop is set up in a single paste.'
          : 'One line of text that adds another device to this collection.'}
      </p>

      <p className="rounded border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
        This carries the collection's encryption key — anyone who has it can read everything in{' '}
        {isAll ? 'every collection listed' : 'the collection'}. Treat it like a password: don't paste it into a chat.
        Rotating the key invalidates every token issued before it.
      </p>

      <div>
        <label className={labelClasses} htmlFor="token-pass">Protect with a passphrase (optional)</label>
        <input
          id="token-pass"
          type="password"
          className={inputClasses}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Leave empty for a plain token"
          autoComplete="off"
        />
        <p className="mt-1 text-xs text-slate-500">
          Use one if the token has to travel through something you don't fully trust. The other device is asked for it
          when joining.
        </p>
      </div>

      {token && (
        <div>
          <label className={labelClasses} htmlFor="token-value">Token</label>
          <textarea
            id="token-value"
            readOnly
            className={`${inputClasses} h-28 font-mono text-xs`}
            value={token}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            onClick={copy}
            className="mt-2 rounded bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
          >
            {copied ? 'Copied' : 'Copy to clipboard'}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <ModalButtons onClose={onClose} submitLabel={token ? 'Regenerate' : 'Show token'} busy={busy} />
    </ModalShell>
  )
}

function MembersModal({
  collection,
  onClose,
  onRotated,
}: {
  collection: Collection
  onClose: () => void
  onRotated: () => void
}) {
  const [members, setMembers] = useState<CollectionMember[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    listCollectionMembers(collection.id).then(setMembers).catch(() => setMembers([]))
  }, [collection.id])

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
  }

  async function rotate(event: FormEvent) {
    event.preventDefault()
    if (!confirming) {
      setConfirming(true)
      return
    }

    setError(null)
    setBusy(true)
    try {
      await rotateCollectionKey(collection.id, selected)
      onRotated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rotate the key')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell onSubmit={rotate} title={`Devices in ${collection.name}`}>
      <p className="text-sm text-slate-400">
        Every device holding this collection's token. Compare a short fingerprint out loud with whoever owns the device
        if you want to be sure it's the one you meant.
      </p>

      <ul className="flex flex-col gap-1">
        {members.map((member) => (
          <li key={member.id} className="rounded border border-slate-800 bg-slate-900/50 px-3 py-2">
            <label className="flex items-start gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                className="mt-1"
                disabled={member.isThisDevice}
                checked={selected.includes(member.id)}
                onChange={() => toggle(member.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {member.label}
                  {member.isThisDevice && <span className="ml-1 text-xs text-slate-500">(this device)</span>}
                </span>
                <span className="block font-mono text-xs text-slate-500">{member.shortFingerprint}</span>
              </span>
            </label>
          </li>
        ))}
        {members.length === 0 && <li className="text-sm text-slate-500">No member list synced yet.</li>}
      </ul>

      <p className="rounded border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
        Rotating the key stops the devices you remove from reading anything written from now on.{' '}
        <strong>It does not un-know anything.</strong> They keep every credential they ever synced — rotate the actual
        SSH keys and passwords too, or they still get into the hosts. A collection that shares only host inventory and
        resolves keys by name is far better off here.
      </p>

      {confirming && (
        <p className="text-sm text-slate-300">
          {selected.length === 0
            ? 'Rotate the key without removing anyone? Every existing invite token stops working.'
            : `Remove ${selected.length} device${selected.length === 1 ? '' : 's'} and rotate the key?`}
        </p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <ModalButtons
        onClose={onClose}
        submitLabel={confirming ? 'Yes, rotate the key' : selected.length > 0 ? 'Remove and rotate…' : 'Rotate key…'}
        busy={busy}
      />
    </ModalShell>
  )
}

function LeaveModal({
  collection,
  onClose,
  onLeft,
}: {
  collection: Collection
  onClose: () => void
  onLeft: () => void
}) {
  const [keepRecords, setKeepRecords] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await leaveCollection(collection.id, keepRecords)
      onLeft()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to leave')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell onSubmit={handleSubmit} title={`Leave ${collection.name}`}>
      <p className="text-sm text-slate-400">
        This removes the collection from <strong>this device only</strong>. Nothing is deleted from the WebDAV share,
        and everyone else keeps working exactly as before.
      </p>

      <label className="flex items-start gap-2 text-sm text-slate-300">
        <input type="checkbox" className="mt-1" checked={keepRecords} onChange={(e) => setKeepRecords(e.target.checked)} />
        <span>
          Keep a copy of its hosts and snippets here
          <span className="mt-0.5 block text-xs text-slate-500">
            They move into your private, never-synced records. Turn this off to remove them from this device too.
          </span>
        </span>
      </label>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <ModalButtons onClose={onClose} submitLabel="Leave collection" busy={busy} />
    </ModalShell>
  )
}

function ModalShell({
  title,
  onSubmit,
  children,
}: {
  title: string
  onSubmit: (event: FormEvent) => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={onSubmit}
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded border border-slate-700 bg-slate-900 p-5"
      >
        <h3 className="font-semibold text-slate-100">{title}</h3>
        {children}
      </form>
    </div>
  )
}

function ModalButtons({ onClose, submitLabel, busy }: { onClose: () => void; submitLabel: string; busy?: boolean }) {
  return (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onClose} className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700">
        Close
      </button>
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {busy ? 'Working…' : submitLabel}
      </button>
    </div>
  )
}

function describeLastSync(lastSyncUtc?: string | null): string {
  if (!lastSyncUtc) {
    return 'never synced'
  }

  const elapsedSeconds = Math.max(0, (Date.now() - new Date(lastSyncUtc).getTime()) / 1000)
  if (elapsedSeconds < 90) return 'synced just now'
  if (elapsedSeconds < 3600) return `synced ${Math.round(elapsedSeconds / 60)}m ago`
  if (elapsedSeconds < 86_400) return `synced ${Math.round(elapsedSeconds / 3600)}h ago`
  return `synced ${Math.round(elapsedSeconds / 86_400)}d ago`
}

function StatusDot({ state }: { state?: CollectionStatus['state'] }) {
  const color =
    state === 'idle'
      ? 'bg-emerald-400'
      : state === 'syncing'
        ? 'bg-amber-400'
        : state === 'error' || state === 'no-access'
          ? 'bg-red-400'
          : 'bg-slate-600'
  const title =
    state === 'no-access' ? 'No access — this collection was rotated without this device' : state ? state[0].toUpperCase() + state.slice(1) : 'Inactive'
  return <span aria-hidden="true" title={title} className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />
}
