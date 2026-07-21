import { useEffect, useState, type FormEvent } from 'react'
import { createSnippet, deleteSnippet, listSnippets, type SavedSnippet } from '../lib/api'
import { VaultGate } from './VaultGate'

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'

// Saved, reusable commands. Copies to the clipboard rather than sending directly into a
// terminal - the nav rail (where this section lives) and an active session tab are
// mutually exclusive in the current layout (see App.tsx), so there's no active terminal
// visible to send into while this section is showing. Direct injection is a natural
// follow-up once/if the app shell and an open session can be shown at the same time.
export function SnippetsSection() {
  return (
    <VaultGate>
      <SnippetsList />
    </VaultGate>
  )
}

function SnippetsList() {
  const [snippets, setSnippets] = useState<SavedSnippet[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    refresh()
  }, [])

  function refresh() {
    listSnippets().then(setSnippets)
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault()
    await createSnippet({ name, command })
    setName('')
    setCommand('')
    refresh()
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

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-slate-100">Snippets</h2>

      <ul className="flex flex-col gap-2">
        {snippets.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 rounded border border-slate-700 bg-slate-900 p-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-100">{s.snippet.name}</p>
              <p className="truncate font-mono text-xs text-slate-400">{s.snippet.command}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => handleCopy(s.id, s.snippet.command)}
                className="rounded bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-500"
              >
                {copiedId === s.id ? 'Copied!' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={() => handleDelete(s.id)}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-slate-300 hover:bg-slate-700"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
        {snippets.length === 0 && <p className="text-sm text-slate-500">No saved snippets yet.</p>}
      </ul>

      <form onSubmit={handleAdd} className="flex flex-col gap-2 border-t border-slate-800 pt-4">
        <h3 className="text-sm font-medium text-slate-300">Add a snippet</h3>
        <input className={inputClasses} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <textarea
          className={`${inputClasses} h-20 font-mono text-xs`}
          placeholder="Command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          required
        />
        <button type="submit" className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500">
          Save snippet
        </button>
      </form>
    </div>
  )
}
