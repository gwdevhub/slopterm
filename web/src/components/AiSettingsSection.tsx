import { useEffect, useState, type FormEvent } from 'react'
import { getAiSettings, getAiStatus, setAiSettings, type AiStatus } from '../lib/api'
import { notifyAiSettingsChanged } from '../lib/aiSettingsEvents'

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

// The one line under the heading. Ordered by what the user can act on: no endpoint at all
// first (the default, and not a problem), then auth and reachability.
function describeStatus(status: AiStatus | null, local: boolean): string {
  if (status == null) return 'Status unknown'
  if (!status.configured) return 'Off - no server URL set, so terminal tabs show no AI agent'
  if (status.unauthorized) {
    return `${status.baseUrl} rejected the request - the API key is missing, wrong, or the vault is locked`
  }
  if (!status.reachable) {
    return local
      ? `Not reachable at ${status.baseUrl} - is Ollama running?`
      : `Not reachable at ${status.baseUrl} - check the address`
  }
  const count = status.models.length
  return count > 0
    ? `Connected - ${count} model${count === 1 ? '' : 's'} available in each session's AI agent panel`
    : 'Connected, but the server returned no models'
}

// Settings card for the in-terminal AI agent: an OpenAI-compatible endpoint plus an optional
// API key for hosted endpoints that want one. The endpoint is empty out of the box, and that
// is what makes the agent opt-in - a terminal tab shows no AI bar at all until one is entered
// here.
//
// There is deliberately no model field: the endpoint answers /models with what it actually
// has, and the agent bar turns that into a picker inside a session. A text box here could
// only ever be a second, unvalidated way to type a name that list already knows.
//
// Distinct accessible names ("AI agent" heading, "Save AI settings" button) keep the e2e
// specs' exact-match lookups for other sections unambiguous.
export function AiSettingsSection() {
  const [baseUrl, setBaseUrl] = useState('')
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
      const saved = await setAiSettings({ baseUrl, apiKey: key })
      setBaseUrl(saved.baseUrl)
      setHasApiKey(saved.hasApiKey)
      setApiKey('')
      // Terminal tabs decide whether to show their AI bar from this - tell them now rather
      // than leaving it until the next reload.
      notifyAiSettingsChanged()
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
  const statusLine = describeStatus(status, local)

  const statusColor = status?.reachable && status.models.length > 0
    ? 'text-emerald-400'
    : status?.reachable
      ? 'text-amber-400'
      : 'text-slate-400'


  return (
    <div className="flex flex-col gap-3 rounded border border-slate-700 bg-slate-900 p-4">
      <h3 className="font-medium text-slate-100">AI agent</h3>
      <p className="text-xs text-slate-500">
        With this empty, terminal tabs carry no AI bar at all. Any OpenAI-compatible endpoint works. A
        local <span className="text-slate-400">Ollama</span> defaults to{' '}
        <span className="font-mono text-slate-400">http://127.0.0.1:11434/v1</span>.
      </p>

      <p className={`text-sm ${statusColor}`}>{statusLine}</p>

      <form onSubmit={handleSave} className="flex flex-col gap-2">
        <label htmlFor="ai-base-url" className="text-sm font-medium text-slate-300">
          Server URL <span className="font-normal text-slate-500">(empty = agent off)</span>
        </label>
        {/* The greyed-out placeholder doubles as the suggestion for the common local setup:
            leave the field empty and it shows the address a default Ollama listens on. */}
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
        <button
          type="submit"
          disabled={busy}
          className="self-start rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 disabled:opacity-50"
        >
          Save AI settings
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </form>
    </div>
  )
}
