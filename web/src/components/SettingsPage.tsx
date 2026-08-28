import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  exportVaultBackup,
  getSettings,
  importVaultBackup,
  resetVaultToDefault,
  setCloseToTray,
  setRequireMasterPassword,
  setSessionNotificationBadge,
  setShowSshConfigHosts,
} from '../lib/api'
import { ConfirmDialog } from './ConfirmDialog'
import { AiSettingsSection } from './AiSettingsSection'
import { UpdateSection } from './UpdateSection'
import { isTabBadgeEnabled, setTabBadgeEnabled } from '../lib/tabBadge'
import { isAndroidApp, isMobileApp, saveFileViaAndroid } from '../lib/androidBridge'

const inputClasses =
  'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-slate-400 focus:outline-none'

export function SettingsPage() {
  const [requireMasterPassword, setRequireMasterPasswordState] = useState<boolean | null>(null)
  const [mode, setMode] = useState<'idle' | 'confirmingDisable' | 'confirmingEnable'>('idle')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [closeToTray, setCloseToTrayState] = useState<boolean | null>(null)
  const [closeToTrayBusy, setCloseToTrayBusy] = useState(false)
  const [closeToTrayError, setCloseToTrayError] = useState<string | null>(null)

  const [showSshConfigHosts, setShowSshConfigHostsState] = useState<boolean | null>(null)
  const [showSshConfigHostsBusy, setShowSshConfigHostsBusy] = useState(false)
  const [showSshConfigHostsError, setShowSshConfigHostsError] = useState<string | null>(null)

  const [sessionBadge, setSessionBadgeState] = useState<boolean | null>(null)
  const [sessionBadgeBusy, setSessionBadgeBusy] = useState(false)
  const [sessionBadgeError, setSessionBadgeError] = useState<string | null>(null)

  // Client-side visual pref (localStorage), not a backend setting - see lib/tabBadge.ts.
  const [tabBadge, setTabBadge] = useState(isTabBadgeEnabled())

  const [exportError, setExportError] = useState<string | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const importFileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getSettings().then((s) => {
      setRequireMasterPasswordState(s.requireMasterPassword)
      setCloseToTrayState(s.closeToTray)
      setShowSshConfigHostsState(s.showSshConfigHosts)
      setSessionBadgeState(s.sessionNotificationBadge)
    })
  }, [])

  async function handleExport() {
    setExportError(null)
    try {
      const blob = await exportVaultBackup()
      const fileName = `slopterm-vault-backup-${new Date().toISOString().slice(0, 10)}.zip`
      // On Android a WebView can't do a blob download; hand the bytes to the native save dialog
      // instead. Everywhere else this returns false and we do the normal anchor download.
      if (await saveFileViaAndroid(blob, fileName, 'application/zip')) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Failed to export backup')
    }
  }

  function handleImportClick() {
    importFileInputRef.current?.click()
  }

  function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setPendingImportFile(file)
  }

  async function handleConfirmImport() {
    const file = pendingImportFile
    setPendingImportFile(null)
    if (!file) return

    setImportBusy(true)
    setImportError(null)
    try {
      await importVaultBackup(file)
      // Vault existence/lock-state/settings all changed under the app's feet - reload
      // so every component (VaultGate, this page's own state, etc.) re-fetches fresh
      // instead of trying to patch a dozen pieces of now-stale client state by hand.
      window.location.reload()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import backup')
      setImportBusy(false)
    }
  }

  async function handleConfirmReset() {
    setResetConfirmOpen(false)
    setResetBusy(true)
    setResetError(null)
    try {
      await resetVaultToDefault()
      window.location.reload()
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Failed to reset')
      setResetBusy(false)
    }
  }

  function handleToggleClick() {
    setError(null)
    setPassword('')
    setMode(requireMasterPassword ? 'confirmingDisable' : 'confirmingEnable')
  }

  async function handleConfirm(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result =
        mode === 'confirmingDisable'
          ? await setRequireMasterPassword(false, password)
          : await setRequireMasterPassword(true, undefined, password)
      setRequireMasterPasswordState(result.requireMasterPassword)
      setMode('idle')
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update setting')
    } finally {
      setBusy(false)
    }
  }

  async function handleToggleCloseToTray() {
    if (closeToTray === null) return
    setCloseToTrayBusy(true)
    setCloseToTrayError(null)
    try {
      const result = await setCloseToTray(!closeToTray)
      setCloseToTrayState(result.closeToTray)
    } catch (err) {
      setCloseToTrayError(err instanceof Error ? err.message : 'Failed to update setting')
    } finally {
      setCloseToTrayBusy(false)
    }
  }

  async function handleToggleShowSshConfigHosts() {
    if (showSshConfigHosts === null) return
    setShowSshConfigHostsBusy(true)
    setShowSshConfigHostsError(null)
    try {
      const result = await setShowSshConfigHosts(!showSshConfigHosts)
      setShowSshConfigHostsState(result.showSshConfigHosts)
    } catch (err) {
      setShowSshConfigHostsError(err instanceof Error ? err.message : 'Failed to update setting')
    } finally {
      setShowSshConfigHostsBusy(false)
    }
  }

  async function handleToggleSessionBadge() {
    if (sessionBadge === null) return
    setSessionBadgeBusy(true)
    setSessionBadgeError(null)
    try {
      const result = await setSessionNotificationBadge(!sessionBadge)
      setSessionBadgeState(result.sessionNotificationBadge)
    } catch (err) {
      setSessionBadgeError(err instanceof Error ? err.message : 'Failed to update setting')
    } finally {
      setSessionBadgeBusy(false)
    }
  }

  if (
    requireMasterPassword === null ||
    closeToTray === null ||
    showSshConfigHosts === null ||
    sessionBadge === null
  ) {
    return <p className="p-4 text-slate-400">Loading settings…</p>
  }

  return (
    // Settings is read-heavy content, not chrome: opt the whole page - its labels, section
    // descriptions, and the encryption/danger-zone warning copy - back into text selection and
    // the native right-click menu, using the same select-text + data-selectable-text pattern as
    // the AI agent transcript (see index.css / issue #61). Marking the root covers the nested
    // AiSettingsSection and UpdateSection too, since they render inside here.
    <div
      data-selectable-text
      className="mx-auto flex w-full max-w-lg select-text flex-col gap-4 p-4 sm:p-6"
    >
      <h2 className="text-lg font-semibold text-slate-100">Settings</h2>

      <div className="flex items-center justify-between gap-4 rounded border border-slate-700 bg-slate-900 p-4">
        <div>
          <p className="font-medium text-slate-100">Require master password</p>
          <p className="text-sm text-slate-400">
            Prompt for a master password to unlock your saved hosts, snippets, and logs.
          </p>
        </div>
        <button
          type="button"
          onClick={handleToggleClick}
          className={`shrink-0 rounded px-4 py-2 text-sm font-medium ${
            requireMasterPassword ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
        >
          {requireMasterPassword ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      <p className="rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
        When disabled, your vault is still encrypted at rest, but with a fixed key built into
        slopterm's own (public) source code instead of a real secret. That only protects
        against casually opening the vault files - it does not protect against anyone who has
        both those files and this app, since they could derive the same key. Only turn this off
        if that trade-off is fine for your use case.
      </p>

      {mode !== 'idle' && (
        <form onSubmit={handleConfirm} className="flex flex-col gap-2 border-t border-slate-800 pt-4">
          <label htmlFor="settings-password" className="text-sm font-medium text-slate-300">
            {mode === 'confirmingDisable' ? 'Enter your current master password to disable it' : 'Choose a new master password'}
          </label>
          <input
            id="settings-password"
            type="password"
            className={inputClasses}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {mode === 'confirmingDisable' ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {navigator.platform.includes('Win') && (
        <div className="flex flex-col gap-3 rounded border border-slate-700 bg-slate-900 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-slate-100">Keep running in the tray when closed</p>
              <p className="text-sm text-slate-400">
                By default, closing slopterm's window quits the app. Turn this on to instead
                minimize it and keep it running behind its tray icon (Windows only).
              </p>
            </div>
            <button
              type="button"
              onClick={handleToggleCloseToTray}
              disabled={closeToTrayBusy}
              aria-label="Keep running in the tray when closed"
              className={`shrink-0 rounded px-4 py-2 text-sm font-medium disabled:opacity-50 ${
                closeToTray ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {closeToTray ? 'On' : 'Off'}
            </button>
          </div>
          {closeToTrayError && <p className="text-sm text-red-400">{closeToTrayError}</p>}
        </div>
      )}

      {!isMobileApp() && (
        <div className="flex flex-col gap-3 rounded border border-slate-700 bg-slate-900 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-slate-100">Show hosts from ~/.ssh/config</p>
              <p className="text-sm text-slate-400">
                List the Host entries from your SSH client config file as read-only cards on the
                Hosts screen, alongside your saved hosts. They can't be edited or deleted here -
                edit the file itself to change them.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleToggleShowSshConfigHosts()}
              disabled={showSshConfigHostsBusy}
              aria-label="Show hosts from ~/.ssh/config"
              className={`shrink-0 rounded px-4 py-2 text-sm font-medium disabled:opacity-50 ${
                showSshConfigHosts ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {showSshConfigHosts ? 'On' : 'Off'}
            </button>
          </div>
          {showSshConfigHostsError && <p className="text-sm text-red-400">{showSshConfigHostsError}</p>}
        </div>
      )}

      {isMobileApp() && (
        <div className="flex flex-col gap-3 rounded border border-slate-700 bg-slate-900 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-slate-100">Badge the app icon while in the background</p>
              <p className="text-sm text-slate-400">
                slopterm holds your connections open for a few minutes after you switch away,
                which Android only allows alongside a notification. Off by default: the
                notification stays silent, minimized, and puts no dot on the app icon. Turn this
                on to have it show up normally instead. Applies the next time you leave the app.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleToggleSessionBadge()}
              disabled={sessionBadgeBusy}
              aria-label="Badge the app icon while in the background"
              className={`shrink-0 rounded px-4 py-2 text-sm font-medium disabled:opacity-50 ${
                sessionBadge ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {sessionBadge ? 'On' : 'Off'}
            </button>
          </div>
          {sessionBadgeError && <p className="text-sm text-red-400">{sessionBadgeError}</p>}
        </div>
      )}

      <div className="flex items-center justify-between gap-4 rounded border border-slate-700 bg-slate-900 p-4">
        <div>
          <p className="font-medium text-slate-100">Show open-tab count on the app icon</p>
          <p className="text-sm text-slate-400">
            Puts a small counter on the browser-tab favicon showing how many sessions are open.
            It turns the accent color when a background tab has new output you haven't seen yet.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            const next = !tabBadge
            setTabBadge(next)
            setTabBadgeEnabled(next)
          }}
          aria-label="Show open-tab count on the app icon"
          className={`shrink-0 rounded px-4 py-2 text-sm font-medium ${
            tabBadge ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
          }`}
        >
          {tabBadge ? 'On' : 'Off'}
        </button>
      </div>

      <AiSettingsSection />

      {/* Nothing in the Updates section applies to the Android app: updates come from Google
          Play (UpdateService bails out before any network call there), and the GitHub token
          below it only exists to raise the rate limit of the check that never runs. All the
          card could do on a phone was offer a "Check now" button that reports it doesn't
          check - so it isn't rendered at all. Keyed off the native bridge, not the user
          agent: a phone browser pointed at a DESKTOP slopterm can still self-update it. */}
      {!isAndroidApp() && <UpdateSection />}

      <div className="flex flex-col gap-3 border-t border-slate-800 pt-4">
        <h3 className="font-medium text-slate-100">Backup</h3>
        <p className="text-sm text-slate-400">
          Export your vault to move it to another machine or keep a copy somewhere safe.
          The export is still encrypted the same way it is on disk - nothing is decrypted
          in the process.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleExport}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Export backup
          </button>
          <button
            type="button"
            onClick={handleImportClick}
            disabled={importBusy}
            className="rounded bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 disabled:opacity-50"
          >
            {importBusy ? 'Importing…' : 'Import backup'}
          </button>
          <input ref={importFileInputRef} type="file" accept=".zip" className="hidden" onChange={handleImportFile} />
        </div>
        {exportError && <p className="text-sm text-red-400">{exportError}</p>}
        {importError && <p className="text-sm text-red-400">{importError}</p>}
      </div>

      <div className="flex flex-col gap-3 border-t border-red-900/50 pt-4">
        <h3 className="font-medium text-red-400">Danger zone</h3>
        <p className="text-sm text-slate-400">
          Permanently delete every saved host, snippet, Keychain entry, and log, and reset
          Settings to default.
        </p>
        <button
          type="button"
          onClick={() => setResetConfirmOpen(true)}
          disabled={resetBusy}
          className="self-start rounded border border-red-800 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-950 disabled:opacity-50"
        >
          {resetBusy ? 'Resetting…' : 'Reset everything to default'}
        </button>
        {resetError && <p className="text-sm text-red-400">{resetError}</p>}
      </div>

      {pendingImportFile && (
        <ConfirmDialog
          title="Import backup?"
          message="Importing a backup replaces your current vault entirely - hosts, snippets, Keychain entries, logs, and settings - with whatever is in the file. This cannot be undone."
          confirmLabel="Import"
          danger
          onConfirm={() => void handleConfirmImport()}
          onCancel={() => setPendingImportFile(null)}
        />
      )}

      {resetConfirmOpen && (
        <ConfirmDialog
          title="Reset everything?"
          message="This permanently deletes every saved host, snippet, Keychain entry, and log, and resets Settings to default. This cannot be undone."
          confirmLabel="Reset"
          danger
          onConfirm={() => void handleConfirmReset()}
          onCancel={() => setResetConfirmOpen(false)}
        />
      )}
    </div>
  )
}
