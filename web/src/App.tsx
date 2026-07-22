import { useEffect, useState } from 'react'
import { Sidebar, type NavSection } from './components/Sidebar'
import { TabBar, type SessionTab } from './components/TabBar'
import { TerminalView } from './components/TerminalView'
import { SftpView } from './components/SftpView'
import { SectionContent } from './components/SectionContent'
import { connect, disconnect, saveWindowPosition, sftpConnect, sftpDisconnect, type ConnectRequest } from './lib/api'

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

function App() {
  useRememberWindowPosition()
  const [section, setSection] = useState<NavSection>('hosts')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [tabs, setTabs] = useState<SessionTab[]>([])
  // null = the currently-selected sidebar section is showing, not any particular tab.
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  function handleSelectSection(nextSection: NavSection) {
    setSection(nextSection)
    setActiveTabId(null)
  }

  async function handleConnect(request: ConnectRequest) {
    setIsConnecting(true)
    setErrorMessage(null)
    try {
      const response = await connect(request)
      const tab: SessionTab = { id: response.sessionId, label: `${request.username}@${request.host}`, kind: 'ssh' }
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setIsConnecting(false)
    }
  }

  async function handleConnectSftp(request: ConnectRequest, label: string) {
    setIsConnecting(true)
    setErrorMessage(null)
    try {
      const response = await sftpConnect(request)
      const tab: SessionTab = {
        id: response.sessionId,
        label: `${label} (SFTP)`,
        kind: 'sftp',
        homeDirectory: response.homeDirectory,
      }
      setTabs((prev) => [...prev, tab])
      setActiveTabId(tab.id)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setIsConnecting(false)
    }
  }

  function handleCloseTab(id: string) {
    const tab = tabs.find((t) => t.id === id)
    if (tab?.kind === 'sftp') {
      void sftpDisconnect(id)
    } else {
      void disconnect(id)
    }

    setTabs((prev) => {
      const remaining = prev.filter((t) => t.id !== id)
      setActiveTabId((current) => {
        if (current !== id) return current
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null
      })
      return remaining
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950 sm:flex-row">
      <Sidebar
        active={section}
        onSelect={handleSelectSection}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <TabBar tabs={tabs} activeId={activeTabId} onSelect={setActiveTabId} onClose={handleCloseTab} />
        <div className="relative min-h-0 flex-1">
          {/* Every open tab's view stays mounted (just hidden) when inactive, so switching
              tabs doesn't tear down its WebSocket/SFTP connection - see issue #9's
              requirement, now shared by both SSH and SFTP tabs. */}
          {tabs.map((tab) => (
            <div key={tab.id} className={`absolute inset-0 ${activeTabId === tab.id ? 'block' : 'hidden'}`}>
              {tab.kind === 'ssh' ? (
                <TerminalView sessionId={tab.id} isActive={activeTabId === tab.id} />
              ) : (
                <SftpView sessionId={tab.id} homeDirectory={tab.homeDirectory ?? '/'} />
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
    </div>
  )
}

export default App
