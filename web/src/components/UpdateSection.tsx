import { useEffect, useRef, useState } from 'react'
import {
  applyUpdate,
  checkForUpdate,
  getGithubTokenStatus,
  getUpdateProgress,
  setGithubToken,
  type UpdateCheckResult,
} from '../lib/api'

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 12) : 'unknown'
}

const PHASE_LABEL: Record<string, string> = {
  downloading: 'Downloading update…',
  verifying: 'Verifying download…',
  installing: 'Installing…',
  restarting: 'Restarting slopterm…',
}

// Polls /api/update/progress while an update is being applied. Once the backend reaches
// "restarting" it calls app.StopAsync() and spawns the replacement process (see
// Program.cs's /api/update/apply) - the old process (and this poll) dies right around
// there, so a failed poll after "restarting" is expected, not an error: it means the
// swap is done and we should start waiting for the *new* process to come back up instead
// of surfacing a scary error message.
function UpdateProgressDialog({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<string>('downloading')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [waitingForRestart, setWaitingForRestart] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Once verification passes, the backend swaps the exe in place and calls
    // app.StopAsync() to free the port before spawning the replacement process - the
    // whole install+shutdown sequence is fast enough that a real run never actually
    // managed to report "installing"/"restarting" before the connection dropped (verified
    // against the real repo/API: observed phases went straight from "verifying" to the
    // connection being refused). So the threshold for "a dropped connection here is the
    // expected restart, not a failure" has to be "verification already passed" - waiting
    // to see "restarting" specifically would show a false error on every real run.
    let pastPointOfNoReturn = false

    async function pollProgress() {
      while (!cancelled && !pastPointOfNoReturn) {
        try {
          const p = await getUpdateProgress()
          if (cancelled) return
          setPhase(p.phase)
          setPercent(p.percent)
          if (p.phase === 'error') {
            setError(p.error)
            return
          }
          if (p.phase === 'verifying' || p.phase === 'installing' || p.phase === 'restarting') {
            pastPointOfNoReturn = true
            break
          }
        } catch {
          // A drop before verification has even started/passed is a real failure (e.g.
          // the download itself never reached the server) - surface it.
          if (!cancelled) {
            setError('Lost contact with slopterm unexpectedly.')
          }
          return
        }
        await new Promise((r) => setTimeout(r, 500))
      }

      if (cancelled || !pastPointOfNoReturn) return
      setWaitingForRestart(true)

      // The old process is gone by now (or about to be) - poll the root URL directly
      // (not /api/update/progress, which belongs to a process that no longer exists)
      // until the *new* process answers, then reload to pick it up fresh.
      while (!cancelled) {
        try {
          const res = await fetch('/', { cache: 'no-store' })
          if (res.ok) {
            window.location.reload()
            return
          }
        } catch {
          // Expected while the old process is shutting down / the new one is still
          // starting - keep polling.
        }
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    void pollProgress()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-sm rounded border border-slate-700 bg-slate-900 p-5">
        <h3 className="font-semibold text-slate-100">Updating slopterm</h3>
        {error ? (
          <>
            <p className="mt-3 text-sm text-red-400">{error}</p>
            <button
              type="button"
              onClick={onDone}
              className="mt-4 rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
            >
              Close
            </button>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm text-slate-300">
              {waitingForRestart ? 'Waiting for slopterm to come back up…' : (PHASE_LABEL[phase] ?? 'Working…')}
            </p>
            {!waitingForRestart && phase === 'downloading' && (
              <div className="mt-3 h-2 overflow-hidden rounded bg-slate-800">
                <div className="h-full bg-indigo-600 transition-all" style={{ width: `${Math.round(percent)}%` }} />
              </div>
            )}
            <p className="mt-3 text-xs text-slate-500">
              The app will restart automatically once this finishes - any open sessions will close.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

export function UpdateSection() {
  const [check, setCheck] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(true)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [hasToken, setHasToken] = useState<boolean | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [showProgress, setShowProgress] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    getGithubTokenStatus()
      .then((s) => setHasToken(s.hasToken))
      .catch(() => setHasToken(false))
    void refreshCheck()
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function refreshCheck() {
    setChecking(true)
    setCheckError(null)
    try {
      const result = await checkForUpdate()
      if (mountedRef.current) setCheck(result)
    } catch (err) {
      if (mountedRef.current) setCheckError(err instanceof Error ? err.message : 'Failed to check for updates')
    } finally {
      if (mountedRef.current) setChecking(false)
    }
  }

  const updateAvailable = check?.supported && !check.error && check.updateAvailable

  // One button whose meaning tracks whatever state the check is in - "Update now" only
  // when there's actually somewhere to go, "Check now" otherwise (including right after
  // an error or in dev mode, where re-checking is harmless even if unlikely to help),
  // and disabled with a "Checking…" label while a check is in flight so it's never
  // ambiguous whether a click landed.
  function handlePrimaryAction() {
    if (checking) return
    if (updateAvailable) {
      void handleUpdateNow()
    } else {
      void refreshCheck()
    }
  }

  async function handleSaveToken(event: React.FormEvent) {
    event.preventDefault()
    setTokenBusy(true)
    setTokenError(null)
    try {
      const result = await setGithubToken(tokenInput || null)
      setHasToken(result.hasToken)
      setTokenInput('')
      void refreshCheck()
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Failed to save token')
    } finally {
      setTokenBusy(false)
    }
  }

  async function handleUpdateNow() {
    if (!check?.assetId || !check.latestSha256) return
    const confirmed = window.confirm(
      'This downloads and installs the latest build, then restarts slopterm. Any open sessions will be closed. Continue?',
    )
    if (!confirmed) return

    setShowProgress(true)
    try {
      await applyUpdate(check.assetId, check.latestSha256)
    } catch {
      // The progress dialog's own polling surfaces any failure - nothing more to do here.
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-slate-800 pt-4">
      <h3 className="font-medium text-slate-100">Updates</h3>

      <div className="flex flex-col gap-2 rounded border border-slate-700 bg-slate-900 p-4">
        {checking && <p className="text-sm text-slate-400">Checking for updates…</p>}
        {!checking && checkError && <p className="text-sm text-red-400">{checkError}</p>}
        {!checking && check && !check.supported && (
          <p className="text-sm text-slate-400">{check.error ?? 'Update checks are not available.'}</p>
        )}
        {!checking && check?.supported && check.error && <p className="text-sm text-amber-300">{check.error}</p>}
        {!checking && check?.supported && !check.error && !check.updateAvailable && (
          <p className="text-sm text-emerald-400">
            You're up to date <span className="text-slate-500">({shortSha(check.currentSha256)})</span>
          </p>
        )}
        {!checking && check?.supported && !check.error && check.updateAvailable && (
          <>
            <p className="text-sm text-slate-100">
              A new version is available{check.latestTagName ? ` (${check.latestTagName})` : ''}.
            </p>
            <p className="text-xs text-slate-500">
              {shortSha(check.currentSha256)} → {shortSha(check.latestSha256)}
            </p>
          </>
        )}
        <button
          type="button"
          onClick={handlePrimaryAction}
          disabled={checking}
          className={`self-start rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
            updateAvailable ? 'bg-indigo-600 hover:bg-indigo-500' : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
          }`}
        >
          {checking ? 'Checking…' : updateAvailable ? 'Update now' : 'Check now'}
        </button>
      </div>

      <form onSubmit={handleSaveToken} className="flex flex-col gap-2">
        <label htmlFor="github-token" className="text-sm font-medium text-slate-300">
          GitHub token
        </label>
        <p className="text-xs text-slate-500">
          Only needed if gwdevhub/terminal is private, or you hit GitHub's unauthenticated
          rate limit (a fine-grained personal access token with read-only access to this
          repo is enough).
          {hasToken === true && ' A token is currently set.'}
          {hasToken === false && ' No token is set yet.'}
        </p>
        <div className="flex gap-2">
          <input
            id="github-token"
            type="password"
            className={inputClasses}
            placeholder={hasToken ? '••••••••••••••••' : 'ghp_…'}
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
          />
          <button
            type="submit"
            disabled={tokenBusy}
            className="shrink-0 rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 disabled:opacity-50"
          >
            Save
          </button>
          {hasToken && (
            <button
              type="button"
              disabled={tokenBusy}
              onClick={async () => {
                setTokenBusy(true)
                try {
                  const result = await setGithubToken(null)
                  setHasToken(result.hasToken)
                  void refreshCheck()
                } finally {
                  setTokenBusy(false)
                }
              }}
              className="shrink-0 rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
        {tokenError && <p className="text-sm text-red-400">{tokenError}</p>}
      </form>

      {showProgress && <UpdateProgressDialog onDone={() => setShowProgress(false)} />}
    </div>
  )
}
