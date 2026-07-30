import { useEffect, useRef, useState } from 'react'
import { Terminal, type FontWeight } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { resizeTerminal, sshUpload, terminalSocketUrl, type ConnectRequest } from '../lib/api'
import { getAppearance, subscribeAppearance, terminalFontFamily } from '../lib/appearance'
import { KeyboardToolbar } from './KeyboardToolbar'
import { isMobileApp } from '../lib/androidBridge'

interface TerminalViewProps {
  sessionId: string
  isActive: boolean
  onSessionClosed: () => void
  // Fired the first time output arrives while this tab is in the background (inactive), so
  // App.tsx can flag it as having unseen activity (see the favicon tab badge). Fires at most
  // once per background stretch - it re-arms when the tab is next viewed.
  onActivity?: () => void
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
export function TerminalView({ sessionId, isActive, onSessionClosed, onActivity, request, startupCommands }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const onSessionClosedRef = useRef(onSessionClosed)
  // isActive/onActivity read from refs inside the [sessionId]-keyed socket effect below,
  // which captures its closure once; activityNotifiedRef debounces the callback to one fire
  // per background stretch (re-armed when the tab becomes active again).
  const isActiveRef = useRef(isActive)
  const onActivityRef = useRef(onActivity)
  const activityNotifiedRef = useRef(false)
  // Best-effort remote cwd, tracked from OSC 7 (see below) - null until the shell reports
  // one (it never will if it isn't configured to emit OSC 7), which is the signal to fall
  // back to prompting for a destination on upload.
  const remoteCwdRef = useRef<string | null>(null)
  const requestRef = useRef(request)
  const [uploadStatus, setUploadStatus] = useState<{ message: string; error?: boolean } | null>(null)
  const uploadIdRef = useRef(0)
  // Lets KeyboardToolbar (rendered outside the [sessionId] effect below, which owns the
  // actual live WebSocket) push raw bytes into the same connection term.onData writes to -
  // set once the socket exists, reset to a no-op on cleanup so a stale tap after teardown
  // can't throw on a closed socket.
  const sendRawRef = useRef<(data: string) => void>(() => {})
  // Ctrl/Alt are "sticky" one-shot modifiers for the toolbar (mobile keyboards have no
  // physical Ctrl/Alt to hold): tapping arms one, then the *next* single-character keydown
  // - from the real (on-screen or Bluetooth) keyboard - is remapped into the equivalent
  // control code / ESC-prefixed meta byte instead of typing literally, and the modifier
  // disarms itself either way. modifiersRef mirrors the state into the key-event handler
  // closure below (created once per [sessionId], so it reads live values through the ref
  // rather than a stale one captured at effect-run time); the state itself only exists so
  // the toolbar can render which modifier is currently armed. There's no sticky Shift - a
  // real/on-screen keyboard already produces shifted characters on its own, and the one
  // combination it was there for is a literal "Shift+Tab" key in the toolbar now.
  const [modifiers, setModifiers] = useState({ ctrl: false, alt: false })
  const modifiersRef = useRef(modifiers)

  useEffect(() => {
    modifiersRef.current = modifiers
  }, [modifiers])

  function toggleModifier(key: 'ctrl' | 'alt') {
    setModifiers((m) => ({ ...m, [key]: !m[key] }))
    // Same reason sendKey below refocuses: a toolbar button tap otherwise leaves browser
    // focus sitting on the <button> itself, so the very next real keystroke - the one this
    // whole sticky-modifier scheme exists to intercept - would land there instead of on
    // xterm's hidden textarea, and attachCustomKeyEventHandler would never see it at all.
    termRef.current?.focus()
  }

  // Sends a fixed key/escape sequence from a toolbar button tap, then refocuses the
  // terminal - tapping the toolbar otherwise steals focus from xterm's hidden textarea,
  // so the very next real keystroke would be lost instead of reaching the shell.
  function sendKey(data: string) {
    sendRawRef.current(data)
    termRef.current?.focus()
  }

  // Inserts text the way a real paste does (xterm wraps it in bracketed-paste markers when the
  // remote asked for them), so a multi-line snippet lands as one paste instead of a burst of
  // keystrokes the shell would start executing line by line.
  function pasteText(text: string) {
    termRef.current?.paste(text)
    termRef.current?.focus()
  }

  useEffect(() => {
    onSessionClosedRef.current = onSessionClosed
  }, [onSessionClosed])

  useEffect(() => {
    onActivityRef.current = onActivity
  }, [onActivity])

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

    // The terminal font is user-configurable on the Appearance screen. xterm measures glyphs
    // itself and doesn't read CSS, so its metrics come straight from the appearance settings
    // here (initial values) and via subscribeAppearance below (live updates).
    const initialFont = getAppearance().terminalFont
    const term = new Terminal({
      cursorBlink: true,
      fontSize: initialFont.size,
      fontFamily: terminalFontFamily(initialFont),
      fontWeight: initialFont.weight as FontWeight,
      letterSpacing: initialFont.letterSpacing,
      lineHeight: initialFont.lineHeight,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()
    termRef.current = term

    // Fit xterm to its container, then push the resulting size to the backend so the remote
    // PTY (and anything reading COLUMNS/LINES - `systemctl status`, pagers, editors) matches
    // the real window width instead of the 80x24 the initial ConnectRequest hard-codes.
    // Deduped so an observer firing with an unchanged size doesn't spam resize requests.
    let lastCols = 0
    let lastRows = 0
    function fitAndSyncSize() {
      fitAddon.fit()
      if (term.cols === lastCols && term.rows === lastRows) return
      lastCols = term.cols
      lastRows = term.rows
      void resizeTerminal(sessionId, term.cols, term.rows)
    }

    // Live-apply Appearance changes to the terminal font. Char cell size changes with the
    // font, so refit afterwards (which also re-syncs the PTY size to the new col/row count).
    const unsubscribeAppearance = subscribeAppearance((settings) => {
      const font = settings.terminalFont
      term.options.fontFamily = terminalFontFamily(font)
      term.options.fontSize = font.size
      term.options.fontWeight = font.weight as FontWeight
      term.options.letterSpacing = font.letterSpacing
      term.options.lineHeight = font.lineHeight
      fitAndSyncSize()
    })

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

    // Guards against a double paste: while our Ctrl+V handler is reading the clipboard
    // itself, the native `paste` listener (below) must not ALSO process the same clipboard
    // in engines where preventDefault() on the keydown doesn't cancel the native paste.
    let manualPasteActive = false

    // The desktop webview (Photino) doesn't deliver a native `paste` event to xterm's hidden
    // textarea for Ctrl+V, so plain-text paste silently did nothing there. Read the clipboard
    // ourselves and feed it in: a file/image uploads into the cwd (same as the native paste
    // and drag-drop paths), any text is written as terminal input via term.paste().
    async function pasteFromClipboard() {
      try {
        if (navigator.clipboard.read) {
          const items = await navigator.clipboard.read()
          const files: File[] = []
          for (const item of items) {
            const fileType = item.types.find((t) => !t.startsWith('text/'))
            // Empty name lets uploadFileName() synthesize `pasted-<ts>.<ext>` from the type.
            if (fileType) files.push(new File([await item.getType(fileType)], '', { type: fileType }))
          }
          if (files.length > 0) {
            await uploadFiles(files)
            return
          }
          const textItem = items.find((item) => item.types.includes('text/plain'))
          if (textItem) {
            const text = await (await textItem.getType('text/plain')).text()
            if (text) term.paste(text)
          }
          return
        }
      } catch {
        // read() is unavailable or rejected (permissions, or a non-text item some engines
        // won't hand over) - fall back to the text-only path below.
      }
      try {
        const text = await navigator.clipboard.readText()
        if (text) term.paste(text)
      } catch {
        // Clipboard fully unavailable - nothing to paste.
      }
    }

    // Ctrl+C is overloaded in every terminal: with a selection active it should copy
    // (and clear the selection, matching what most terminal emulators do), with nothing
    // selected it's the interrupt signal and must reach the remote process as usual.
    // Ctrl+Shift+C always copies without touching the selection. attachCustomKeyEventHandler
    // runs before xterm's own key handling; returning false suppresses it (so xterm never
    // turns the keydown into onData for the copy cases), returning true lets the keydown
    // fall through to xterm's default handling, which is what actually sends \x03.
    term.attachCustomKeyEventHandler((event) => {
      // Consumes a sticky Ctrl/Alt armed via the mobile keyboard toolbar (see toggleModifier
      // above) against the very next single-character keydown from the real keyboard, one
      // shot either way. Gated on the real event carrying no actual modifier keys itself -
      // a genuine Ctrl/Alt combo from a real (e.g. Bluetooth) keyboard should behave
      // normally and fall through to the checks below untouched.
      const armed = modifiersRef.current
      if (
        event.type === 'keydown' &&
        !event.ctrlKey && !event.altKey && !event.metaKey &&
        event.key.length === 1 &&
        (armed.ctrl || armed.alt)
      ) {
        let bytes: string | null = null
        const code = event.key.toLowerCase().charCodeAt(0)
        if (armed.ctrl && code >= 97 && code <= 122) {
          // The C0 control codes real terminals expect for Ctrl+a..Ctrl+z (0x01-0x1A).
          bytes = String.fromCharCode(code - 96)
          if (armed.alt) bytes = '\x1b' + bytes
        } else if (armed.alt) {
          // The "meta sends escape" convention readline/bash expect (M-x == ESC x).
          bytes = '\x1b' + event.key
        }
        setModifiers({ ctrl: false, alt: false })
        if (bytes !== null) {
          sendRawRef.current(bytes)
          event.preventDefault()
          return false
        }
        return true
      }

      // Ctrl+T is the app's "duplicate this tab" shortcut (issue #51, handled at the
      // window level in App.tsx). Swallow it here so a focused terminal doesn't also send
      // the literal \x14 (DC4) control byte to the remote shell.
      if (event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.code === 'KeyT') {
        return false
      }

      // Ctrl+V (and the traditional Ctrl+Shift+V) pastes the clipboard into the terminal.
      // xterm normally relies on the browser firing a native `paste` event into its
      // textarea, which the desktop webview doesn't do for Ctrl+V - so we read the clipboard
      // ourselves. preventDefault + return false stops xterm's own key handling and any
      // native paste that would fire elsewhere, so it can't double up with pasteFromClipboard.
      if (event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'KeyV') {
        event.preventDefault()
        manualPasteActive = true
        void pasteFromClipboard().finally(() => {
          manualPasteActive = false
        })
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
      // Our Ctrl+V handler above is already reading this same clipboard - suppress the
      // native paste so the text/file isn't applied twice.
      if (manualPasteActive) {
        event.preventDefault()
        return
      }
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
    sendRawRef.current = (data: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(new TextEncoder().encode(data))
      }
    }

    const startupTimeouts: ReturnType<typeof setTimeout>[] = []
    socket.addEventListener('open', () => {
      term.focus()

      // The shell channel is ready now, so correct the PTY from the ConnectRequest's initial
      // 80x24 to the terminal's actual measured size (xterm has laid out by this point).
      fitAndSyncSize()

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
      // Output landed while this tab is in the background - flag it once (until next viewed).
      if (!isActiveRef.current && !activityNotifiedRef.current) {
        activityNotifiedRef.current = true
        onActivityRef.current?.()
      }
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

    // Re-fit and push the new size to the backend PTY when the container changes size.
    //
    // Debounced rather than calling fitAndSyncSize() straight from the observer: a real
    // drag-resize fires roughly one ResizeObserver notification per frame (confirmed by
    // instrumenting it directly - ~30 notifications over half a second of dragging), and
    // fit() calling term.resize() does a full renderer clear-and-redraw every time it
    // actually changes cols/rows. Applying that on every intermediate frame - including
    // whatever transient sizes happen to fall exactly on a column/row boundary as a
    // scrollbar's reserved gutter comes in and out of the width calculation - is what
    // reads as flicker; only the settled size after the resize stops actually matters (and
    // it's that settled size we send the remote, not every intermediate one).
    let resizeTimeout: ReturnType<typeof setTimeout> | undefined
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimeout)
      resizeTimeout = setTimeout(() => fitAndSyncSize(), 75)
    })
    resizeObserver.observe(container)

    return () => {
      disposed = true
      unsubscribeAppearance()
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
      sendRawRef.current = () => {}
    }
    // startupCommands is intentionally excluded - it's fixed for the lifetime of a given
    // sessionId (resolved once at tab-creation time, see App.tsx), so re-running this
    // whole effect over a prop-identity change would just tear down and recreate the same
    // live session for no reason. request is likewise stable per tab and read via a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Re-focus when this tab becomes the active one - it stays mounted-but-hidden while
  // inactive (see App.tsx), so nothing else would move focus back into it on tab switch.
  // Viewing the tab also re-arms the background-activity notifier (its output is now seen).
  useEffect(() => {
    isActiveRef.current = isActive
    if (isActive) {
      activityNotifiedRef.current = false
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
          parent-driven, since fitAddon.fit() computes rows/cols *from* this element's size.
          On mobile we need overflow-y-auto to allow scrolling when keyboard is open. */}
      <div ref={containerRef} className="min-h-0 flex-1 bg-black p-1 sm:p-2 overflow-y-auto sm:overflow-hidden" />
      {/* Keyboard toolbar for Android/mobile - special keys mobile keyboards don't expose.
          Every button is wired to sendKey/toggleModifier above, which push bytes into the
          same live WebSocket term.onData writes to - not into termRef, which has no such
          capability (xterm's Terminal has no public "inject a keystroke" API). */}
      {isMobileApp() && (
        <KeyboardToolbar
          ctrlArmed={modifiers.ctrl}
          altArmed={modifiers.alt}
          onToggleCtrl={() => toggleModifier('ctrl')}
          onToggleAlt={() => toggleModifier('alt')}
          onSendKey={sendKey}
          onPasteText={pasteText}
        />
      )}
    </div>
  )
}
