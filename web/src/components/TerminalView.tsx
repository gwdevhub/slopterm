import { useEffect, useRef, useState } from 'react'
import { Terminal, type FontWeight } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { resizeTerminal, sshSessionState, sshUpload, terminalSocketUrl, type ConnectRequest } from '../lib/api'
import { getAppearance, subscribeAppearance, terminalFontFamily } from '../lib/appearance'
import { KeyboardToolbar } from './KeyboardToolbar'
import { finishAndroidComposing, isAndroidApp, isMobileApp, registerCompositionBridge } from '../lib/androidBridge'
import { registerTerminalTouch, type TouchSelection } from '../lib/terminalTouch'
import { openExternalInNativeApp } from '../lib/externalLinks'
import { isDesktopApp } from '../lib/photino'

interface TerminalViewProps {
  sessionId: string
  isActive: boolean
  onSessionClosed: () => void
  // The session this view was attached to is gone from the backend but the tab should live on
  // and reconnect. Distinct from onSessionClosed, which means the shell itself ended.
  onSessionLost: () => void
  // Fired the first time output arrives while this tab is in the background, at most once per
  // background stretch (re-armed when the tab is next viewed).
  onActivity?: () => void
  // The tab's own connect info; paste/drag-to-upload opens a one-shot SFTP connection from it.
  // Undefined for a local tab, where dropping a file is just a paste.
  request?: ConnectRequest
  // Sent to the shell right after the socket opens; only meaningful the first time a given
  // session id is seen, same as everything else keyed on [sessionId] below.
  startupCommands?: string[]
}

// Turns a dropped/pasted Blob into a remote file name: a real file's own name, or a
// timestamped one for a pasted image (which has no meaningful name of its own).
function uploadFileName(item: File): string {
  if (item.name) return item.name
  const ext = item.type.split('/')[1] || 'bin'
  return `pasted-${Date.now()}.${ext}`
}

// Applies the toolbar's armed Ctrl/Alt to one character (C0 control code / meta-escape);
// a combination with no terminal meaning is left as the plain character.
function applyStickyModifiers(char: string, armed: { ctrl: boolean; alt: boolean }): string {
  let bytes = char
  if (armed.ctrl) {
    const code = char.toLowerCase().charCodeAt(0)
    if (code >= 97 && code <= 122) bytes = String.fromCharCode(code - 96)
    else if (char === ' ') bytes = '\x00'
  }
  return armed.alt ? `\x1b${bytes}` : bytes
}

