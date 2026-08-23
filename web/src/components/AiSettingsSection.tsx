import { useEffect, useState, type FormEvent } from 'react'
import { getAiSettings, getAiStatus, setAiSettings, type AiStatus } from '../lib/api'

// Duplicated verbatim (as UpdateSection does) rather than shared, so this card stays a
// self-contained clone of the existing settings-field pattern.
const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'

// True for an endpoint on this machine - only used to word the status line (Ollama advice vs.
// "check the address/key"); anything unparseable counts as remote.
function isLocalEndpoint(url: string) {
  try {
    const { hostname } = new URL(url)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

// Settings card for the in-terminal AI agent: an OpenAI-compatible endpoint (local Ollama by
// default), the model to use, and an optional API key for hosted endpoints that want one.
// Distinct accessible names ("AI agent" heading, "Save AI settings" button) keep the e2e
// specs' exact-match lookups for other sections unambiguous.
export function AiSettingsSection() {
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  // Write-only: the stored key never comes back from the server, so this box starts empty
  // and staying empty means "keep whatever is saved" (hasApiKey is what we show instead).
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<AiStatus | null>(null)

  useEffect(() => {
    getAiSettings()
      .then((s) => {
        setBaseUrl(s.baseUrl)
        setModel(s.model)
        setHasApiKey(s.hasApiKey)
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

  // `key` is the tri-state API-key field: undefined keeps the stored one, '' clears it.
  async function save(key: string | undefined) {
    setBusy(true)
    setError(null)
    try {
      const saved = await setAiSettings({ baseUrl, model, apiKey: key })
      setBaseUrl(saved.baseUrl)
      setModel(saved.model)
      setHasApiKey(saved.hasApiKey)
      setApiKey('')
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save AI settings')
    } finally {
      setBusy(false)
    }
  }

  function handleSave(event: FormEvent) {
    event.preventDefault()
    void save(apiKey.length > 0 ? apiKey : undefined)
  }

  const local = isLocalEndpoint(status?.baseUrl ?? baseUrl)
  const statusLine =
    status == null
      ? 'Status unknown'
      : status.unauthorized
        ? `${status.baseUrl} rejected the request - the API key is missing, wrong, or the vault is locked`
        : !status.reachable
          ? local
            ? `Not reachable at ${status.baseUrl} - is Ollama running?`
            : `Not reachable at ${status.baseUrl} - check the address (some hosted endpoints don't list models, in which case the agent may still work)`
          : status.modelAvailable
            ? `Connected - model "${status.model}" is available`
            : local
              ? `Connected, but model "${status.model}" isn't pulled (run: ollama pull ${status.model})`
              : `Connected, but the endpoint doesn't list a model named "${status.model}"`

  const statusColor =
    status?.reachable && status.modelAvailable ? 'text-emerald-400' : status?.reachable ? 'text-amber-400' : 'text-slate-400'

  return (
    <div className="flex flex-col gap-3 rounded border border-slate-700 bg-slate-900 p-4">
      <h3 className="font-medium text-slate-100">AI agent</h3>
      <p className="text-xs text-slate-500">
        The in-terminal AI agent talks to any OpenAI-compatible endpoint. By default that's a local
        model server - <span className="text-slate-400">Ollama</span>, free and private, your terminal
        output never leaves this machine. Point it at a hosted endpoint instead and add its API key
        below; your terminal output then goes to that provider.
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
        <label htmlFor="ai-api-key" className="text-sm font-medium text-slate-300">
          API key <span className="font-normal text-slate-500">(optional - not needed for Ollama)</span>
        </label>
        <input
          id="ai-api-key"
          type="password"
          autoComplete="off"
          className={inputClasses}
          placeholder={hasApiKey ? 'Saved - leave blank to keep it' : 'sk-...'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        {hasApiKey && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>A key is stored (encrypted in your vault) and sent as a bearer token.</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save('')}
              className="rounded px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-50"
            >
              Remove key
            </button>
          </div>
        )}
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
