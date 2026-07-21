import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { terminalSocketUrl } from '../lib/api'

interface TerminalViewProps {
  sessionId: string
  onClose: () => void
}

export function TerminalView({ sessionId, onClose }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()

    const socket = new WebSocket(terminalSocketUrl(sessionId))
    socket.binaryType = 'arraybuffer'

    socket.addEventListener('open', () => term.focus())
    socket.addEventListener('message', (event) => {
      term.write(new Uint8Array(event.data as ArrayBuffer))
    })
    socket.addEventListener('close', () => {
      term.write('\r\n\x1b[31m[connection closed]\x1b[0m\r\n')
    })

    const dataDisposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(new TextEncoder().encode(data))
      }
    })

    // NOTE: this only resizes the local xterm.js viewport. The backend's
    // ShellStream has a fixed size for the session (see AGENTS.md); the
    // server-side PTY does not learn about this resize yet.
    const resizeObserver = new ResizeObserver(() => fitAddon.fit())
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      dataDisposable.dispose()
      socket.close()
      term.dispose()
    }
  }, [sessionId])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-900 px-3 py-2">
        <span className="truncate text-sm text-slate-300">Session {sessionId.slice(0, 8)}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded bg-slate-800 px-3 py-1 text-sm text-slate-200 hover:bg-slate-700"
        >
          Disconnect
        </button>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 bg-black p-1 sm:p-2" />
    </div>
  )
}
