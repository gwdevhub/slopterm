import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { terminalSocketUrl } from '../lib/api'

interface TerminalViewProps {
  sessionId: string
  isActive: boolean
  onSessionClosed: () => void
  // Sent to the shell, in order, right after the socket opens (see the host's attached
  // snippets in HostModal/ConnectionForm) - only meaningful the first time a given
  // session id is seen, same as everything else keyed on [sessionId] below.
  startupCommands?: string[]
}

// Renders only the terminal itself - the tab strip (App.tsx/TabBar.tsx) owns the
// session label and close/disconnect action now that multiple sessions can be open at
// once (issue #9), so a second "Session xxx / Disconnect" header here would be redundant.
export function TerminalView({ sessionId, isActive, onSessionClosed, startupCommands }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const onSessionClosedRef = useRef(onSessionClosed)

  useEffect(() => {
    onSessionClosedRef.current = onSessionClosed
  }, [onSessionClosed])

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
    termRef.current = term

    // Ctrl+C is overloaded in every terminal: with a selection active it should copy
    // (and clear the selection, matching what most terminal emulators do), with nothing
    // selected it's the interrupt signal and must reach the remote process as usual.
    // Ctrl+Shift+C always copies without touching the selection. attachCustomKeyEventHandler
    // runs before xterm's own key handling; returning false suppresses it (so xterm never
    // turns the keydown into onData for the copy cases), returning true lets the keydown
    // fall through to xterm's default handling, which is what actually sends \x03.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey || event.code !== 'KeyC') {
        return true
      }

      if (event.shiftKey) {
        const selection = term.getSelection()
        if (selection) {
          void navigator.clipboard.writeText(selection)
        }
        return false
      }

      if (term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        return false
      }

      return true
    })

    const socket = new WebSocket(terminalSocketUrl(sessionId))
    socket.binaryType = 'arraybuffer'

    const startupTimeouts: ReturnType<typeof setTimeout>[] = []
    socket.addEventListener('open', () => {
      term.focus()

      // A short guard delay before the first one lets the shell's own banner/prompt print
      // first, so the command text doesn't land in the middle of it; spacing the rest out
      // the same way keeps each one from racing a slow prompt on the previous line.
      let delay = 300
      for (const command of startupCommands ?? []) {
        const text = command.endsWith('\n') || command.endsWith('\r') ? command : `${command}\r`
        startupTimeouts.push(
          setTimeout(() => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(new TextEncoder().encode(text))
            }
          }, delay),
        )
        delay += 300
      }
    })
    socket.addEventListener('message', (event) => {
      term.write(new Uint8Array(event.data as ArrayBuffer))
    })
    let disposed = false
    socket.addEventListener('close', () => {
      // Cleanup also closes the socket when React intentionally unmounts this view;
      // only a close received while the view is live represents the session ending.
      if (!disposed) onSessionClosedRef.current()
    })

    const dataDisposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(new TextEncoder().encode(data))
      }
    })

    // NOTE: this only resizes the local xterm.js viewport. The backend's
    // ShellStream has a fixed size for the session (see AGENTS.md); the
    // server-side PTY does not learn about this resize yet.
    //
    // Debounced rather than calling fitAddon.fit() straight from the observer: a real
    // drag-resize fires roughly one ResizeObserver notification per frame (confirmed by
    // instrumenting it directly - ~30 notifications over half a second of dragging), and
    // fit() calling term.resize() does a full renderer clear-and-redraw every time it
    // actually changes cols/rows. Applying that on every intermediate frame - including
    // whatever transient sizes happen to fall exactly on a column/row boundary as a
    // scrollbar's reserved gutter comes in and out of the width calculation - is what
    // reads as flicker; only the settled size after the resize stops actually matters.
    let resizeTimeout: ReturnType<typeof setTimeout> | undefined
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimeout)
      resizeTimeout = setTimeout(() => fitAddon.fit(), 75)
    })
    resizeObserver.observe(container)

    return () => {
      disposed = true
      startupTimeouts.forEach(clearTimeout)
      clearTimeout(resizeTimeout)
      resizeObserver.disconnect()
      dataDisposable.dispose()
      socket.close()
      term.dispose()
      termRef.current = null
    }
    // startupCommands is intentionally excluded - it's fixed for the lifetime of a given
    // sessionId (resolved once at tab-creation time, see App.tsx), so re-running this
    // whole effect over a prop-identity change would just tear down and recreate the same
    // live session for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Re-focus when this tab becomes the active one - it stays mounted-but-hidden while
  // inactive (see App.tsx), so nothing else would move focus back into it on tab switch.
  useEffect(() => {
    if (isActive) {
      termRef.current?.focus()
    }
  }, [isActive])

  // overflow-hidden so this container's own box can never be nudged by xterm's rendered
  // content (e.g. a fractional cell-size rounding mismatch) - it must stay purely
  // parent-driven, since fitAddon.fit() computes rows/cols *from* this element's size.
  return <div ref={containerRef} className="h-full overflow-hidden bg-black p-1 sm:p-2" />
}
