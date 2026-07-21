import { useState } from 'react'
import { ConnectForm } from './components/ConnectForm'
import { TerminalView } from './components/TerminalView'
import { connect, disconnect, type ConnectRequest } from './lib/api'

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

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
        <ConnectForm onConnect={handleConnect} errorMessage={errorMessage} isConnecting={isConnecting} />
      )}
    </div>
  )
}

export default App
