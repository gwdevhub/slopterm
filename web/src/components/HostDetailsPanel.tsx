import { useEffect, useState } from 'react'
import {
  createHost,
  deleteHost,
  listSnippets,
  updateHost,
  type ConnectRequest,
  type CredentialRecord,
  type SavedHost,
  type SavedSnippet,
} from '../lib/api'
import { resolveConnectRequest, resolveStartupCommands } from '../lib/hosts'
import { ConnectionForm, type ConnectionFormValues } from './ConnectionForm'
import { CloseIcon } from './icons'

interface HostDetailsPanelProps {
  mode: 'view' | 'new' | 'edit' | 'empty'
  host?: SavedHost
  onConnect: (request: ConnectRequest, startupCommands?: string[]) => void
  onDeleted: () => void
  onSaved: () => void
  // Fired after toggling a startup snippet on an already-saved host - refreshes the hosts
  // list (so this panel sees the updated attachment) without resetting the current
  // selection the way onSaved/onDeleted do.
  onHostUpdated: () => void
  onClose: () => void
  onEdit?: () => void
  errorMessage?: string | null
  isConnecting?: boolean
}

// Maps a saved host's first credential onto the flat form shape ConnectionForm edits. The
// form (like the "new host" flow) edits a single credential; a host with several keeps the
// rest only until it's saved from here - consistent with there being no multi-credential
// UI yet (issue #12).
function hostToFormValues(host: SavedHost): ConnectionFormValues {
  const credential = host.host.credentials[0]
  const isKey = credential?.kind === 'privateKey'
  return {
    name: host.host.name,
    host: host.host.address,
    port: host.host.port,
    username: credential?.username ?? '',
    authMethod: isKey ? 'privateKey' : 'password',
    password: isKey ? '' : (credential?.secret ?? ''),
    privateKey: isKey ? (credential?.secret ?? '') : '',
    passphrase: credential?.passphrase ?? '',
    startupSnippetIds: host.host.startupSnippetIds ?? [],
  }
}

function formValuesToHost(values: ConnectionFormValues): Parameters<typeof createHost>[0] {
  const credential: CredentialRecord =
    values.authMethod === 'password'
      ? { id: crypto.randomUUID(), kind: 'password', username: values.username, secret: values.password }
      : {
          id: crypto.randomUUID(),
          kind: 'privateKey',
          username: values.username,
          secret: values.privateKey,
          passphrase: values.passphrase || undefined,
        }
  return {
    name: values.name ?? '',
    address: values.host,
    port: values.port,
    credentials: [credential],
    startupSnippetIds: values.startupSnippetIds ?? [],
  }
}

// The right-hand "Host Details" panel from the Termius reference (issue #8). Full
// multi-credential editing (password/key/certificate/env var side by side) is issue #12 -
// this shows the credential list read-only for existing hosts and a single credential
// (password or private key, via the shared ConnectionForm) when creating a new one. Ad hoc
// ("Quick Connect") connections are a modal (see QuickConnectModal) rather than a mode of
// this panel - they used to be reachable only by picking a Recent connection first, which
// meant there was no way to start one from scratch.
export function HostDetailsPanel({
  mode,
  host,
  onConnect,
  onDeleted,
  onSaved,
  onHostUpdated,
  onClose,
  onEdit,
  errorMessage,
  isConnecting,
}: HostDetailsPanelProps) {
  const [error, setError] = useState<string | null>(null)
  const [snippets, setSnippets] = useState<SavedSnippet[]>([])

  useEffect(() => {
    listSnippets()
      .then(setSnippets)
      .catch(() => setSnippets([]))
  }, [])

  async function handleSave(values: ConnectionFormValues) {
    setError(null)
    try {
      await createHost(formValuesToHost(values))
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save host')
    }
  }

  async function handleUpdate(values: ConnectionFormValues) {
    if (!host) return
    setError(null)
    try {
      await updateHost(host.id, formValuesToHost(values))
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save host')
    }
  }

  async function handleDelete() {
    if (!host) return
    await deleteHost(host.id)
    onDeleted()
  }

  function handleConnect() {
    if (!host) return
    const request = resolveConnectRequest(host)
    if (!request) return
    onConnect(request, resolveStartupCommands(host, snippets))
  }

  async function handleToggleStartupSnippet(id: string) {
    if (!host) return
    const current = host.host.startupSnippetIds ?? []
    const next = current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id]
    await updateHost(host.id, { ...host.host, startupSnippetIds: next })
    onHostUpdated()
  }

  if (mode === 'new') {
    return (
      <div className="flex w-full flex-col gap-3 border-t border-slate-800 sm:w-80 sm:border-t-0 sm:border-l">
        <div className="flex items-center justify-between p-4 pb-0">
          <h3 className="font-semibold text-slate-100">New host</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200"><CloseIcon aria-hidden="true" className="h-4 w-4" /></button>
        </div>
        <ConnectionForm includeName submitLabel="Save host" onSubmit={handleSave} errorMessage={error} />
      </div>
    )
  }

  if (mode === 'edit' && host) {
    return (
      <div className="flex w-full flex-col gap-3 border-t border-slate-800 sm:w-80 sm:border-t-0 sm:border-l">
        <div className="flex items-center justify-between p-4 pb-0">
          <h3 className="font-semibold text-slate-100">Edit host</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200"><CloseIcon aria-hidden="true" className="h-4 w-4" /></button>
        </div>
        <ConnectionForm
          key={host.id}
          includeName
          submitLabel="Save changes"
          initialValues={hostToFormValues(host)}
          onSubmit={handleUpdate}
          errorMessage={error}
        />
      </div>
    )
  }

  if (mode === 'empty' || !host) {
    return (
      <div className="hidden w-80 shrink-0 items-center justify-center border-l border-slate-800 p-4 text-sm text-slate-500 sm:flex">
        Select a host to see its details.
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-4 border-t border-slate-800 p-4 sm:w-80 sm:border-t-0 sm:border-l">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-100">Host Details</h3>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200 sm:hidden"><CloseIcon aria-hidden="true" className="h-4 w-4" /></button>
      </div>

      <div>
        <p className="text-xs tracking-wide text-slate-500 uppercase">Address</p>
        <p className="text-slate-100">{host.host.address}:{host.host.port}</p>
      </div>

      <div>
        <p className="text-xs tracking-wide text-slate-500 uppercase">General</p>
        <p className="text-slate-100">{host.host.name}</p>
      </div>

      <div>
        <p className="text-xs tracking-wide text-slate-500 uppercase">Credentials</p>
        <ul className="flex flex-col gap-1">
          {host.host.credentials.map((c) => (
            <li key={c.id} className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-sm text-slate-300">
              {c.kind}{c.username ? ` — ${c.username}` : ''}
            </li>
          ))}
        </ul>
      </div>

      {snippets.length > 0 && (
        <div>
          <p className="text-xs tracking-wide text-slate-500 uppercase">Startup snippets</p>
          <p className="mb-1 text-xs text-slate-500">Sent to the shell, in order, right after this host connects.</p>
          <ul className="flex flex-col gap-1">
            {snippets.map((s) => (
              <li key={s.id}>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={(host.host.startupSnippetIds ?? []).includes(s.id)}
                    onChange={() => handleToggleStartupSnippet(s.id)}
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

      <div className="mt-auto flex flex-col gap-2">
        <button
          type="button"
          onClick={handleConnect}
          disabled={isConnecting}
          className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Connect
        </button>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
          >
            Edit
          </button>
        )}
        <button
          type="button"
          onClick={handleDelete}
          className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
        >
          Delete
        </button>
      </div>
    </div>
  )
}
