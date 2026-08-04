import { useEffect, useRef, useState } from 'react'
import { Sidebar, type NavSection } from './components/Sidebar'
import { TabBar, type SessionTab } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { AgentBar } from './components/AgentBar'
import { SftpView } from './components/SftpView'
import { ReconnectingPane } from './components/ReconnectingPane'
import { SectionContent } from './components/SectionContent'
import { ConfirmDialog } from './components/ConfirmDialog'
import { TitleBar } from './components/TitleBar'
import { isDesktopApp } from './lib/photino'
import {
  checkForUpdate,
  connect,
  connectLocalShell,
  disconnect,
  getOpenTabs,
  getVaultStatus,
  listSftpSessions,
  listSshSessions,
  saveOpenTabs,
  saveWindowPosition,
  sftpConnect,
  sftpDisconnect,
  type ConnectRequest,
  type LiveSftpSession,
  type LiveSshSession,
} from './lib/api'
import { pullAppearanceFromVault } from './lib/appearance'
import { onVaultUnlocked } from './lib/vaultEvents'
import { applyFaviconBadge, isTabBadgeEnabled, subscribeTabBadge } from './lib/tabBadge'
import { updateAppBadge } from './lib/appBadge'
import { useMobileKeyboardScroll, useVisualViewportHeight } from './hooks/useMobileKeyboard'

// Checked once at startup (not polled) so the Sidebar's Settings icon can show a small
// "something's new" dot without the user having to open Settings first - the actual
// check/apply UI lives there (UpdateSection.tsx). A failed check (no GitHub token
// configured yet, network hiccup, dev build) just means no dot, never an error the user
// has to deal with on every other screen.
function useUpdateAvailable() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  useEffect(() => {
    checkForUpdate()
      .then((result) => setUpdateAvailable(result.supported && !result.error && result.updateAvailable))
      .catch(() => setUpdateAvailable(false))
  }, [])
  return updateAvailable
}

// Browsers don't expose a "window moved" event, and JS can't reposition the current
// top-level window after the fact anyway (only the launcher can, via Chrome/Edge's
// --window-position/--window-size flags - see server/BrowserLauncher.cs) - so this just
// periodically checks screenX/screenY/outerWidth/outerHeight and reports changes,
// relying on the *next* launch to actually apply them, not this session.
function useRememberWindowPosition() {
  useEffect(() => {
    let lastSent = ''

    function captureAndSave() {
      const position = { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight }
      const json = JSON.stringify(position)
      if (json === lastSent) return
      lastSent = json
      saveWindowPosition(position)
    }

    captureAndSave()
    const interval = setInterval(captureAndSave, 3000)
    window.addEventListener('beforeunload', captureAndSave)
    return () => {
      clearInterval(interval)
      window.removeEventListener('beforeunload', captureAndSave)
    }
  }, [])
}

