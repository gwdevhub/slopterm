import { useEffect, useState } from 'react'
import { createHost, deleteHost, updateHost, type CredentialRecord, type HostRecord, type SavedHost } from '../lib/api'
import { ConnectionForm, type ConnectionFormValues } from './ConnectionForm'
import { ConfirmDialog } from './ConfirmDialog'
import { CloseIcon } from './icons'

interface HostModalProps {
  // Undefined means "creating a new host" - the same modal handles both, same as
  // ConnectionForm's own new/edit duality.
  host?: SavedHost
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
  // Fired after "Duplicate" creates the copy, with its new id - the caller re-opens this
  // same modal for that copy so the user can immediately adjust the address/username
  // rather than having to find and re-open it themselves (issue #54).
  onDuplicated: (newHostId: string) => void
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
    groupName: host.host.parentGroupId ?? undefined,
  }
}

function formValuesToHost(values: ConnectionFormValues): HostRecord {
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
    parentGroupId: values.groupName,
  }
}

// Replaces the old always-visible right-hand Host Details sidebar - most of the time
// users just want to dive straight into a host (SSH/SFTP buttons, double-click), not
// browse its details, so that space was wasted for the common case. Editing (and, now,
// duplicating/deleting) is a deliberate action via a card's small pencil icon or its
// context menu, opening this modal instead of permanently reserving desktop real estate
// for it.
export function HostModal({ host, onClose, onSaved, onDeleted, onDuplicated, isConnecting }: HostModalProps) {
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Let the delete confirmation own Escape while it's up - one press should cancel
      // just that, not also dismiss this modal underneath it and lose unsaved edits.
      if (event.key === 'Escape' && !confirmDeleteOpen) {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, confirmDeleteOpen])

  async function handleSubmit(values: ConnectionFormValues) {
    setError(null)
    try {
      if (host) {
        await updateHost(host.id, formValuesToHost(values))
      } else {
        await createHost(formValuesToHost(values))
      }
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

  async function handleDuplicate() {
    if (!host) return
    setError(null)
    try {
      const { id } = await createHost({ ...host.host, name: `${host.host.name} (copy)` })
      onDuplicated(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to duplicate host')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded border border-slate-700 bg-slate-900">
        <div className="flex items-center justify-between p-4 pb-0">
          <h3 className="font-semibold text-slate-100">{host ? 'Edit host' : 'New host'}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <CloseIcon aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <ConnectionForm
          key={host?.id ?? 'new'}
          includeName
          submitLabel={host ? 'Save changes' : 'Save host'}
          initialValues={host ? hostToFormValues(host) : undefined}
          isSubmitting={isConnecting}
          onSubmit={handleSubmit}
          errorMessage={error}
        />
        {host && (
          <div className="flex gap-2 border-t border-slate-800 p-4">
            <button
              type="button"
              onClick={() => void handleDuplicate()}
              className="flex-1 rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
            >
              Duplicate
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              aria-label="Delete host"
              onClick={() => setConfirmDeleteOpen(true)}
              className="flex-1 rounded bg-red-900/60 px-4 py-2 text-sm text-red-300 hover:bg-red-900"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {confirmDeleteOpen && (
        <ConfirmDialog
          title="Delete this host?"
          message={`Delete "${host?.host.name}"? This can't be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            setConfirmDeleteOpen(false)
            void handleDelete()
          }}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}
    </div>
  )
}
