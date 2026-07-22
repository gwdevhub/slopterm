import { useState } from 'react'
import { createHost, deleteHost, type ConnectRequest, type CredentialRecord, type SavedHost } from '../lib/api'
import { ConnectionForm, type ConnectionFormValues } from './ConnectionForm'
import { CloseIcon } from './icons'

interface HostDetailsPanelProps {
  mode: 'view' | 'new' | 'empty'
  host?: SavedHost
  onConnect: (request: ConnectRequest) => void
  onDeleted: () => void
  onSaved: () => void
  onClose: () => void
}

// The right-hand "Host Details" panel from the Termius reference (issue #8). Full
// multi-credential editing (password/key/certificate/env var side by side) is issue #12 -
// this shows the credential list read-only for existing hosts and a single credential
// (password or private key, via the shared ConnectionForm) when creating a new one.
export function HostDetailsPanel({ mode, host, onConnect, onDeleted, onSaved, onClose }: HostDetailsPanelProps) {
  const [error, setError] = useState<string | null>(null)

  async function handleSave(values: ConnectionFormValues) {
    setError(null)
    try {
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
      await createHost({
        name: values.name ?? '',
        address: values.host,
        port: values.port,
        credentials: [credential],
      })
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
    const credential = host.host.credentials.find((c) => c.kind === 'password' || c.kind === 'privateKey')
    if (!credential) return
    onConnect({
      host: host.host.address,
      port: host.host.port,
      username: credential.username ?? '',
      authMethod: credential.kind === 'password' ? 'password' : 'privateKey',
      password: credential.kind === 'password' ? credential.secret : undefined,
      privateKey: credential.kind === 'privateKey' ? credential.secret : undefined,
      passphrase: credential.kind === 'privateKey' ? credential.passphrase : undefined,
      columns: 80,
      rows: 24,
    })
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

      <div className="mt-auto flex flex-col gap-2">
        <button
          type="button"
          onClick={handleConnect}
          className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500"
        >
          Connect
        </button>
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
