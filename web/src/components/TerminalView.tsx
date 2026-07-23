import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { sshUpload, terminalSocketUrl, type ConnectRequest } from '../lib/api'

interface TerminalViewProps {
  sessionId: string
  isActive: boolean
  onSessionClosed: () => void
  // The tab's own connect info - an SSH tab holds only an interactive shell server-side,
  // not an SFTP channel, so paste/drag-to-upload (below) opens a fresh one-shot SFTP
  // connection from this same request rather than reusing the shell.
  request: ConnectRequest
  // Sent to the shell, in order, right after the socket opens (see the host's attached
  // snippets in HostModal/ConnectionForm) - only meaningful the first time a given
  // session id is seen, same as everything else keyed on [sessionId] below.
  startupCommands?: string[]
}

// Turns a Blob/File dropped or pasted into the terminal into a remote file name: keeps a
// real dropped file's own name, and generates a timestamped one for a pasted image (which
// the clipboard exposes with no meaningful name of its own).
function uploadFileName(item: File): string {
  if (item.name) return item.name
  const ext = item.type.split('/')[1] || 'bin'
  return `pasted-${Date.now()}.${ext}`
}

// Renders only the terminal itself - the tab strip (App.tsx/TabBar.tsx) owns the
// session label and close/disconnect action now that multiple sessions can be open at
// once (issue #9), so a second "Session xxx / Disconnect" header here would be redundant.
export function TerminalView({ sessionId, isActive, onSessionClosed, request, startupCommands }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const onSessionClosedRef = useRef(onSessionClosed)
  // Best-effort remote cwd, tracked from OSC 7 (see below) - null until the shell reports
  // one (it never will if it isn't configured to emit OSC 7), which is the signal to fall
  // back to prompting for a destination on upload.
  const remoteCwdRef = useRef<string | null>(null)
  const requestRef = useRef(request)
  const [uploadStatus, setUploadStatus] = useState<{ message: string; error?: boolean } | null>(null)
  const uploadIdRef = useRef(0)

  useEffect(() => {
    onSessionClosedRef.current = onSessionClosed
  }, [onSessionClosed])

  useEffect(() => {
    requestRef.current = request
  }, [request])

  // Uploads dropped/pasted files into the shell's current directory (tracked via OSC 7),
  // or a directory the user is prompted for when that's unknown. Deliberately does NOT feed
  // the bytes into the terminal as input - that's the whole point of intercepting them.
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return

    let remoteDir = remoteCwdRef.current
    if (!remoteDir) {
      // The shell isn't reporting its cwd (no OSC 7 shell integration) - ask rather than
      // guess, matching the SFTP flow's "upload into a known directory" contract.
      remoteDir = window.prompt(
        "This shell isn't reporting its current directory. Enter a remote directory to upload into:",
        '.',
      )
      if (!remoteDir) return
    }

    const thisUploadId = ++uploadIdRef.current
    for (const file of files) {
      const name = uploadFileName(file)
      setUploadStatus({ message: `Uploading ${name}…` })
      try {
        const { remotePath } = await sshUpload(requestRef.current, remoteDir, name, file)
        if (uploadIdRef.current === thisUploadId) {
          setUploadStatus({ message: `Uploaded to ${remotePath}` })
        }
      } catch (err) {
        setUploadStatus({ message: err instanceof Error ? err.message : 'Upload failed', error: true })
        return
      }
    }

    // Only clears the banner if no other upload started in the meantime.
    setTimeout(() => {
      if (uploadIdRef.current === thisUploadId) setUploadStatus(null)
    }, 4000)
  }

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

    // OSC 7 (ESC ]7;file://host/path BEL) is the de-facto shell-integration escape a shell
    // emits on each prompt to report its working directory. Parsing it lets paste/drag
    // uploads target the shell's *actual* cwd, following the user's `cd`s invisibly instead
    // of guessing. Best-effort: many shells don't emit it unless configured to, so a null
    // cwd just means we prompt for a destination instead (see uploadFiles). Returning true
    // marks the sequence handled. The payload is file://<host>/<path>; we only want the path.
    term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data)
        if (url.pathname) remoteCwdRef.current = decodeURIComponent(url.pathname)
      } catch {
        // Not a file:// URL we understand - leave the last known cwd in place.
      }
      return true
    })

    // Ctrl+C is overloaded in every terminal: with a selection active it should copy
    // (and clear the selection, matching what most terminal emulators do), with nothing
    // selected it's the interrupt signal and must reach the remote process as usual.
    // Ctrl+Shift+C always copies without touching the selection. attachCustomKeyEventHandler
    // runs before xterm's own key handling; returning false suppresses it (so xterm never
    // turns the keydown into onData for the copy cases), returning true lets the keydown
    // fall through to xterm's default handling, which is what actually sends \x03.
    term.attachCustomKeyEventHandler((event) => {
      // Ctrl+T is the app's "duplicate this tab" shortcut (issue #51, handled at the
      // window level in App.tsx). Swallow it here so a focused terminal doesn't also send
      // the literal \x14 (DC4) control byte to the remote shell.
      if (event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.code === 'KeyT') {
        return false
      }

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

    // Paste of a non-text clipboard item (e.g. an image from a screenshot tool) uploads it
    // as a file into the shell's cwd instead of feeding it as literal terminal input. Plain
    // text paste is left entirely to xterm (we only preventDefault when there's a file), so
    // it keeps working exactly as before. The listener is on the textarea xterm creates for
    // input, which is where the browser fires the paste.
    const onPaste = (event: ClipboardEvent) => {
      const files = event.clipboardData ? Array.from(event.clipboardData.files) : []
      if (files.length === 0) return // plain text - let xterm handle it as usual
      event.preventDefault()
      event.stopPropagation()
      void uploadFiles(files)
    }
    const textarea = container.querySelector('textarea')
    textarea?.addEventListener('paste', onPaste)

    // Drag a file from the OS onto the terminal to upload it into the shell's cwd. dragover
    // must preventDefault or the browser never fires a drop; copy is the right affordance.
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }
    }
    const onDrop = (event: DragEvent) => {
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : []
      if (files.length === 0) return
      event.preventDefault()
      void uploadFiles(files)
    }
    container.addEventListener('dragover', onDragOver)
    container.addEventListener('drop', onDrop)

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
      textarea?.removeEventListener('paste', onPaste)
      container.removeEventListener('dragover', onDragOver)
      container.removeEventListener('drop', onDrop)
      dataDisposable.dispose()
      socket.close()
      term.dispose()
      termRef.current = null
    }
    // startupCommands is intentionally excluded - it's fixed for the lifetime of a given
    // sessionId (resolved once at tab-creation time, see App.tsx), so re-running this
    // whole effect over a prop-identity change would just tear down and recreate the same
    // live session for no reason. request is likewise stable per tab and read via a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Re-focus when this tab becomes the active one - it stays mounted-but-hidden while
  // inactive (see App.tsx), so nothing else would move focus back into it on tab switch.
  useEffect(() => {
    if (isActive) {
      termRef.current?.focus()
    }
  }, [isActive])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {uploadStatus && (
        <p
          className={`shrink-0 border-b border-slate-800 px-3 py-1.5 text-sm ${uploadStatus.error ? 'bg-red-950/60 text-red-300' : 'bg-slate-900 text-slate-300'}`}
        >
          {uploadStatus.message}
        </p>
      )}
      {/* overflow-hidden so this container's own box can never be nudged by xterm's rendered
          content (e.g. a fractional cell-size rounding mismatch) - it must stay purely
          parent-driven, since fitAddon.fit() computes rows/cols *from* this element's size. */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden bg-black p-1 sm:p-2" />
    </div>
  )
}