// Replace the browser's default right-click menu with nothing, so the app reads as a native
// window rather than a web page. Our own context menus (host cards, etc.) open via React
// onContextMenu handlers that run first during bubbling and aren't affected by this. Text
// fields keep their native menu, so right-click paste still works where it's actually useful
// (pasting a share token, a private key, a password).
function useSuppressBrowserContextMenu() {
  useEffect(() => {
    function onContextMenu(event: MouseEvent) {
      const target = event.target as HTMLElement | null
      // data-selectable-text marks read-only surfaces where selecting/copying text is the
      // point (e.g. the AI agent transcript) - they get the browser's own menu back so
      // right-click -> Copy works, same as real text-entry fields.
      if (target?.closest('input, textarea, [contenteditable="true"], [data-selectable-text]')) return
      event.preventDefault()
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [])
}

function requestToOpenTabRecord(tab: SessionTab) {
  const { request } = tab
  // A local tab has no destination and no credential. The stored record requires all four of
  // host/port/username/authMethod, so rather than change a schema every existing vault
  // already holds, they carry a description of what was opened - which is also what makes a
  // restored local tab recognisable as one.
  if (!request) {
    return {
      kind: tab.kind,
      label: tab.label,
      host: 'local',
      port: 0,
      username: 'shell',
      authMethod: 'password' as const,
      secret: undefined,
      passphrase: undefined,
      startupCommands: tab.startupCommands,
      sessionId: tab.sessionId ?? undefined,
    }
  }

  return {
    kind: tab.kind,
    label: tab.label,
    host: request.host,
    port: request.port,
    username: request.username,
    authMethod: request.authMethod,
    // A tab on a SAVED host carries no secret - the frontend never received one - so it
    // records what to resolve instead, and the backend re-resolves on restore. That also
    // means a password changed since the tab was opened is picked up rather than replayed.
    secret: request.authMethod === 'password' ? request.password : request.privateKey,
    passphrase: request.authMethod === 'privateKey' ? request.passphrase : undefined,
    hostId: request.hostId,
    credentialId: request.credentialId,
    startupCommands: tab.startupCommands,
    // So a reload lands back on the shell that's still running rather than opening a second
    // connection beside it - see the restore effect, which only trusts this after checking
    // it against the sessions the backend actually still holds.
    sessionId: tab.sessionId ?? undefined,
  }
}

function App() {
  useRememberWindowPosition()
  useSuppressBrowserContextMenu()
  useMobileKeyboardScroll()
  // Sizes the app to the part of the window the virtual keyboard leaves visible, so the
  // terminal's key toolbar sits above the keyboard instead of underneath it.
  useVisualViewportHeight()
  const updateAvailable = useUpdateAvailable()
  const [section, setSection] = useState<NavSection>('hosts')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [tabs, setTabs] = useState<SessionTab[]>([])
  // null = the currently-selected sidebar section is showing, not any particular tab.
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(null)
  // Guards the persistence effect below from firing (and overwriting the real saved
  // snapshot with an empty one) before the one-time restore-on-startup fetch has resolved.
  const [tabsRestored, setTabsRestored] = useState(false)

  // Favicon tab badge (opt-in, see lib/tabBadge.ts). `unseenTabIds` holds background tabs
  // that produced output the user hasn't looked at yet; the badge turns the accent color
  // while any exist. `badgeEnabled` mirrors the localStorage pref that Settings toggles.
  const [unseenTabIds, setUnseenTabIds] = useState<Set<string>>(new Set())
  const [badgeEnabled, setBadgeEnabled] = useState(isTabBadgeEnabled())
  useEffect(() => subscribeTabBadge(() => setBadgeEnabled(isTabBadgeEnabled())), [])

  function markTabUnseen(id: string) {
    setUnseenTabIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }

  function clearTabUnseen(id: string) {
    setUnseenTabIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const tabsRef = useRef<SessionTab[]>([])
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  // Kept in a ref (like tabsRef) so the Ctrl+T keydown listener can read the currently
  // active tab without re-subscribing on every activeTabId change.
  const activeTabIdRef = useRef<string | null>(activeTabId)
  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  // Appearance is cached in localStorage (applied at first paint in main.tsx) but the vault
  // holds the synced, cross-device copy. Pull it as soon as the vault is readable - now if
  // it's already unlocked (auto-unlocks when no master password is set), and again whenever
  // the user unlocks it - so a theme set on another device shows up here.
  useEffect(() => {
    let cancelled = false
    const pull = () => {
      if (!cancelled) void pullAppearanceFromVault()
    }
    getVaultStatus()
      .then((status) => {
        if (status.unlocked) pull()
      })
      .catch(() => {})
    const unsubscribe = onVaultUnlocked(pull)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Viewing a tab clears its unseen-activity flag (its output is now seen).
  useEffect(() => {
    if (activeTabId) clearTabUnseen(activeTabId)
  }, [activeTabId])

  // Redraw the favicon badge whenever the count, unseen state, or the pref changes.
  useEffect(() => {
    void applyFaviconBadge({ enabled: badgeEnabled, count: tabs.length, hasUnseen: unseenTabIds.size > 0 })
    updateAppBadge(tabs.length)
  }, [badgeEnabled, tabs.length, unseenTabIds])

  const retryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const retryDelaysRef = useRef(new Map<string, number>())

  function cancelReconnect(id: string) {
    const timer = retryTimersRef.current.get(id)
    if (timer) clearTimeout(timer)
    retryTimersRef.current.delete(id)
    retryDelaysRef.current.delete(id)
  }

  function updateTab(id: string, patch: Partial<SessionTab>) {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  function removeTab(id: string) {
    cancelReconnect(id)
    clearTabUnseen(id)
    setTabs((prev) => {
      const remaining = prev.filter((t) => t.id !== id)
      setActiveTabId((current) => {
        if (current !== id) return current
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null
      })
      return remaining
    })
  }

  // Drives both the initial restore-on-startup reconnects and every subsequent retry -
  // retried indefinitely with capped exponential backoff rather than giving up, since the
  // whole point is unattended recovery (e.g. the target host coming back up after a
  // reboot). Stops on its own once the tab is closed/cancelled (checked via tabsRef, which
  // reflects the latest committed tabs state).
  async function attemptConnectTab(tab: SessionTab) {
    updateTab(tab.id, { status: 'connecting', errorMessage: undefined })
    try {
      if (tab.kind === 'local') {
        // Nothing to dial and nothing to authenticate - "reconnecting" a local tab is just
        // starting a fresh shell, which is why this one can't meaningfully fail twice.
        const response = await connectLocalShell({ columns: 80, rows: 24 })
        if (!tabsRef.current.some((t) => t.id === tab.id)) {
          void disconnect(response.sessionId)
          return
        }
        updateTab(tab.id, { sessionId: response.sessionId, status: 'connected' })
      } else if (!tab.request) {
        // Only a local tab is allowed to have no request, and it was handled above - a
        // remote tab without one has nothing to dial, so retrying forever would be a loop
        // that could never succeed.
        updateTab(tab.id, { status: 'error', errorMessage: 'This tab has no saved connection details.' })
      } else if (tab.kind === 'ssh') {
        const response = await connect(tab.request)
        if (!tabsRef.current.some((t) => t.id === tab.id)) {
          void disconnect(response.sessionId) // closed while the connect was in flight
          return
        }
        updateTab(tab.id, { sessionId: response.sessionId, status: 'connected' })
      } else {
        const response = await sftpConnect(tab.request)
        if (!tabsRef.current.some((t) => t.id === tab.id)) {
          void sftpDisconnect(response.sessionId)
          return
        }
        updateTab(tab.id, { sessionId: response.sessionId, status: 'connected', homeDirectory: response.homeDirectory })
      }
      retryDelaysRef.current.delete(tab.id)
    } catch (err) {
      if (!tabsRef.current.some((t) => t.id === tab.id)) return // closed/cancelled meanwhile

      updateTab(tab.id, { status: 'error', errorMessage: err instanceof Error ? err.message : 'Failed to reconnect' })
      const nextDelay = Math.min((retryDelaysRef.current.get(tab.id) ?? 2000) * 1.5, 30_000)
      retryDelaysRef.current.set(tab.id, nextDelay)
      retryTimersRef.current.set(
        tab.id,
        setTimeout(() => void attemptConnectTab(tab), nextDelay),
      )
    }
  }

  function retryNow(tab: SessionTab) {
    cancelReconnect(tab.id)
    void attemptConnectTab(tab)
  }

  // Restore whichever tabs were open last time, once - each starts 'connecting' and
  // reconnects itself via attemptConnectTab's retry loop rather than blocking the rest of
  // the app on every tab succeeding first.
  //
  // A tab whose session the backend is still holding skips that entirely and mounts straight
  // onto the running shell. That's the same-process case - the Android WebView's renderer was
  // reclaimed in the background and the page reloaded, or the user hit reload - where the SSH
  // connection never went anywhere. After a real restart no id in the record matches anything
  // live (they're per-process), so every tab takes the reconnect path exactly as before.
  useEffect(() => {
    Promise.all([
      getOpenTabs(),
      listSshSessions().catch(() => [] as LiveSshSession[]),
      listSftpSessions().catch(() => [] as LiveSftpSession[]),
    ])
      .then(([record, liveSsh, liveSftp]) => {
        const liveHomes = new Map(liveSftp.map((s) => [s.sessionId, s.homeDirectory]))
        const liveKinds = new Map(liveSsh.map((s) => [s.sessionId, s.kind]))
        const restored: SessionTab[] = record.tabs.map((t) => {
          // Matched on kind as well as id, now that local shells share the terminal session
          // store: an id is only ever reused within one process, but a tab reattaching to a
          // session of the other kind would mount the wrong view on it entirely.
          const stillLive =
            t.sessionId !== undefined &&
            (t.kind === 'sftp' ? liveHomes.has(t.sessionId) : liveKinds.get(t.sessionId) === t.kind)
          return {
            id: crypto.randomUUID(),
            sessionId: stillLive ? (t.sessionId ?? null) : null,
            label: t.label,
            kind: t.kind,
            // A local shell has nothing to reconnect TO, so it carries no request at all.
            // For the rest, hostId/credentialId are what a saved host reconnects by: the
            // secret fields are only populated for Quick Connect / Recent tabs, since the
            // frontend no longer holds a saved host's credential (see CredentialResolver).
            request:
              t.kind === 'local'
                ? undefined
                : {
                    host: t.host,
                    port: t.port,
                    username: t.username,
                    authMethod: t.authMethod,
                    password: t.authMethod === 'password' ? t.secret : undefined,
                    privateKey: t.authMethod === 'privateKey' ? t.secret : undefined,
                    passphrase: t.authMethod === 'privateKey' ? t.passphrase : undefined,
                    hostId: t.hostId,
                    credentialId: t.credentialId,
                    columns: 80,
                    rows: 24,
                  },
            status: stillLive ? 'connected' : 'connecting',
            startupCommands: t.startupCommands,
            homeDirectory: stillLive && t.sessionId ? liveHomes.get(t.sessionId) : undefined,
          }
        })

        // A local shell is this machine's process and nothing else - it has no destination to
        // dial and no credential to resolve. Reattaching to one that's STILL RUNNING is the
        // point of persisting it at all (a page reload must land back on the same shell), but
        // once that session is gone there is nothing to restore: the tab would sit at
        // "connecting" forever with no request to connect with. So a restart drops them,
        // rather than resurrecting a shell the user never asked to reopen.
        const restorable = restored.filter((tab) => tab.kind !== 'local' || tab.sessionId !== null)

        if (restorable.length > 0) {
          setTabs(restorable)
          const index = record.activeIndex
          const active =
            index !== null && index >= 0 && index < restorable.length ? restorable[index] : restorable[0]
          setActiveTabId(active.id)
          restorable.filter((tab) => tab.sessionId === null).forEach((tab) => void attemptConnectTab(tab))
        }
      })
      .catch(() => {})
      .finally(() => setTabsRestored(true))
    // Intentionally run once on mount only - attemptConnectTab/setTabs/setActiveTabId are
    // all stable enough (refs/setState functions) that re-running this on their account
    // would just re-restore the same tabs a second time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Snapshots the whole tab list (and which one is active) on every change - see
  // OpenTabsRecord's doc comment for why this is a wholesale rewrite rather than a
  // per-tab upsert. Gated on tabsRestored so this can never fire before the restore fetch
  // above resolves and clobber the saved snapshot with an empty one.
  useEffect(() => {
    if (!tabsRestored) return
    const activeIndex = tabs.findIndex((t) => t.id === activeTabId)
    void saveOpenTabs({
      tabs: tabs.map(requestToOpenTabRecord),
      activeIndex: activeIndex >= 0 ? activeIndex : null,
    })
  }, [tabs, activeTabId, tabsRestored])

  function handleSelectSection(nextSection: NavSection) {
    setSection(nextSection)
    setActiveTabId(null)
  }

  // Returns whether the connect succeeded - HostsSection uses this to only remember an ad
  // hoc (Quick Connect/Recent) destination's credential once it's actually proven to work,
  // not on every attempt (a mistyped password shouldn't get remembered for next time).
  async function handleConnect(request: ConnectRequest, startupCommands?: string[]): Promise<boolean> {
    setIsConnecting(true)
    setErrorMessage(null)
    try {
      const response = await connect(request)
      const tab: SessionTab = {
        id: crypto.randomUUID(),
        sessionId: response.sessionId,
        label: `${request.username}@${request.host}`,
        kind: 'ssh',
        request,
        status: 'connected',
        startupCommands,
      }
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
      return true
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to connect')
      return false
    } finally {
      setIsConnecting(false)
    }
  }

  // A shell on the machine slopterm is running on - this PC, or the phone. No form, no
  // credential, no failure mode worth a retry loop: it either starts or it says why.
  async function handleConnectLocal(): Promise<boolean> {
    setIsConnecting(true)
    setErrorMessage(null)
    try {
      const response = await connectLocalShell({ columns: 80, rows: 24 })
      const tab: SessionTab = {
        id: crypto.randomUUID(),
        sessionId: response.sessionId,
        label: `${response.shell} (local)`,
        kind: 'local',
        status: 'connected',
      }
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
      return true
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to open a local shell')
      return false
    } finally {
      setIsConnecting(false)
    }
  }

  async function handleConnectSftp(request: ConnectRequest, label: string): Promise<boolean> {
    setIsConnecting(true)
    setErrorMessage(null)
    try {
      const response = await sftpConnect(request)
      const tab: SessionTab = {
        id: crypto.randomUUID(),
        sessionId: response.sessionId,
        label: `${label} (SFTP)`,
        kind: 'sftp',
        homeDirectory: response.homeDirectory,
        request,
        status: 'connected',
      }
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
      return true
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to connect')
      return false
    } finally {
      setIsConnecting(false)
    }
  }

  // Ctrl+T opens another tab connected to the same server as the active one (issue #51) -
  // a no-op when a sidebar section is showing instead of a tab (nothing to duplicate).
  // Reuses the active tab's own ConnectRequest/kind rather than re-resolving a saved Host,
  // so it works identically for a saved-Host, Quick Connect or Recent-originated tab. A
  // window-level listener (not the xterm handler in TerminalView) is what covers both SSH
  // and SFTP tabs, since SFTP tabs never mount an xterm. preventDefault suppresses the
  // browser/OS default (new browser tab) while the app has focus.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 't' || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      const active = tabsRef.current.find((t) => t.id === activeTabIdRef.current)
      if (!active) return
      if (active.kind === 'local') void handleConnectLocal()
      else if (!active.request) return
      else if (active.kind === 'ssh') void handleConnect(active.request, active.startupCommands)
      else void handleConnectSftp(active.request, active.label.replace(/ \(SFTP\)$/, ''))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // handleConnect/handleConnectSftp are stable enough (plain closures over setState) that
    // re-subscribing on their identity would just churn the listener; the live tab/active-id
    // are read from refs so this stays mounted once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Renaming just updates the tab's label in place - it's persisted (and restored across
  // restarts) for free by the saveOpenTabs effect above, which already snapshots label.
  // Empty/whitespace names are rejected in TabBar, so nothing to guard against here.
  function handleRenameTab(id: string, label: string) {
    updateTab(id, { label })
  }

  function handleCloseTab(id: string) {
    const tab = tabs.find((t) => t.id === id)
    if (tab?.sessionId) {
      if (tab.kind === 'sftp') void sftpDisconnect(tab.sessionId)
      else void disconnect(tab.sessionId)
    }
    removeTab(id)
  }

  function handleTerminalSessionClosed(id: string) {
    // The backend already removed the SSH session before closing its WebSocket. Remove
    // only the local tab here; issuing another disconnect request is unnecessary.
    setPendingCloseTabId((current) => (current === id ? null : current))
    removeTab(id)
  }

  // The session behind this tab is gone but the tab isn't: the terminal's socket dropped and
  // the backend no longer has that session (it aged out of its detached grace period, or was
  // disconnected from elsewhere). Keep the tab and reconnect it - the same treatment a tab
  // gets when the remote host reboots under it. Only handleTerminalSessionClosed above, which
  // means the shell itself ended, still takes the tab away.
  function handleTerminalSessionLost(id: string) {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab) return
    // Any retry chain already running for this tab is superseded by the one below - without
    // this, a tab that loses its session twice ends up with two chains dialling the host.
    cancelReconnect(id)
    const reconnecting: SessionTab = { ...tab, sessionId: null, status: 'connecting', errorMessage: undefined }
    updateTab(id, { sessionId: null, status: 'connecting', errorMessage: undefined })
    void attemptConnectTab(reconnecting)
  }

  // A tab that isn't connected yet has no live session to lose, so closing it skips the
  // "close this session?" confirmation entirely - that dialog exists to prevent
  // accidentally dropping a real connection, which doesn't apply here.
  function handleRequestClose(id: string) {
    const tab = tabs.find((t) => t.id === id)
    if (!tab) return
    if (tab.status === 'connected') {
      setPendingCloseTabId(id)
    } else {
      handleCloseTab(id)
    }
  }

  const pendingCloseTab = tabs.find((t) => t.id === pendingCloseTabId)

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950">
      {isDesktopApp && (
        <TitleBar
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
          onSelectSection={handleSelectSection}
          updateAvailable={updateAvailable}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <Sidebar
          active={section}
          onSelect={handleSelectSection}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
          updateAvailable={updateAvailable}
          hideChromeControls={isDesktopApp}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          <TabBar
            tabs={tabs}
            activeId={activeTabId}
            onSelect={setActiveTabId}
            onClose={handleRequestClose}
            onRename={handleRenameTab}
          />
        <div className="relative min-h-0 flex-1">
          {/* Every open tab's view stays mounted (just hidden) when inactive, so switching
              tabs doesn't tear down its WebSocket/SFTP connection - see issue #9's
              requirement, now shared by both SSH and SFTP tabs. */}
          {tabs.map((tab) => (
            <div key={tab.id} className={`absolute inset-0 ${activeTabId === tab.id ? 'block' : 'hidden'}`}>
              {tab.status === 'connected' && tab.sessionId ? (
                tab.kind !== 'sftp' ? (
                  // Flex column so the AgentBar SHRINKS the terminal instead of overlaying
                  // it - keeps xterm fit() parent-driven (its ResizeObserver auto-refits
                  // when the bar expands/collapses). The bar's collapsed strip is a
                  // fixed-height shrink-0 element present at first paint with no transition,
                  // so it does not induce an extra fit()/redraw at connect time.
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="min-h-0 flex-1">
                      <TerminalView
                        sessionId={tab.sessionId}
                        isActive={activeTabId === tab.id}
                        onSessionClosed={() => handleTerminalSessionClosed(tab.id)}
                        onSessionLost={() => handleTerminalSessionLost(tab.id)}
                        onActivity={() => markTabUnseen(tab.id)}
                        request={tab.request}
                        startupCommands={tab.startupCommands}
                      />
                    </div>
                    <AgentBar sessionId={tab.sessionId} />
                  </div>
                ) : (
                  <SftpView sessionId={tab.sessionId} homeDirectory={tab.homeDirectory ?? '/'} />
                )
              ) : (
                <ReconnectingPane tab={tab} onRetryNow={() => retryNow(tab)} />
              )}
            </div>
          ))}
          {activeTabId === null && (
            <div className="absolute inset-0 overflow-y-auto">
              <SectionContent
                section={section}
                onConnect={handleConnect}
                onConnectSftp={handleConnectSftp}
                onConnectLocal={handleConnectLocal}
                errorMessage={errorMessage}
                isConnecting={isConnecting}
              />
            </div>
          )}
        </div>
      </div>

      {pendingCloseTab && (
        <ConfirmDialog
          title="Close this session?"
          message={
            pendingCloseTab.kind === 'local'
              ? `Close ${pendingCloseTab.label}? This ends the shell running on this machine.`
              : `Close ${pendingCloseTab.label}? This ends its ${pendingCloseTab.kind === 'sftp' ? 'SFTP' : 'SSH'} connection.`
          }
          confirmLabel="Close"
          danger
          onConfirm={() => {
            handleCloseTab(pendingCloseTab.id)
            setPendingCloseTabId(null)
          }}
          onCancel={() => setPendingCloseTabId(null)}
        />
      )}
      </div>
    </div>
  )
}

export default App