// Renders only the terminal; the tab strip (App.tsx/TabBar.tsx) owns the session label and
// close/disconnect action now that multiple sessions can be open at once (issue #9).
export function TerminalView({ sessionId, isActive, onSessionClosed, onSessionLost, onActivity, request, startupCommands }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const onSessionClosedRef = useRef(onSessionClosed)
  const onSessionLostRef = useRef(onSessionLost)
  // The live socket, owned by its own effect below: the terminal outlives any individual
  // connection to it, so writers go through this ref instead of closing over one socket.
  const socketRef = useRef<WebSocket | null>(null)
  // How many bytes of this session's output we've rendered. Sent as `?since=` on reattach so
  // the backend replays exactly the gap, and updated from the attach header + every frame.
  const offsetRef = useRef<number | undefined>(undefined)
  const startupCommandsRef = useRef(startupCommands)
  // fitAndSyncSize lives in the terminal effect but has to run when a socket opens.
  const fitAndSyncRef = useRef<() => void>(() => {})
  const [reconnecting, setReconnecting] = useState(false)
  // Another window took this session over - see the 'session-superseded' close reason.
  const [superseded, setSuperseded] = useState(false)
  // isActive/onActivity read from refs inside the [sessionId]-keyed socket effect below;
  // activityNotifiedRef debounces the callback to one fire per background stretch.
  const isActiveRef = useRef(isActive)
  const onActivityRef = useRef(onActivity)
  const activityNotifiedRef = useRef(false)
  // Best-effort remote cwd, tracked from OSC 7 (see below) - null until the shell reports one,
  // which is the signal to prompt for a destination on upload.
  const remoteCwdRef = useRef<string | null>(null)
  const requestRef = useRef(request)
  const [uploadStatus, setUploadStatus] = useState<{ message: string; error?: boolean } | null>(null)
  const uploadIdRef = useRef(0)
  // The floating "Copy" bubble over a touch selection, positioned by the gesture handler;
  // null when nothing is selected. A phone has no Ctrl+C and no right-click.
  const [touchSelection, setTouchSelection] = useState<TouchSelection | null>(null)
  // Lets KeyboardToolbar push raw bytes into the same connection term.onData writes to - set
  // once the socket exists, reset to a no-op on cleanup so a stale tap can't throw.
  const sendRawRef = useRef<(data: string) => void>(() => {})
  // Drags one end of the touch selection. Same cross-effect-ref pattern as sendRawRef.
  const moveSelectionHandleRef = useRef<(which: 'start' | 'end', clientX: number, clientY: number) => void>(() => {})
  // Clears the frozen composition preview (see the terminal effect below) once real output has
  // been drawn - same cross-effect-ref pattern as sendRawRef.
  const unfreezeCompositionRef = useRef<() => void>(() => {})
  // Ctrl/Alt are "sticky" one-shot modifiers for the toolbar; applied in term.onData rather
  // than keydown (Android soft keyboards report keyCode=229 and the real char arrives as IME).
  const [modifiers, setModifiers] = useState({ ctrl: false, alt: false })
  const modifiersRef = useRef(modifiers)

  function toggleModifier(key: 'ctrl' | 'alt') {
    // Ref updated synchronously (not via effect) because a deferred effect could let a keystroke
    // read an un-armed ref; state only drives the toolbar styling.
    const next = { ...modifiersRef.current, [key]: !modifiersRef.current[key] }
    modifiersRef.current = next
    setModifiers(next)
    refocusTerminal()
  }

  // Puts focus back on xterm's hidden textarea, but only when it isn't already there - a
  // redundant focus() makes Android restart the keyboard's input connection (a visible lag).
  function refocusTerminal() {
    const term = termRef.current
    if (!term) return
    const textarea = term.element?.querySelector('textarea')
    if (textarea && document.activeElement === textarea) return
    term.focus()
  }

  function sendKey(data: string) {
    sendRawRef.current(data)
    refocusTerminal()
  }

  // Inserts text the way a real paste does (xterm wraps it in bracketed-paste markers when the
  // remote asked), so a multi-line snippet lands as one paste instead of a burst of keystrokes.
  function pasteText(text: string) {
    termRef.current?.paste(text)
    refocusTerminal()
  }

  // Copy the touch selection, drop it, and hand focus back to the terminal. Driven from
  // pointerdown with default cancelled so the press never moves focus off xterm's textarea.
  function copyTouchSelection() {
    const text = touchSelection?.text
    if (text) void navigator.clipboard.writeText(text)
    termRef.current?.clearSelection()
    setTouchSelection(null)
    refocusTerminal()
  }

  useEffect(() => {
    onSessionClosedRef.current = onSessionClosed
  }, [onSessionClosed])

  useEffect(() => {
    onSessionLostRef.current = onSessionLost
  }, [onSessionLost])

  useEffect(() => {
    startupCommandsRef.current = startupCommands
  }, [startupCommands])

  useEffect(() => {
    onActivityRef.current = onActivity
  }, [onActivity])

  useEffect(() => {
    requestRef.current = request
  }, [request])

  // Uploads dropped/pasted files into the shell's current directory (tracked via OSC 7), or a
  // prompted-for directory when that's unknown. Deliberately does NOT feed the bytes to the shell.
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return

    // A local shell already has the file - there is nowhere to send it.
    const uploadRequest = requestRef.current
    if (!uploadRequest) {
      setUploadStatus({ message: 'This shell is on this machine - the file is already here.' })
      setTimeout(() => setUploadStatus(null), 4000)
      return
    }

    let remoteDir = remoteCwdRef.current
    if (!remoteDir) {
      // No OSC 7 shell integration - ask rather than guess.
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
        const { remotePath } = await sshUpload(uploadRequest, remoteDir, name, file)
        if (uploadIdRef.current === thisUploadId) {
          setUploadStatus({ message: `Uploaded to ${remotePath}` })
        }
      } catch (err) {
        setUploadStatus({ message: err instanceof Error ? err.message : 'Upload failed', error: true })
        return
      }
    }

    setTimeout(() => {
      if (uploadIdRef.current === thisUploadId) setUploadStatus(null)
    }, 4000)
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // xterm measures glyphs itself and doesn't read CSS, so font metrics come from the
    // appearance settings here (initial values) and via subscribeAppearance below (updates).
    const initialFont = getAppearance().terminalFont
    const term = new Terminal({
      cursorBlink: true,
      fontSize: initialFont.size,
      fontFamily: terminalFontFamily(initialFont),
      fontWeight: initialFont.weight as FontWeight,
      letterSpacing: initialFont.letterSpacing,
      lineHeight: initialFont.lineHeight,
      ...(isDesktopApp || isAndroidApp()
        ? {
            linkHandler: {
              activate: (_event: MouseEvent, url: string) => openExternalInNativeApp(url),
            },
          }
        : {}),
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    fitAddon.fit()
    termRef.current = term

    // Fit xterm to its container and push the size to the backend so the remote PTY matches the
    // real window (not the 80x24 ConnectRequest hard-codes); deduped to avoid resize spam.
    let lastCols = 0
    let lastRows = 0
    function fitAndSyncSize() {
      // Skip while hidden: an inactive tab is display:none and measures 0x0, and FitAddon floors
      // its proposal, so fitting would resize the background PTY to a sliver on every switch.
      const box = containerRef.current
      if (!box || box.clientWidth === 0 || box.clientHeight === 0) return
      fitAddon.fit()
      if (term.cols === lastCols && term.rows === lastRows) return
      lastCols = term.cols
      lastRows = term.rows
      void resizeTerminal(sessionId, term.cols, term.rows)
    }
    // Also called from the socket effect on every (re)attach - a reattached PTY has to be
    // told the size again, and the size may well have changed while we were away.
    fitAndSyncRef.current = fitAndSyncSize

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

    // OSC 7 (the de-facto shell-integration escape reporting cwd) lets paste/drag uploads
    // target the shell's actual cwd instead of guessing. Best-effort; payload is file://<host>/<path>.
    term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data)
        if (url.pathname) remoteCwdRef.current = decodeURIComponent(url.pathname)
      } catch {
        // Not a file:// URL we understand - leave the last known cwd in place.
      }
      return true
    })

    // Guards against a double paste: while our Ctrl+V handler reads the clipboard itself, the
    // native `paste` listener (below) must not also process it.
    let manualPasteActive = false

    // Photino's webview doesn't deliver a native `paste` event for Ctrl+V, so read the clipboard
    // ourselves: a file/image uploads (like the native paste/drag paths), text goes to term.paste().
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
        // read() unavailable or rejected - fall back to the text-only path below.
      }
      try {
        const text = await navigator.clipboard.readText()
        if (text) term.paste(text)
      } catch {
        // Clipboard fully unavailable - nothing to paste.
      }
    }

    // Ctrl+C copies when a selection is active (clearing it), else sends \x03; Ctrl+Shift+C
    // always copies. attachCustomKeyEventHandler returning false suppresses xterm's own handling.
    term.attachCustomKeyEventHandler((event) => {
      // Ctrl+T duplicates the tab (handled window-level in App.tsx); swallow it here so a
      // focused terminal doesn't also send the literal \x14 (DC4) to the remote shell.
      if (event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.code === 'KeyT') {
        return false
      }

      // Ctrl+V (and Ctrl+Shift+V) paste the clipboard; the desktop webview doesn't fire the
      // native `paste` xterm relies on, so read it ourselves. preventDefault + return false
      // stops xterm's own handling and any native paste doubling up with pasteFromClipboard.
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

    // Paste of a non-text item (e.g. a screenshot) uploads it as a file into the shell's cwd
    // rather than feeding it as terminal input; plain text is left entirely to xterm.
    const onPaste = (event: ClipboardEvent) => {
      // Our Ctrl+V handler above is already reading this same clipboard - suppress the
      // native paste so the text/file isn't applied twice.
      if (manualPasteActive) {
        event.preventDefault()
        return
      }
      const files = event.clipboardData ? Array.from(event.clipboardData.files) : []
      if (files.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      void uploadFiles(files)
    }
    const textarea = container.querySelector('textarea')
    textarea?.addEventListener('paste', onPaste)

    // Lets the Android keyboard toolbar commit an in-progress IME composition before its own
    // bytes go out, without racing xterm's handling of the same commit. No-op off Android.
    const disposeCompositionBridge = textarea ? registerCompositionBridge(textarea) : undefined

    // xterm hides its composition preview on compositionend but defers sending the committed
    // text, so the just-typed word flickers until the echo returns. Copy the positioned
    // .composition-view into our own overlay to bridge it (xterm keeps mutating its element).
    const compositionView = container.querySelector<HTMLElement>('.composition-view')
    const echoPreview = document.createElement('div')
    // Same class (identical geometry/styling) plus a marker the e2e tests key off.
    echoPreview.classList.add('composition-view', 'composition-echo')
    compositionView?.parentElement?.appendChild(echoPreview)
    let compositionFreezeTimeout: ReturnType<typeof setTimeout> | undefined
    // Mirrors CompositionHelper's own _isComposing, because both compositionend and the
    // keydown case below finalize a composition and xterm's state is private.
    const isComposingRef = { current: false }
    // True only for the tick an IME commit's text is handed to onData, so the sticky modifier
    // there can tell a committed word from a paste or escape sequence.
    let compositionCommitPending = false
    function unfreezeComposition() {
      clearTimeout(compositionFreezeTimeout)
      compositionFreezeTimeout = undefined
      echoPreview.classList.remove('active')
    }
    unfreezeCompositionRef.current = unfreezeComposition
    // Snapshots the word xterm is about to stop previewing, at xterm's computed position, and
    // arms a backstop that drops it if real output never supersedes it.
    function freezeComposition() {
      if (!compositionView?.textContent) return
      echoPreview.style.cssText = compositionView.style.cssText
      echoPreview.textContent = compositionView.textContent
      echoPreview.classList.add('active')
      // Backstop for a shell that never echoes: don't leave stale composed text on screen.
      compositionFreezeTimeout = setTimeout(unfreezeComposition, 1000)
    }
    // Marks the terminal as composing while the IME holds a word (CSS moves the caret onto the
    // preview). Not derived from xterm's private state, and the keydown path below finalizes a
    // composition without a compositionend event to observe.
    const composingRoot: HTMLDivElement = container
    const setComposing = (active: boolean) => composingRoot.classList.toggle('xterm-composing', active)

    const onCompositionEnd = () => {
      isComposingRef.current = false
      setComposing(false)
      // A committed control code isn't echoed back as the letter it was composed from, so
      // freezing the preview would leave a phantom letter for the backstop second.
      compositionCommitPending = true
      setTimeout(() => {
        compositionCommitPending = false
      }, 0)
      if (modifiersRef.current.ctrl || modifiersRef.current.alt) return
      // xterm's own listener (registered first) has already hidden its preview; snapshotting
      // here, synchronously after, keeps the word on screen.
      freezeComposition()
    }
    const onCompositionStart = () => {
      isComposingRef.current = true
      setComposing(true)
    }
    // A new previewed word lands on the frozen one (the echo hasn't moved the cursor yet), so
    // drop the snapshot on update, not start, or typing ahead would blank the previous word.
    const onCompositionUpdate = () => {
      unfreezeComposition()
      // A composing IME hands nothing to onData until the word is finished, so an armed
      // Ctrl can't apply to its first character (the "Ctrl+O in nano types a literal o" bug).
      // Commit the composition the moment the IME starts holding text, only while armed, so
      // normal typing keeps its local preview.
      if (modifiersRef.current.ctrl || modifiersRef.current.alt) void finishAndroidComposing()
    }
    // Pressing Enter mid-word makes CompositionHelper.keydown finalize the composition
    // synchronously, with no compositionend event - space stopped flickering (PR #103) but
    // Enter didn't. Registered capture:true on the same textarea because xterm's own capture
    // keydown listener calls stopPropagation(), so a bubble listener would never fire. The
    // keyCode exclusions match CompositionHelper's own "still composing" cases.
    const onKeyDownDuringComposition = (event: KeyboardEvent) => {
      if (!isComposingRef.current) return
      if ([16, 17, 18, 20, 229].includes(event.keyCode)) return
      isComposingRef.current = false
      setComposing(false)
      freezeComposition()
    }
    textarea?.addEventListener('compositionend', onCompositionEnd)
    textarea?.addEventListener('compositionstart', onCompositionStart)
    textarea?.addEventListener('compositionupdate', onCompositionUpdate)
    textarea?.addEventListener('keydown', onKeyDownDuringComposition, true)

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

    // All touchscreen gestures (drag-scroll, long-press-select, double-tap Tab) live in one
    // handler since they share a touchstart. Built on touch events, not synthesized mouse
    // events, so a desktop mouse keeps its usual xterm selection and wheel.
    const touch = registerTerminalTouch(term, container, {
      onDoubleTap: () => {
        // Commit the IME first (same as the toolbar's Tab key): the word being completed is
        // still in the composing region, so a bare \t would complete against an empty word.
        // Resolves synchronously off Android and when nothing is composing.
        void finishAndroidComposing().then(() => {
          sendRawRef.current('\t')
          term.focus()
        })
      },
      onSelectionChange: setTouchSelection,
      onSendKey: (data) => sendRawRef.current(data),
    })
    moveSelectionHandleRef.current = touch.moveHandle

    sendRawRef.current = (data: string) => {
      const socket = socketRef.current
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(new TextEncoder().encode(data))
      }
    }

    const dataDisposable = term.onData((data) => {
      let payload = data
      // One shot: a sticky modifier applies to the next single character (physical or IME
      // commit) then disarms; a paste or arrow-key escape sequence passes through.
      const armed = modifiersRef.current
      if (armed.ctrl || armed.alt) {
        // A committed word arriving whole is the fallback path (off Android there's no bridge
        // to end the composition early); apply the modifier to the first character and let the
        // rest land as typed. Array.from so a surrogate pair stays one character.
        const characters = data.length === 1 || compositionCommitPending ? Array.from(data) : []
        if (characters.length > 0) {
          payload = applyStickyModifiers(characters[0], armed) + characters.slice(1).join('')
          // Write the ref directly too: two characters in the same tick would otherwise both
          // see the armed value, since the ref only catches up on the next render.
          modifiersRef.current = { ctrl: false, alt: false }
          setModifiers({ ctrl: false, alt: false })
        }
      }
      sendRawRef.current(payload)
    })

    // Debounced refit/resize on container size change: a drag-resize fires ~one ResizeObserver
    // notification per frame and fit() does a full clear-and-redraw each time cols/rows change,
    // so applying every intermediate frame reads as flicker. Only the settled size matters.
    let resizeTimeout: ReturnType<typeof setTimeout> | undefined
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimeout)
      resizeTimeout = setTimeout(() => fitAndSyncSize(), 75)
    })
    resizeObserver.observe(container)

    return () => {
      unsubscribeAppearance()
      clearTimeout(resizeTimeout)
      clearTimeout(compositionFreezeTimeout)
      resizeObserver.disconnect()
      textarea?.removeEventListener('paste', onPaste)
      textarea?.removeEventListener('compositionend', onCompositionEnd)
      textarea?.removeEventListener('compositionstart', onCompositionStart)
      textarea?.removeEventListener('compositionupdate', onCompositionUpdate)
      textarea?.removeEventListener('keydown', onKeyDownDuringComposition, true)
      echoPreview.remove()
      disposeCompositionBridge?.()
      container.removeEventListener('dragover', onDragOver)
      container.removeEventListener('drop', onDrop)
      touch.dispose()
      moveSelectionHandleRef.current = () => {}
      setTouchSelection(null)
      dataDisposable.dispose()
      term.dispose()
      termRef.current = null
      sendRawRef.current = () => {}
      fitAndSyncRef.current = () => {}
      unfreezeCompositionRef.current = () => {}
    }
    // startupCommands is intentionally excluded (fixed per sessionId); request is stable per
    // tab and read via a ref. Re-running would tear down and recreate the same live session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // The socket effect is separate from the terminal: the shell outlives any one WebSocket, so
  // losing the socket (e.g. Android backgrounding the WebView) is treated as "reattach" rather
  // than throwing the terminal away. Only an explicit server close reason ends the session.
  useEffect(() => {
    // A tab keeps this component across a reconnect (keyed by tab id), so a new session id
    // starts from a clean slate with nothing rendered yet.
    offsetRef.current = undefined

    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryDelay = 500
    const startupTimeouts: ReturnType<typeof setTimeout>[] = []
    // The socket this effect considers live. Handlers check their socket against it so a race
    // between a retry timer, visibilitychange and an in-flight state probe can't stack sockets.
    let current: WebSocket | null = null

    function connect() {
      if (disposed) return
      clearTimeout(retryTimer)
      retryTimer = undefined

      const socket = new WebSocket(terminalSocketUrl(sessionId, offsetRef.current))
      socket.binaryType = 'arraybuffer'
      current = socket
      socketRef.current = socket

      socket.addEventListener('open', () => {
        if (disposed || current !== socket) return
        retryDelay = 500
        setReconnecting(false)
        setSuperseded(false)
        termRef.current?.focus()

        // The shell channel is ready, so correct the PTY from the initial 80x24 to xterm's
        // actual measured size (laid out by this point) - and on reattach, to the current size.
        fitAndSyncRef.current()
      })

      socket.addEventListener('message', (event) => {
        if (current !== socket) return
        // A text frame is the attach header (TerminalSession.AttachAsync) giving the output
        // offset the following bytes begin at; the backend re-sends it mid-stream on a `gap`.
        if (typeof event.data === 'string') {
          try {
            const header = JSON.parse(event.data) as { type?: string; offset?: number; gap?: boolean; fresh?: boolean }
            if (header.type === 'attach' && typeof header.offset === 'number') {
              offsetRef.current = header.offset
              // What follows doesn't join onto what's on screen. Start clean rather than
              // splice a hole.
              if (header.gap) termRef.current?.reset()
              // The backend decides via `fresh` whether startup snippets still need running
              // (only it knows if the session ever had a client); retyping them would be bad.
              if (header.fresh) sendStartupCommands()
            }
          } catch {
            // Not a header we understand - ignore it rather than feed JSON to the terminal.
          }
          return
        }

        const bytes = new Uint8Array(event.data as ArrayBuffer)
        offsetRef.current = (offsetRef.current ?? 0) + bytes.byteLength
        // Real output arrived, so clear the frozen composition preview - but via write()'s
        // completion callback, since write() is async and clearing up front would let the
        // browser paint the row with the preview gone and the echo not yet drawn.
        const clearFrozenComposition = unfreezeCompositionRef.current
        termRef.current?.write(bytes, clearFrozenComposition)
        // Output landed while this tab is in the background - flag it once (until next viewed).
        if (!isActiveRef.current && !activityNotifiedRef.current) {
          activityNotifiedRef.current = true
          onActivityRef.current?.()
        }
      })

      socket.addEventListener('close', (event) => {
        // Cleanup also closes the socket when React intentionally unmounts this view, and a
        // socket that has already been superseded has nothing left to say.
        if (disposed || current !== socket) return
        current = null
        socketRef.current = null

        if (event.reason === 'session-ended') {
          // The shell itself ended (`exit`) - the tab is done. Stop this effect's machinery
          // first so a visibilitychange can't reconnect and fire the callback twice.
          disposed = true
          clearTimeout(retryTimer)
          onSessionClosedRef.current()
          return
        }

        if (event.reason === 'session-lost') {
          // The SSH connection to the host died (handover, host reboot). Keep the tab and redial.
          disposed = true
          clearTimeout(retryTimer)
          onSessionLostRef.current()
          return
        }

        if (event.reason === 'session-superseded') {
          // Another window took this session over; reconnecting would evict it and the two
          // would trade the session forever, so stop and say so instead.
          setSuperseded(true)
          setReconnecting(false)
          return
        }

        setReconnecting(true)
        // Any other close (rejected upgrade, dead network) tells us nothing on its own, so ask.
        void sshSessionState(sessionId).then((state) => {
          // Something already reconnected while the probe was in flight - leave that socket alone.
          if (disposed || current !== null) return
          if (state === 'ended') {
            // The shell finished while we were away. Close the tab, rather than quietly
            // opening a whole new authenticated session the user never asked for.
            disposed = true
            onSessionClosedRef.current()
            return
          }
          if (state === 'unknown') {
            disposed = true
            onSessionLostRef.current()
            return
          }
          retryTimer = setTimeout(connect, retryDelay)
          // Backs off to half a minute so every open tab isn't polling a gone backend; coming
          // back to the app resets it to an immediate retry.
          retryDelay = Math.min(retryDelay * 2, 30_000)
        })
      })
    }

    // Sends the host's startup snippets. Called only from the attach header's `fresh` flag,
    // which is the backend saying this socket is the session's first ever client.
    function sendStartupCommands() {
      // A delay before the first lets the shell's banner/prompt print; spacing the rest keeps
      // each command from racing a slow prompt on the previous line.
      let delay = 300
      for (const command of startupCommandsRef.current ?? []) {
        const text = command.endsWith('\n') || command.endsWith('\r') ? command : `${command}\r`
        startupTimeouts.push(setTimeout(() => sendRawRef.current(text), delay))
        delay += 300
      }
    }

    connect()

    // Retry on thaw/visible rather than waiting on a backoff timer: a backgrounded page has
    // timers throttled to ~one a minute and a frozen one has them stopped, so the timer alone
    // would leave a dead terminal for up to a minute after switching back.
    // Still runs when superseded: the automatic backoff is what causes two-window ping-pong,
    // and reclaiming on a visible window settles rather than oscillates.
    function reconnectNow() {
      if (disposed || document.visibilityState !== 'visible') return
      if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) return
      retryDelay = 500
      connect()
    }
    document.addEventListener('visibilitychange', reconnectNow)
    window.addEventListener('pageshow', reconnectNow)
    window.addEventListener('online', reconnectNow)

    return () => {
      disposed = true
      clearTimeout(retryTimer)
      startupTimeouts.forEach(clearTimeout)
      document.removeEventListener('visibilitychange', reconnectNow)
      window.removeEventListener('pageshow', reconnectNow)
      window.removeEventListener('online', reconnectNow)
      const socket = current
      current = null
      socketRef.current = null
      socket?.close()
    }
  }, [sessionId])

  // Re-focus on becoming active (inactive tabs stay mounted-but-hidden), and re-arm the
  // background-activity notifier since the output is now seen.
  useEffect(() => {
    isActiveRef.current = isActive
    if (isActive) {
      activityNotifiedRef.current = false
      termRef.current?.focus()
    }
  }, [isActive])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Deliberately a thin strip rather than an overlay: the session is still there and its
          last screen is still accurate, so it stays readable while we get the socket back. */}
      {superseded ? (
        <p className="shrink-0 border-b border-amber-900/60 bg-amber-950/60 px-3 py-1.5 text-sm text-amber-200">
          This session was taken over by another slopterm window.
        </p>
      ) : (
        reconnecting && (
          <p className="shrink-0 border-b border-amber-900/60 bg-amber-950/60 px-3 py-1.5 text-sm text-amber-200">
            Reconnecting to this session…
          </p>
        )
      )}
      {uploadStatus && (
        <p
          className={`shrink-0 border-b border-slate-800 px-3 py-1.5 text-sm ${uploadStatus.error ? 'bg-red-950/60 text-red-300' : 'bg-slate-900 text-slate-300'}`}
        >
          {uploadStatus.message}
        </p>
      )}
      {/* The wrapper only exists to position the touch selection's Copy bubble against the
          terminal without putting a React-managed child inside the element xterm.js owns. */}
      <div className="relative min-h-0 flex-1">
        {/* overflow-hidden so xterm's rendered content can't nudge this box - fitAddon.fit()
            derives rows/cols from its size; mobile uses overflow-y-auto for keyboard scrolling. */}
        {/* touch-none on a touchscreen: all gestures are ours (see terminalTouch.ts), so the
            browser must not pan first; touch-manipulation elsewhere buys double-tap-to-zoom-free
            taps without the 300ms wait. */}
        <div
          ref={containerRef}
          className={`h-full w-full bg-black p-1 sm:p-2 overflow-y-auto sm:overflow-hidden ${
            isMobileApp() ? 'touch-none' : 'touch-manipulation'
          }`}
        />
        {touchSelection &&
          (['start', 'end'] as const).map((which) => {
            const handle = which === 'start' ? touchSelection.startHandle : touchSelection.endHandle
            if (!handle.visible) return null
            return (
              <div
                key={which}
                // Decorative to a screen reader (there's nothing to announce about a drag
                // target for a touch selection), and the hook the e2e touch spec aims at.
                aria-hidden="true"
                data-selection-handle={which}
                onTouchStart={(event) => event.preventDefault()}
                onTouchMove={(event) => {
                  // Cancelled so this drag can't also pan the page or hand the terminal's own
                  // gesture handler a second, contradictory idea of what the finger is doing.
                  event.preventDefault()
                  const touch = event.touches[0]
                  if (touch) moveSelectionHandleRef.current(which, touch.clientX, touch.clientY)
                }}
                style={{
                  left: `${handle.left}px`,
                  top: `${handle.top}px`,
                  // Centred on the cell edge it controls and hanging below the row, so it marks
                  // the boundary without covering its text; the rounding shows which end it is.
                  transform: 'translate(-50%, 0)',
                }}
                // Larger than it looks (the visible dot is the inner span): a 10px target is
                // unusable with a fingertip.
                className="absolute z-10 flex h-9 w-9 touch-none items-start justify-center"
              >
                <span
                  className={`mt-0.5 block h-3.5 w-3.5 bg-indigo-400 shadow ${
                    which === 'start' ? 'rounded-b-full rounded-tl-full' : 'rounded-b-full rounded-tr-full'
                  }`}
                />
              </div>
            )
          })}
        {touchSelection && (
          <button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault()
              copyTouchSelection()
            }}
            onMouseDown={(event) => event.preventDefault()}
            style={{
              left: `${touchSelection.left}px`,
              top: `${touchSelection.top}px`,
              transform:
                touchSelection.placement === 'above'
                  ? 'translate(-50%, calc(-100% - 6px))'
                  : 'translate(-50%, 6px)',
            }}
            className="absolute z-10 rounded bg-slate-700 px-3 py-1.5 text-xs font-medium text-white shadow-lg active:bg-slate-600"
          >
            Copy
          </button>
        )}
      </div>
      {/* Keyboard toolbar for Android/mobile: buttons push bytes into the live WebSocket via
          sendKey/toggleModifier, since xterm has no public "inject a keystroke" API. */}
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
