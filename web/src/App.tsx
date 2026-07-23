import { useEffect, useRef, useState } from 'react'
import { Sidebar, type NavSection } from './components/Sidebar'
import { TabBar, type SessionTab } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { SftpView } from './components/SftpView'
import { ReconnectingPane } from './components/ReconnectingPane'
import { SectionContent } from './components/SectionContent'
import { ConfirmDialog } from './components/ConfirmDialog'
import {
  checkForUpdate,
  connect,
  disconnect,
  getOpenTabs,
  saveOpenTabs,
  saveWindowPosition,
  sftpConnect,
  sftpDisconnect,
  type ConnectRequest,
} from './lib/api'

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
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [])
}

function requestToOpenTabRecord(tab: SessionTab) {
  const { request } = tab
  return {
    kind: tab.kind,
    label: tab.label,
    host: request.host,
    port: request.port,
    username: request.username,
    authMethod: request.authMethod,
    secret: request.authMethod === 'password' ? request.password : request.privateKey,
    passphrase: request.authMethod === 'privateKey' ? request.passphrase : undefined,
    startupCommands: tab.startupCommands,
  }
}

function App() {
  useRememberWindowPosition()
  useSuppressBrowserContextMenu()
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

  const tabsRef = useRef<SessionTab[]>([])
  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

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
      if (tab.kind === 'ssh') {
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
  useEffect(() => {
    getOpenTabs()
      .then((record) => {
        const restored: SessionTab[] = record.tabs.map((t) => ({
          id: crypto.randomUUID(),
          sessionId: null,
          label: t.label,
          kind: t.kind,
          request: {
            host: t.host,
            port: t.port,
            username: t.username,
            authMethod: t.authMethod,
            password: t.authMethod === 'password' ? t.secret : undefined,
            privateKey: t.authMethod === 'privateKey' ? t.secret : undefined,
            passphrase: t.authMethod === 'privateKey' ? t.passphrase : undefined,
            columns: 80,
            rows: 24,
          },
          status: 'connecting',
          startupCommands: t.startupCommands,
        }))

        if (restored.length > 0) {
          setTabs(restored)
          const index = record.activeIndex
          const active = index !== null && index >= 0 && index < restored.length ? restored[index] : restored[0]
          setActiveTabId(active.id)
          restored.forEach((tab) => void attemptConnectTab(tab))
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
    <div className="flex h-full min-h-0 flex-col bg-slate-950 sm:flex-row">
      <Sidebar
        active={section}
        onSelect={handleSelectSection}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        updateAvailable={updateAvailable}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <TabBar tabs={tabs} activeId={activeTabId} onSelect={setActiveTabId} onClose={handleRequestClose} />
        <div className="relative min-h-0 flex-1">
          {/* Every open tab's view stays mounted (just hidden) when inactive, so switching
              tabs doesn't tear down its WebSocket/SFTP connection - see issue #9's
              requirement, now shared by both SSH and SFTP tabs. */}
          {tabs.map((tab) => (
            <div key={tab.id} className={`absolute inset-0 ${activeTabId === tab.id ? 'block' : 'hidden'}`}>
              {tab.status === 'connected' && tab.sessionId ? (
                tab.kind === 'ssh' ? (
                  <TerminalView
                    sessionId={tab.sessionId}
                    isActive={activeTabId === tab.id}
                    onSessionClosed={() => handleTerminalSessionClosed(tab.id)}
                    startupCommands={tab.startupCommands}
                  />
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
          message={`Close ${pendingCloseTab.label}? This ends its ${pendingCloseTab.kind === 'sftp' ? 'SFTP' : 'SSH'} connection.`}
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
  )
}

export default App
