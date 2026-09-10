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
import { isAndroidApp } from './lib/androidBridge'
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

// Checked once at startup (not polled) so the Sidebar's Settings icon can show a "something's new" dot.
function useUpdateAvailable() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  useEffect(() => {
    // The Android app has no update UI at all (Play ships updates), so don't even ask.
    if (isAndroidApp()) return
    checkForUpdate()
      .then((result) => setUpdateAvailable(result.supported && !result.error && result.updateAvailable))
      .catch(() => setUpdateAvailable(false))
  }, [])
  return updateAvailable
}

// Browsers have no "window moved" event and JS can't reposition the window; poll screen coords and rely on the next launch to apply them.
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

// Suppress the browser's default right-click menu so the app reads as native; text fields
// and data-selectable-text surfaces keep theirs.
function useSuppressBrowserContextMenu() {
  useEffect(() => {
    function onContextMenu(event: MouseEvent) {
      const target = event.target as HTMLElement | null
      // data-selectable-text marks read-only surfaces (e.g. the agent transcript) where
      // right-click -> Copy should still work.
      if (target?.closest('input, textarea, [contenteditable="true"], [data-selectable-text]')) return
      event.preventDefault()
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [])
}

function requestToOpenTabRecord(tab: SessionTab) {
  const { request } = tab
  // A local tab has no destination/credential; fill the stored record's required fields with
  // placeholders instead of changing the schema every existing vault holds.
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
    // A saved-host tab carries no secret; record hostId/credentialId so the backend re-resolves on restore.
    secret: request.authMethod === 'password' ? request.password : request.privateKey,
    passphrase: request.authMethod === 'privateKey' ? request.passphrase : undefined,
    hostId: request.hostId,
    credentialId: request.credentialId,
    startupCommands: tab.startupCommands,
    // Lets a reload land back on the still-running shell; the restore effect checks it against live sessions.
    sessionId: tab.sessionId ?? undefined,
  }
}

function App() {
  useRememberWindowPosition()
  useSuppressBrowserContextMenu()
  useMobileKeyboardScroll()
  // Sizes the app to the area the virtual keyboard leaves visible so the key toolbar sits above it.
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

  // Favicon tab badge (opt-in, see lib/tabBadge.ts): background tabs with unseen output.
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

  // Kept in a ref (like tabsRef) so the Ctrl+T listener can read the active tab without re-subscribing.
  const activeTabIdRef = useRef<string | null>(activeTabId)
  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  // Appearance is cached in localStorage but the vault holds the synced cross-device copy;
  // pull it whenever the vault is readable.
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

  useEffect(() => {
    if (activeTabId) clearTabUnseen(activeTabId)
  }, [activeTabId])

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

  // Drives restore-on-startup reconnects and subsequent retries: indefinite capped backoff for
  // unattended recovery, stopping once the tab is gone (checked via tabsRef).
  async function attemptConnectTab(tab: SessionTab) {
    updateTab(tab.id, { status: 'connecting', errorMessage: undefined })
    try {
      if (tab.kind === 'local') {
        // Nothing to dial or authenticate: "reconnecting" a local tab just starts a fresh shell.
        const response = await connectLocalShell({ columns: 80, rows: 24 })
        if (!tabsRef.current.some((t) => t.id === tab.id)) {
          void disconnect(response.sessionId)
          return
        }
        updateTab(tab.id, { sessionId: response.sessionId, status: 'connected' })
      } else if (!tab.request) {
        // Only local tabs may lack a request (handled above); a remote tab without one can never succeed.
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

  // Restore tabs open last time, once. A tab whose session the backend still holds (same-process
  // reload) mounts straight onto it; otherwise each reconnects itself via attemptConnectTab.
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
          // Match on kind too now that local shells share the terminal session store; reattaching
          // to the wrong kind would mount the wrong view.
          const stillLive =
            t.sessionId !== undefined &&
            (t.kind === 'sftp' ? liveHomes.has(t.sessionId) : liveKinds.get(t.sessionId) === t.kind)
          return {
            id: crypto.randomUUID(),
            sessionId: stillLive ? (t.sessionId ?? null) : null,
            label: t.label,
            kind: t.kind,
            // Local carries no request; otherwise hostId/credentialId reconnect a saved host
            // (secret fields only for Quick Connect / Recent).
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

        // Drop local tabs whose session isn't still running: with no request they'd sit at
        // "connecting" forever, so a restart drops them.
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
    // Intentionally run once on mount: re-running would restore the same tabs a second time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Snapshot the whole tab list on every change; gated on tabsRestored so it can't clobber
  // the saved snapshot with an empty one.
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

  // Returns whether the connect succeeded so HostsSection only remembers an ad hoc credential once it works.
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

  // A shell on the machine slopterm runs on - no form, credential, or retry loop.
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

  // Ctrl+T duplicates the active tab (issue #51), reusing its ConnectRequest. A window-level
  // listener covers SSH and SFTP (SFTP tabs never mount an xterm).
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
    // Stable enough; live tab/active-id are read from refs so this stays mounted once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Renaming updates the label in place; persistence is handled by the saveOpenTabs effect.
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
    // The backend already removed the session, so just remove the local tab.
    setPendingCloseTabId((current) => (current === id ? null : current))
    removeTab(id)
  }

  // The session is gone but the tab isn't (socket dropped, backend lost it): keep the tab and
  // reconnect, unlike session-closed above.
  function handleTerminalSessionLost(id: string) {
    const tab = tabsRef.current.find((t) => t.id === id)
    if (!tab) return
    // Supersede any running retry chain, or losing the session twice would leave two chains dialling.
    cancelReconnect(id)
    const reconnecting: SessionTab = { ...tab, sessionId: null, status: 'connecting', errorMessage: undefined }
    updateTab(id, { sessionId: null, status: 'connecting', errorMessage: undefined })
    void attemptConnectTab(reconnecting)
  }

  // An unconnected tab has no live session, so skip the close confirmation.
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
          {/* Every open tab stays mounted (just hidden) when inactive, so switching tabs
              doesn't tear down its WebSocket/SFTP connection. */}
          {tabs.map((tab) => (
            <div key={tab.id} className={`absolute inset-0 ${activeTabId === tab.id ? 'block' : 'hidden'}`}>
              {tab.status === 'connected' && tab.sessionId ? (
                tab.kind !== 'sftp' ? (
                  // Flex column so the AgentBar shrinks the terminal instead of overlaying it,
                  // keeping xterm fit() parent-driven.
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
