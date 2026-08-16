import { useEffect, useRef, useState } from 'react'
import { Terminal, type FontWeight } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { resizeTerminal, sshSessionState, sshUpload, terminalSocketUrl, type ConnectRequest } from '../lib/api'
import { getAppearance, subscribeAppearance, terminalFontFamily } from '../lib/appearance'
import { KeyboardToolbar } from './KeyboardToolbar'
import { finishAndroidComposing, isMobileApp, registerCompositionBridge } from '../lib/androidBridge'
import { registerTerminalTouch, type TouchSelection } from '../lib/terminalTouch'

interface TerminalViewProps {
  sessionId: string
  isActive: boolean
  onSessionClosed: () => void
  // The session this view was attached to is gone from the backend (it aged out of its
  // detached grace period, or was disconnected elsewhere) but the tab itself should live on
  // and get a fresh connection. Distinct from onSessionClosed, which means the *shell*
  // ended - `exit` - and the tab is genuinely finished.
  onSessionLost: () => void
  // Fired the first time output arrives while this tab is in the background (inactive), so
  // App.tsx can flag it as having unseen activity (see the favicon tab badge). Fires at most
  // once per background stretch - it re-arms when the tab is next viewed.
  onActivity?: () => void
  // The tab's own connect info - an SSH tab holds only an interactive shell server-side,
  // not an SFTP channel, so paste/drag-to-upload (below) opens a fresh one-shot SFTP
  // connection from this same request rather than reusing the shell. Undefined for a local
  // tab, where there is no remote side to upload to and dropping a file is just a paste.
  request?: ConnectRequest
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

// Applies the toolbar's armed Ctrl/Alt to a single character: Ctrl+a..z are the C0 control
// codes real terminals expect (0x01-0x1A), Ctrl+Space is NUL, and Alt is the "meta sends
// escape" convention readline/bash want (M-x == ESC x), including on top of a control code for
// Ctrl+Alt. A combination with no terminal meaning (Ctrl+7, say) is left as the plain
// character rather than invented.
function applyStickyModifiers(char: string, armed: { ctrl: boolean; alt: boolean }): string {
  let bytes = char
  if (armed.ctrl) {
    const code = char.toLowerCase().charCodeAt(0)
    if (code >= 97 && code <= 122) bytes = String.fromCharCode(code - 96)
    else if (char === ' ') bytes = '\x00'
  }
  return armed.alt ? `\x1b${bytes}` : bytes
}

// Renders only the terminal itself - the tab strip (App.tsx/TabBar.tsx) owns the
// session label and close/disconnect action now that multiple sessions can be open at
// once (issue #9), so a second "Session xxx / Disconnect" header here would be redundant.
export function TerminalView({ sessionId, isActive, onSessionClosed, onSessionLost, onActivity, request, startupCommands }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const onSessionClosedRef = useRef(onSessionClosed)
  const onSessionLostRef = useRef(onSessionLost)
  // The live socket, owned by its own effect below rather than by the terminal's - the
  // terminal outlives any individual connection to it now, so everything that writes to the
  // backend goes through this ref instead of closing over one particular socket.
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
  // The floating "Copy" bubble over a touch selection, positioned by the gesture handler (see
  // terminalTouch.ts) and null whenever there's nothing selected. A phone has no Ctrl+C and no
  // right-click, so this is the only way selected text gets to the clipboard there.
  const [touchSelection, setTouchSelection] = useState<TouchSelection | null>(null)
  // Lets KeyboardToolbar (rendered outside the [sessionId] effect below, which owns the
  // actual live WebSocket) push raw bytes into the same connection term.onData writes to -
  // set once the socket exists, reset to a no-op on cleanup so a stale tap after teardown
  // can't throw on a closed socket.
  const sendRawRef = useRef<(data: string) => void>(() => {})
  // Drags one end of the touch selection (see terminalTouch.ts). Same cross-effect-ref pattern
  // as sendRawRef: the handles are rendered down in the JSX, the gesture state they move lives
  // in the [sessionId] effect.
  const moveSelectionHandleRef = useRef<(which: 'start' | 'end', clientX: number, clientY: number) => void>(() => {})
  // Clears the frozen composition preview (see the .composition-echo handling in the terminal
  // effect below) once real output has actually been drawn - set from that effect, called from
  // the socket effect's message handler, same cross-effect-ref pattern as sendRawRef.
  const unfreezeCompositionRef = useRef<() => void>(() => {})
  // Ctrl/Alt are "sticky" one-shot modifiers for the toolbar (mobile keyboards have no
  // physical Ctrl/Alt to hold): tapping arms one, then the *next* single character the
  // terminal produces is remapped into the equivalent control code / ESC-prefixed meta byte
  // instead of being typed literally, and the modifier disarms itself either way. Applied
  // where xterm hands input over (term.onData, below) rather than on the keydown, because an
  // Android soft keyboard doesn't deliver a usable keydown at all - Chromium reports
  // key="Unidentified"/keyCode=229 and the real character only arrives as IME input - which is
  // exactly the case that made an armed Ctrl type a plain "c". onData is the one path both a
  // physical keystroke and an IME commit go through. modifiersRef mirrors the state into that
  // handler's closure (created once per [sessionId], so it reads live values through the ref
  // rather than a stale one captured at effect-run time); the state itself only exists so
  // the toolbar can render which modifier is currently armed. There's no sticky Shift - a
  // real/on-screen keyboard already produces shifted characters on its own, and the one
  // combination it was there for is a literal "Shift+Tab" key in the toolbar now.
  const [modifiers, setModifiers] = useState({ ctrl: false, alt: false })
  const modifiersRef = useRef(modifiers)

  function toggleModifier(key: 'ctrl' | 'alt') {
    // The ref is the source of truth for the input handler and is updated synchronously here,
    // not from an effect watching the state. React runs passive effects *after* paint and will
    // happily defer them while the main thread is busy - and tapping a modifier on Android is
    // exactly when it is busy - so a keystroke arriving in that window would have read an
    // un-armed ref and typed the character literally, which is the "Ctrl is lit but c still
    // types a c" report. The state is only what re-renders the toolbar's armed styling.
    const next = { ...modifiersRef.current, [key]: !modifiersRef.current[key] }
    modifiersRef.current = next
    setModifiers(next)
    refocusTerminal()
  }

  // Puts focus back on xterm's hidden textarea, but only when it isn't already there.
  //
  // A redundant focus() is not free on Android: it can make the platform restart the keyboard's
  // input connection, which is the delay between tapping a key and the shell reacting. The
  // toolbar's buttons already cancel their own press default so focus never moves (see
  // pressProps in KeyboardToolbar) - this is the recovery path for when something else took it.
  function refocusTerminal() {
    const term = termRef.current
    if (!term) return
    const textarea = term.element?.querySelector('textarea')
    if (textarea && document.activeElement === textarea) return
    term.focus()
  }

  // Sends a fixed key/escape sequence from a toolbar button press.
  function sendKey(data: string) {
    sendRawRef.current(data)
    refocusTerminal()
  }

  // Inserts text the way a real paste does (xterm wraps it in bracketed-paste markers when the
  // remote asked for them), so a multi-line snippet lands as one paste instead of a burst of
  // keystrokes the shell would start executing line by line.
  function pasteText(text: string) {
    termRef.current?.paste(text)
    refocusTerminal()
  }

  // The touch selection's only exit that isn't "throw it away": copy it, drop the selection, and
  // hand focus back to the terminal so typing carries straight on. Driven from pointerdown with
  // its default cancelled (the same trick the key toolbar uses) so the press never moves focus off
  // xterm's textarea - Android tears the keyboard's input connection down and rebuilds it when it
  // does, and a press is a user gesture as far as the clipboard is concerned either way.
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

  // Uploads dropped/pasted files into the shell's current directory (tracked via OSC 7),
  // or a directory the user is prompted for when that's unknown. Deliberately does NOT feed
  // the bytes into the terminal as input - that's the whole point of intercepting them.
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return

    // A local shell already has the file - there is nowhere to send it, and the SFTP upload
    // this would otherwise open has no destination to open against.
    const uploadRequest = requestRef.current
    if (!uploadRequest) {
      setUploadStatus({ message: 'This shell is on this machine - the file is already here.' })
      setTimeout(() => setUploadStatus(null), 4000)
      return
    }

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
        const { remotePath } = await sshUpload(uploadRequest, remoteDir, name, file)
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
      // Nothing to fit to while this tab is hidden. Every open tab stays mounted and the
      // inactive ones are display:none (see App.tsx), which measures 0x0 - and a
      // ResizeObserver reports exactly that the moment a tab is switched away from. Fitting
      // against it doesn't no-op: FitAddon floors its proposal at a couple of cells, so the
      // background tab's PTY was being resized down to a sliver and back up again on every
      // switch. The remote notices - readline redraws its prompt on SIGWINCH, a full-screen
      // app relays out entirely - so a tab the user only switched away from produced output,
      // which the unseen-activity tracking above then reported as background activity that
      // was never cleared (the favicon badge sat on its accent color from then on). Coming
      // back to the tab restores a real size and fires the observer again, which is what
      // re-fits it.
      //
      // Read back off the ref rather than the narrowed `container` above: this is a hoisted
      // function declaration, so TypeScript gives it the ref's declared (nullable) type
      // regardless of the early return the effect opens with.
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

    // Lets the Android keyboard toolbar (see KeyboardToolbar.tsx) commit an in-progress IME
    // composition before a button's own bytes go out, without racing xterm's own handling of
    // the same commit. No-op off Android.
    const disposeCompositionBridge = textarea ? registerCompositionBridge(textarea) : undefined

    // Bridges the exact gap between the IME ending composition (e.g. the trailing space after
    // a word - see CompositionHelper.compositionend in xterm) and that same word's characters
    // reappearing once the remote shell's echo has round-tripped back. xterm hides its own
    // composition preview (the .composition-view overlay showing the in-progress word at the
    // cursor) the instant compositionend fires, but doesn't actually send the committed text
    // until its own deferred setTimeout(0) runs, and the remote then has to receive and echo
    // it back before anything real is drawn - on a real network that gap is what read as the
    // just-typed word vanishing for a moment. Copying that already-positioned element into an
    // overlay of our own closes the gap without us tracking cursor/cell geometry ourselves -
    // only xterm's own internal services have access to that.
    //
    // A copy rather than re-activating xterm's own element (what this did until now): xterm
    // keeps mutating .composition-view for its own purposes, and the very next compositionstart
    // blanks its textContent outright (CompositionHelper.compositionstart) while re-marking it
    // active - so the frozen word silently became an empty box. Committing with Enter is
    // exactly when a mobile IME immediately opens a fresh composition on the new line, which is
    // why the Space case looked fixed (PR #103/#106) while Enter kept flickering. Nothing but
    // the code below ever touches this element, so no amount of xterm-side churn can blank it.
    const compositionView = container.querySelector<HTMLElement>('.composition-view')
    const echoPreview = document.createElement('div')
    // Same class (identical geometry/styling/stacking as the real preview it stands in for)
    // plus a marker of our own, which is also what the e2e tests key off.
    echoPreview.classList.add('composition-view', 'composition-echo')
    compositionView?.parentElement?.appendChild(echoPreview)
    let compositionFreezeTimeout: ReturnType<typeof setTimeout> | undefined
    // Mirrors CompositionHelper's own _isComposing - compositionend (below) clears it, but so
    // does the keydown case just below it, which is the whole reason this exists as a separate
    // ref rather than reading xterm's private state.
    const isComposingRef = { current: false }
    // True only for the tick in which an IME commit's text is handed to onData, so the sticky
    // modifier there can tell a committed word apart from a paste or an escape sequence.
    let compositionCommitPending = false
    function unfreezeComposition() {
      clearTimeout(compositionFreezeTimeout)
      compositionFreezeTimeout = undefined
      echoPreview.classList.remove('active')
    }
    unfreezeCompositionRef.current = unfreezeComposition
    // Snapshots the word xterm is about to stop previewing, at the position xterm had already
    // computed for it (see the two call sites below), and arms the backstop that drops the
    // snapshot again if real output never supersedes it.
    function freezeComposition() {
      if (!compositionView?.textContent) return
      echoPreview.style.cssText = compositionView.style.cssText
      echoPreview.textContent = compositionView.textContent
      echoPreview.classList.add('active')
      // Backstop for a shell that never echoes what was typed (rare, but possible) - don't
      // leave stale composed text on screen forever if the real echo never arrives.
      compositionFreezeTimeout = setTimeout(unfreezeComposition, 1000)
    }
    const onCompositionEnd = () => {
      isComposingRef.current = false
      // The commit xterm is about to send is the one onData turns into a control code, and a
      // control code isn't echoed back as the letter it was composed from - freezing the
      // preview would leave a phantom "o" sitting on screen for the backstop second.
      compositionCommitPending = true
      setTimeout(() => {
        compositionCommitPending = false
      }, 0)
      if (modifiersRef.current.ctrl || modifiersRef.current.alt) return
      // xterm's own listener (registered first, at term.open() time - same-event listeners
      // fire in registration order) has already hidden its preview as part of handling the
      // commit; taking the snapshot here, synchronously after that, is what keeps the word on
      // screen without interfering with that handling.
      freezeComposition()
    }
    const onCompositionStart = () => {
      isComposingRef.current = true
    }
    // A new word being previewed lands on top of the frozen one (same cursor cell, since the
    // echo that would have moved the cursor hasn't arrived yet), so the snapshot has to go the
    // moment there's real preview text to replace it - on the update, not on the start, or
    // typing ahead of a slow echo would blank the previous word again.
    const onCompositionUpdate = () => {
      unfreezeComposition()
      // A sticky modifier can only apply to a character the terminal actually receives, and a
      // composing IME hands nothing over until the word is finished - so with Ctrl armed the
      // "o" of Ctrl+O just sat in the composing region while nano waited, and whatever finally
      // committed it arrived as a whole word rather than the single character onData applies
      // the modifier to. That's the "Ctrl+O in nano types a literal o and leaves Ctrl lit"
      // report. Committing the moment the IME starts holding text puts that first character
      // through on its own, with the modifier still armed for it. Only while one is armed:
      // ending every composition early would take the local preview (the whole reason
      // composing is on, see MainActivity's TerminalWebView) away from normal typing.
      if (modifiersRef.current.ctrl || modifiersRef.current.alt) void finishAndroidComposing()
    }
    // A real compositionend DOM event isn't the only way a composition finishes: pressing
    // Enter mid-word makes CompositionHelper.keydown finalize it right there, synchronously,
    // via its "don't wait for propagation" branch (so the composed text reaches the shell
    // before Enter runs the command) - hiding the composition-view with no compositionend event
    // at all, since none needs to fire for xterm's own purposes. Without this, that path skipped
    // the freeze above entirely, which is why committing a word with Space stopped flickering
    // (PR #103) but committing the same word by pressing Enter still did.
    //
    // Registered capture:true (and after term.open(), so still after xterm's own listener in
    // registration order) rather than the default bubble: xterm's own keydown listener on this
    // same textarea is itself capture:true and calls stopPropagation() as part of ordinary key
    // handling, which - on the very same element - keeps a bubble-phase listener from ever
    // running at all, not merely from seeing ancestors. A bubble listener here would silently
    // never fire for any key xterm considers fully handled, Enter included, which is exactly the
    // one this needs to catch. The keyCode exclusions match CompositionHelper.keydown's own
    // "still composing" cases (CapsLock/Enter's 229/Shift/Ctrl/Alt) so this only fires for a
    // keydown that actually finalized the composition.
    const onKeyDownDuringComposition = (event: KeyboardEvent) => {
      if (!isComposingRef.current) return
      if ([16, 17, 18, 20, 229].includes(event.keyCode)) return
      isComposingRef.current = false
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

    // Everything the terminal answers to on a touchscreen - drag to scroll the scrollback, long
    // press to select (then drag to extend), double tap for Tab, the way Termius does - lives in
    // one gesture handler, since all three start from the same touchstart. Deliberately built on
    // touch events rather than the mouse events a browser synthesizes from them, so a desktop
    // mouse keeps meaning exactly what it always has here: xterm's own selection and wheel.
    const touch = registerTerminalTouch(term, container, {
      onDoubleTap: () => {
        // Through the same commit-first path as the toolbar's own Tab key (see usePressProps in
        // KeyboardToolbar): a double tap asking for completion is normally aimed at the word
        // *currently being typed*, which on Android is still sitting in the IME's composing
        // region and has never reached the shell. Sending a bare \t there completes against
        // whatever the shell last saw - an empty word, so bash dumps every command it knows -
        // and the composed text is then torn down on top of it. Awaiting the commit is what
        // makes the double tap complete the word on screen; it resolves synchronously off
        // Android and whenever nothing is composing.
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
      // One shot: a sticky modifier armed in the toolbar applies to the next single character
      // and then disarms, whether that character came from a physical keystroke or an IME
      // commit. Anything else (a paste, an escape sequence from an arrow key) isn't "the next
      // character", so it passes through and leaves the modifier armed.
      const armed = modifiersRef.current
      if (armed.ctrl || armed.alt) {
        // A committed word arriving whole is the fallback path: off the Android app there's no
        // bridge to end the composition after its first character (see onCompositionUpdate),
        // so the modifier applies to the first character and the rest lands as typed - better
        // than dropping the combination outright and leaving the modifier armed forever. Only
        // for an IME commit; a paste or an arrow key's escape sequence still passes through
        // untouched. Array.from, not [0]/slice, so a surrogate pair stays one character.
        const characters = data.length === 1 || compositionCommitPending ? Array.from(data) : []
        if (characters.length > 0) {
          payload = applyStickyModifiers(characters[0], armed) + characters.slice(1).join('')
          // The ref is written directly as well as through state: two characters arriving in
          // the same tick would both still see the armed value otherwise, since the ref only
          // catches up on the next render.
          modifiersRef.current = { ctrl: false, alt: false }
          setModifiers({ ctrl: false, alt: false })
        }
      }
      sendRawRef.current(payload)
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
    // startupCommands is intentionally excluded - it's fixed for the lifetime of a given
    // sessionId (resolved once at tab-creation time, see App.tsx), so re-running this
    // whole effect over a prop-identity change would just tear down and recreate the same
    // live session for no reason. request is likewise stable per tab and read via a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // The connection to the session, deliberately separate from the terminal above: the shell
  // now outlives any one WebSocket, so losing the socket has to be survivable without
  // throwing away the terminal (and everything on its screen) with it.
  //
  // The Android case this exists for: the app goes to the background, the WebView is
  // suspended or its renderer reclaimed, and this socket dies for reasons that say nothing
  // about the SSH connection - which the backend now keeps detached for a few minutes. So a
  // close is treated as "reattach", and only an explicit close reason from the server means
  // the session is actually over.
  useEffect(() => {
    // A tab keeps this component across a reconnect (App.tsx keys the list by tab id, not by
    // session), so a new session id has to start from a clean slate with nothing rendered yet.
    offsetRef.current = undefined

    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryDelay = 500
    const startupTimeouts: ReturnType<typeof setTimeout>[] = []
    // The socket this effect currently considers live. Every handler checks its own socket
    // against it and does nothing if it isn't the current one: a retry timer, a
    // visibilitychange and an in-flight "is the session still there?" probe can all decide to
    // reconnect at nearly the same moment, and without this the losers of that race keep
    // running - each opening another socket on its own close, which is a connection storm
    // rather than a reconnect.
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

        // The shell channel is ready now, so correct the PTY from the ConnectRequest's initial
        // 80x24 to the terminal's actual measured size (xterm has laid out by this point) -
        // and, on a reattach, from whatever size it had before we were interrupted.
        fitAndSyncRef.current()
      })

      socket.addEventListener('message', (event) => {
        if (current !== socket) return
        // A text frame is the attach header (see TerminalSession.AttachAsync), saying where
        // in the session's output the byte stream that follows begins. Everything else on
        // this channel is raw PTY bytes, so the type is all the disambiguation needed. The
        // backend also re-sends it mid-stream if this socket ever falls so far behind that
        // the replay buffer drops output - hence resetting on `gap` here and not just on the
        // first frame.
        if (typeof event.data === 'string') {
          try {
            const header = JSON.parse(event.data) as { type?: string; offset?: number; gap?: boolean; fresh?: boolean }
            if (header.type === 'attach' && typeof header.offset === 'number') {
              offsetRef.current = header.offset
              // What follows doesn't join onto what's on screen. Start clean rather than
              // splice a hole.
              if (header.gap) termRef.current?.reset()
              // The backend, not this component, decides whether the host's startup snippets
              // still need running: only it knows whether this session has ever had a client.
              // A page reload mounts a brand-new terminal onto a shell that may have been
              // running for minutes, and typing the startup list into that a second time is
              // exactly the kind of thing that reruns someone's deploy script.
              if (header.fresh) sendStartupCommands()
            }
          } catch {
            // Not a header we understand - ignore it rather than feed JSON to the terminal.
          }
          return
        }

        const bytes = new Uint8Array(event.data as ArrayBuffer)
        offsetRef.current = (offsetRef.current ?? 0) + bytes.byteLength
        // Real output has arrived - it's at least as current as any frozen composition preview
        // (see the terminal effect above), so that preview goes now. Handing it to write()'s
        // own completion callback rather than dropping it here first is what keeps the swap
        // invisible: write() is asynchronous (xterm parses off a macrotask via WriteBuffer and
        // only then schedules a render), so clearing the preview up front hands the browser a
        // window in which it can paint the old row with the preview already gone and the echo
        // not yet drawn - one flicker of exactly the blank this whole mechanism exists to
        // prevent, and a much wider one for Enter, whose echo comes back as a burst (the line,
        // the newline, the command's output, a fresh prompt) rather than a single small chunk.
        // The callback fires right after the parse that draws the echo and before the render it
        // schedules, so both land in the same frame.
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
          // The shell itself ended (`exit`) - the tab is done. Stop this effect's own
          // machinery first: App unmounts us in response, but a visibilitychange landing in
          // the meantime would otherwise reconnect and fire the callback a second time.
          disposed = true
          clearTimeout(retryTimer)
          onSessionClosedRef.current()
          return
        }

        if (event.reason === 'session-lost') {
          // The SSH connection to the host died (a WiFi-to-mobile handover, the host
          // rebooting). The user isn't finished, so keep the tab and dial again.
          disposed = true
          clearTimeout(retryTimer)
          onSessionLostRef.current()
          return
        }

        if (event.reason === 'session-superseded') {
          // Another window attached to this same session and took it over. Reconnecting would
          // evict that one straight back, and the two would trade the session forever, so
          // this one stops and says so instead.
          setSuperseded(true)
          setReconnecting(false)
          return
        }

        setReconnecting(true)
        // Any other close - including the anonymous one the browser reports for both a
        // rejected upgrade and a dead network - tells us nothing on its own, so ask.
        void sshSessionState(sessionId).then((state) => {
          // Something already reconnected while the question was in flight (coming back to
          // the app doesn't wait for it) - leave that socket alone.
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
          // Backs off to half a minute rather than settling at a few seconds: when the answer
          // is "live" only because the backend didn't answer at all (see sshSessionState),
          // this is every open tab polling a server that may simply be gone, and on a phone
          // that is a wakeup every few seconds for as long as the app is open. Coming back to
          // the app resets it to an immediate retry, so responsiveness doesn't depend on it.
          retryDelay = Math.min(retryDelay * 2, 30_000)
        })
      })
    }

    // Sends the host's startup snippets. Called only from the attach header's `fresh` flag,
    // which is the backend saying this socket is the session's first ever client.
    function sendStartupCommands() {
      // A short guard delay before the first one lets the shell's own banner/prompt print
      // first, so the command text doesn't land in the middle of it; spacing the rest out the
      // same way keeps each one from racing a slow prompt on the previous line.
      let delay = 300
      for (const command of startupCommandsRef.current ?? []) {
        const text = command.endsWith('\n') || command.endsWith('\r') ? command : `${command}\r`
        startupTimeouts.push(setTimeout(() => sendRawRef.current(text), delay))
        delay += 300
      }
    }

    connect()

    // Coming back to the app is the moment to retry, not whenever a backoff timer happens to
    // fire: a backgrounded page has its timers throttled to about one a minute and a frozen
    // one has them stopped altogether, so waiting on the timer alone would leave the user
    // looking at a dead terminal for up to a minute after switching back. These events fire
    // on thaw, which is exactly the right moment.
    // Deliberately still runs when superseded: what causes the two-window ping-pong is the
    // automatic backoff retry, which the superseded branch stops. Coming back to a window is
    // the user saying they want this one, and two windows that are both on screen never fire
    // this at all - so reclaiming here settles rather than oscillates.
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
        {/* overflow-hidden so this container's own box can never be nudged by xterm's rendered
            content (e.g. a fractional cell-size rounding mismatch) - it must stay purely
            parent-driven, since fitAddon.fit() computes rows/cols *from* this element's size.
            On mobile we need overflow-y-auto to allow scrolling when keyboard is open. */}
        {/* touch-none on a touchscreen: every gesture over the terminal is one of ours (see
            terminalTouch.ts), and letting the browser start a pan of its own first would leave a
            drag scrolling this container instead of the scrollback. Elsewhere,
            touch-manipulation still buys a double tap free of double-tap-to-zoom, and taps that
            land without the browser's 300ms wait. */}
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
                  // Centred on the cell edge it controls and hanging below the row, so it
                  // marks the boundary without covering the text it belongs to. The teardrop's
                  // point (rounding, below) is what says which end it is.
                  transform: 'translate(-50%, 0)',
                }}
                // Deliberately larger than it looks (the visible dot is the inner span): a
                // 10px target is unusable with a fingertip, which is half of why the selection
                // felt unadjustable even once the handles were there.
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
