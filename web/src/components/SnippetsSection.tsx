import { useEffect, useState, type FormEvent } from 'react'
import { createSnippet, deleteSnippet, listSnippets, updateSnippet, type SavedSnippet } from '../lib/api'
import { VaultGate } from './VaultGate'
import { CardGrid, EntityCard, cardPrimaryButton, cardSecondaryButton } from './CardGrid'
import { SnippetsIcon } from './icons'

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'

// Saved, reusable commands - copied to the clipboard rather than sent directly into a
// terminal (the nav rail and an active session tab are mutually exclusive in the current
// layout). Same card-grid layout as the Hosts tab (see CardGrid), with create/edit in a modal.
export function SnippetsSection() {
  return (
    <VaultGate>
      <SnippetsList />
    </VaultGate>
  )
}

function SnippetsList() {
  const [snippets, setSnippets] = useState<SavedSnippet[]>([])
  const [query, setQuery] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // Null = no form open; 'new' = create; a snippet = edit it.
  const [editing, setEditing] = useState<SavedSnippet | 'new' | null>(null)

  useEffect(() => {
    refresh()
  }, [])

  function refresh() {
    listSnippets().then(setSnippets)
  }

  async function handleDelete(id: string) {
    await deleteSnippet(id)
    refresh()
  }

  async function handleCopy(id: string, text: string) {
    await navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500)
  }

  const q = query.trim().toLowerCase()
  const filtered = q
    ? snippets.filter((s) => s.snippet.name.toLowerCase().includes(q) || s.snippet.command.toLowerCase().includes(q))
    : snippets

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <CardGrid
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder="Find a snippet…"
          newLabel="New snippet"
          onNew={() => setEditing('new')}
          isEmpty={filtered.length === 0}
          emptyText={snippets.length === 0 ? 'No saved snippets yet.' : 'No snippets match your search.'}
        >
          {filtered.map((s) => (
            <EntityCard
              key={s.id}
              icon={<SnippetsIcon aria-hidden="true" className="h-5 w-5 text-slate-400" />}
              title={<span className="truncate font-medium text-slate-100">{s.snippet.name}</span>}
              subtitle={<span className="font-mono" title={s.snippet.command}>{s.snippet.command}</span>}
              actions={
                <>
                  <button type="button" onClick={() => handleCopy(s.id, s.snippet.command)} className={cardPrimaryButton}>
                    {copiedId === s.id ? 'Copied!' : 'Copy'}
                  </button>
                  <button type="button" onClick={() => setEditing(s)} className={cardSecondaryButton}>
                    Edit
                  </button>
                  <button type="button" onClick={() => handleDelete(s.id)} className={cardSecondaryButton}>
                    Delete
                  </button>
                </>
              }
            />
          ))}
        </CardGrid>
      </div>

      {editing && (
        <SnippetModal
          snippet={editing === 'new' ? null : editing}
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

function SnippetModal({ snippet, onClose, onSaved }: { snippet: SavedSnippet | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(snippet?.snippet.name ?? '')
  const [command, setCommand] = useState(snippet?.snippet.command ?? '')

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (snippet) await updateSnippet(snippet.id, { name, command })
    else await createSnippet({ name, command })
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form onSubmit={handleSubmit} className="flex w-full max-w-md flex-col gap-3 rounded border border-slate-700 bg-slate-900 p-5">
        <h3 className="font-semibold text-slate-100">{snippet ? 'Edit snippet' : 'New snippet'}</h3>
        <input className={inputClasses} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <textarea className={`${inputClasses} h-24 font-mono text-xs`} placeholder="Command" value={command} onChange={(e) => setCommand(e.target.value)} required />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700">
            Cancel
          </button>
          <button type="submit" className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500">
            {snippet ? 'Save changes' : 'Save snippet'}
          </button>
        </div>
      </form>
    </div>
  )
}
