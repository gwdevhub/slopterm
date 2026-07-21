import { useState } from 'react'
import { ConnectForm } from './components/ConnectForm'
import { TerminalView } from './components/TerminalView'
import { VaultPanel } from './components/VaultPanel'
import { connect, disconnect, type ConnectRequest } from './lib/api'

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [tab, setTab] = useState<'quick' | 'saved'>('quick')

  async function handleConnect(request: ConnectRequest) {
    setIsConnecting(true)
    setErrorMessage(null)
    try {
      const response = await connect(request)
      setSessionId(response.sessionId)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setIsConnecting(false)
    }
  }

  function handleClose() {
    if (sessionId) {
      void disconnect(sessionId)
    }
    setSessionId(null)
  }

  return (
    <div className="h-full bg-slate-950">
      {sessionId ? (
        <TerminalView sessionId={sessionId} onClose={handleClose} />
      ) : (
        <div>
          <div className="flex justify-center gap-2 border-b border-slate-800 p-2">
            <button
              type="button"
              onClick={() => setTab('quick')}
              className={`rounded px-3 py-1 text-sm ${tab === 'quick' ? 'bg-indigo-600 text-white' : 'text-slate-400'}`}
            >
              Quick Connect
            </button>
            <button
              type="button"
              onClick={() => setTab('saved')}
              className={`rounded px-3 py-1 text-sm ${tab === 'saved' ? 'bg-indigo-600 text-white' : 'text-slate-400'}`}
            >
              Saved Hosts
            </button>
          </div>
          {tab === 'quick' ? (
            <ConnectForm onConnect={handleConnect} errorMessage={errorMessage} isConnecting={isConnecting} />
          ) : (
            <VaultPanel onConnect={handleConnect} />
          )}
        </div>
      )}
    </div>
  )
}

export default App
