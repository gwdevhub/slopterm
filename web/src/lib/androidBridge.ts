// The Android head (see android/MainActivity.cs) injects a `SloptermAndroid` object exposing
// native file operations a WebView can't do itself. Absent everywhere else (desktop Photino,
// a normal browser), so callers fall back to the standard web behavior when this returns false.
interface AndroidBridge {
  saveFile(base64Data: string, fileName: string, mimeType: string): void
  finishComposing(): void
  // Optional: an APK built before this existed still injects a bridge object, and the web
  // bundle it runs is the one embedded in that same APK - but the desktop/browser fallback
  // below has to work anyway, so every caller checks first regardless.
  hideKeyboard?: () => void
}

function androidBridge(): AndroidBridge | undefined {
  return (window as unknown as { SloptermAndroid?: AndroidBridge }).SloptermAndroid
}

// Detects if the app is running on Android (WebView environment)
export function isAndroidApp(): boolean {
  return androidBridge() !== undefined
}

// Detects if the app is running on a mobile platform (Android, iOS, or any touch device)
// This is used to show the keyboard toolbar which is needed on mobile devices
export function isMobileApp(): boolean {
  // Check if it's Android (has the bridge)
  if (isAndroidApp()) return true
  
  // Check for iOS (iPad, iPhone, iPod) or other mobile platforms
  // Note: iOS detection in a WebView context - we check user agent as a fallback
  // In a native app context (like Android), the bridge is the more reliable indicator
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    const userAgent = navigator.userAgent.toLowerCase()
    // iOS devices
    if (userAgent.includes('iphone') || userAgent.includes('ipad') || userAgent.includes('ipod')) {
      return true
    }
    // Android devices (fallback for WebView without bridge or web browser)
    if (userAgent.includes('android')) {
      return true
    }
  }
  
  // Check for touch support as a general mobile indicator
  // This catches mobile browsers and PWA on mobile
  if (typeof window !== 'undefined' && 'ontouchstart' in window) {
    // But exclude tablets/larger devices that have touch but might not need the keyboard
    // We'll be inclusive here since the toolbar doesn't hurt on larger touch devices
    return true
  }
  
  return false
}

// Keyboard height and visibility for mobile
export function getKeyboardHeight(): number {
  const bridge = androidBridge()
  if (bridge && typeof (bridge as any).getKeyboardHeight === 'function') {
    return (bridge as any).getKeyboardHeight()
  }
  return 0
}

export function isKeyboardVisible(): boolean {
  return getKeyboardHeight() > 0
}

// Hands a blob to the Android "save file" dialog (ACTION_CREATE_DOCUMENT). Returns true if the
// native bridge handled it, false if there's no bridge (so the caller does its normal blob
// download). A WebView can't turn a blob into a download, so on Android this is the only way to
// export a file (e.g. the vault backup).
export async function saveFileViaAndroid(blob: Blob, fileName: string, mimeType: string): Promise<boolean> {
  const bridge = androidBridge()
  if (!bridge?.saveFile) return false
  bridge.saveFile(await blobToBase64(blob), fileName, mimeType)
  return true
}

// Dismisses the on-screen keyboard, for the moments the app puts up something of its own that
// the keyboard would otherwise sit on top of (the toolbar's key/snippet panels). Native, and a
// no-op anywhere else: it leaves DOM focus exactly where it was, so the terminal is still the
// focused element and the keyboard comes straight back when it's tapped. The one thing a page
// can do by itself here - blurring whatever is focused - is deliberately not used as a
// fallback: it would take focus off the terminal on every platform to fix a keyboard that only
// covers the panel on this one.
export function hideAndroidKeyboard(): void {
  androidBridge()?.hideKeyboard?.()
}

// Whether the IME is currently holding a word in its composing region (set from the real
// compositionstart/compositionend events on xterm's own textarea - see
// registerCompositionBridge). Lets finishAndroidComposing() skip the native round trip
// entirely on the (overwhelming) majority of toolbar taps where nothing is composing, rather
// than pay a wait on every single press.
let composing = false
// Every in-flight finishAndroidComposing() call's resolver, fulfilled together once the real
// compositionend is actually observed - a list, not a single slot, because two toolbar taps
// landing close together (a fast double-tap, or one button's repeat timer firing while an
// earlier tap's wait is still pending) both need to hear about the same eventual commit
// rather than the second one silently displacing the first's resolver and leaving it hanging.
let pendingFinishResolvers: Array<() => void> = []
// Whether a native finishComposing() request is already outstanding, so a second overlapping
// call queues onto the same commit instead of asking the IME to finish twice.
let finishRequestInFlight = false

// Wires up xterm's own input textarea so finishAndroidComposing() can tell a real commit
// apart from "nothing was composing" and know when one has actually landed. Call once per
// terminal instance (see TerminalView, alongside the other raw textarea listeners it already
// attaches) and dispose the returned cleanup on teardown.
export function registerCompositionBridge(textarea: HTMLTextAreaElement): () => void {
  const onStart = () => {
    composing = true
  }
  const onEnd = () => {
    composing = false
    finishRequestInFlight = false
    // xterm's own compositionend listener runs first (registered at term.open() time, well
    // before this one - same-event listeners fire in registration order) and, for a normal
    // commit like a trailing space, only *schedules* turning the composed word into a real
    // onData/socket send via its own setTimeout(0) rather than sending it here and now (see
    // CompositionHelper._finalizeComposition's waitForPropagation branch). Scheduling our own
    // resolution the same way lands it strictly after that one in the macrotask queue, so
    // whatever a toolbar button sends next is guaranteed to reach the socket after the
    // composed word, not before it - the actual mechanism behind "left arrow moves before
    // -al commits".
    setTimeout(() => {
      const resolvers = pendingFinishResolvers
      pendingFinishResolvers = []
      resolvers.forEach((resolve) => resolve())
    }, 0)
  }
  textarea.addEventListener('compositionstart', onStart)
  textarea.addEventListener('compositionend', onEnd)
  return () => {
    textarea.removeEventListener('compositionstart', onStart)
    textarea.removeEventListener('compositionend', onEnd)
  }
}

// Commits any word the on-screen keyboard is still composing (underlined, not yet sent to the
// shell) as if the user had finished typing it normally, and resolves only once that commit
// has actually reached the terminal - not just once the request asking for it returned.
// MainActivity's native FinishComposing posts the commit into the WebView and returns as soon
// as that post succeeds, well before the page has actually processed it and fired
// compositionend - a caller that treated the bridge call itself as the signal could still send
// its own bytes ahead of the composed word reaching the shell. Resolves immediately, with no
// native round trip at all, when nothing is composing (nearly every toolbar tap), so this can't
// reintroduce the lag the toolbar's pointerdown-based repeat exists to avoid.
export function finishAndroidComposing(): Promise<void> {
  const bridge = androidBridge()
  if (!bridge || !composing) return Promise.resolve()
  return new Promise((resolve) => {
    pendingFinishResolvers.push(resolve)
    if (!finishRequestInFlight) {
      finishRequestInFlight = true
      bridge.finishComposing()
    }
    // Backstop: some IME/WebView combinations could finish composing without ever firing a
    // real compositionend - don't hang a toolbar button forever waiting for an event that
    // isn't coming.
    setTimeout(() => {
      const index = pendingFinishResolvers.indexOf(resolve)
      if (index === -1) return
      pendingFinishResolvers.splice(index, 1)
      resolve()
    }, 250)
  })
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    // readAsDataURL gives "data:<mime>;base64,<data>" - the native side wants just the base64.
    reader.onload = () => resolve((reader.result as string).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
