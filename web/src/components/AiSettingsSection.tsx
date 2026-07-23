import { useEffect, useState, type FormEvent } from 'react'
import { getAiSettings, getAiStatus, setAiSettings, type AiStatus } from '../lib/api'

// Duplicated verbatim (as UpdateSection does) rather than shared, so this card stays a
// self-contained clone of the existing settings-field pattern.
const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'

// Settings card for the in-terminal AI agent: a local OpenAI-compatible endpoint (Ollama by
// default) plus the model to use. Distinct accessible names ("AI agent" heading, "Save AI
// settings" button) keep the e2e specs' exact-match lookups for other sections unambiguous.
export function AiSettingsSection() {
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<AiStatus | null>(null)

  useEffect(() => {
    getAiSettings()
      .then((s) => {
        setBaseUrl(s.baseUrl)
        setModel(s.model)
      })
      .catch(() => {})
    void refreshStatus()
  }, [])

  async function refreshStatus() {
    try {
      setStatus(await getAiStatus())
    } catch {
      setStatus(null)
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const saved = await setAiSettings({ baseUrl, model })
      setBaseUrl(saved.baseUrl)
      setModel(saved.model)
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save AI settings')
    } finally {
      setBusy(false)
    }
  }

  const statusLine =
    status == null
      ? 'Status unknown'
      : !status.reachable
        ? `Not reachable at ${status.baseUrl} - is Ollama running?`
        : status.modelAvailable
          ? `Connected - model "${status.model}" is available`
          : `Connected, but model "${status.model}" isn't pulled (run: ollama pull ${status.model})`

  const statusColor =
    status?.reachable && status.modelAvailable ? 'text-emerald-400' : status?.reachable ? 'text-amber-400' : 'text-slate-400'

  return (
    <div className="flex flex-col gap-3 rounded border border-slate-700 bg-slate-900 p-4">
      <h3 className="font-medium text-slate-100">AI agent</h3>
      <p className="text-xs text-slate-500">
        The in-terminal AI agent runs against a local model server - free and private, your terminal
        output never leaves this machine. Install <span className="text-slate-400">Ollama</span>, pull a
        model, and point the fields below at it. Any OpenAI-compatible endpoint works.
      </p>

      <p className={`text-sm ${statusColor}`}>{statusLine}</p>

      <form onSubmit={handleSave} className="flex flex-col gap-2">
        <label htmlFor="ai-base-url" className="text-sm font-medium text-slate-300">
          Server URL
        </label>
        <input
          id="ai-base-url"
          type="text"
          className={inputClasses}
          placeholder="http://127.0.0.1:11434/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <label htmlFor="ai-model" className="text-sm font-medium text-slate-300">
          Model
        </label>
        <div className="flex gap-2">
          <input
            id="ai-model"
            type="text"
            className={inputClasses}
            placeholder="gemma4:12b"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <button
            type="submit"
            disabled={busy}
            className="shrink-0 rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 disabled:opacity-50"
          >
            Save AI settings
          </button>
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </form>
    </div>
  )
}
