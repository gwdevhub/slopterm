// The Android head (see android/MainActivity.cs) injects a `SloptermAndroid` object exposing
// native file operations a WebView can't do itself. Absent on desktop/browser.
interface AndroidBridge {
  saveFile(base64Data: string, fileName: string, mimeType: string): void
  finishComposing(): void
  // Optional: an older APK still injects a bridge object, so callers must check first
  // regardless because the desktop/browser fallback has to work anyway.
  hideKeyboard?: () => void
}

function androidBridge(): AndroidBridge | undefined {
  return (window as unknown as { SloptermAndroid?: AndroidBridge }).SloptermAndroid
}

export function isAndroidApp(): boolean {
  return androidBridge() !== undefined
}

export function isMobileApp(): boolean {
  if (isAndroidApp()) return true
  
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    const userAgent = navigator.userAgent.toLowerCase()
    if (userAgent.includes('iphone') || userAgent.includes('ipad') || userAgent.includes('ipod')) {
      return true
    }
    if (userAgent.includes('android')) {
      return true
    }
  }
  
  if (typeof window !== 'undefined' && 'ontouchstart' in window) {
    return true
  }
  
  return false
}

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

// Hands a blob to the Android "save file" dialog; returns false when there's no bridge so the
// caller does its normal blob download (a WebView can't download a blob itself).
export async function saveFileViaAndroid(blob: Blob, fileName: string, mimeType: string): Promise<boolean> {
  const bridge = androidBridge()
  if (!bridge?.saveFile) return false
  bridge.saveFile(await blobToBase64(blob), fileName, mimeType)
  return true
}

// Dismisses the on-screen keyboard for the app's own overlays (the toolbar's key/snippet
// panels). Native and a no-op elsewhere; deliberately doesn't blur, which would steal focus.
export function hideAndroidKeyboard(): void {
  androidBridge()?.hideKeyboard?.()
}

// Whether the IME is holding a word in its composing region (from the real
// compositionstart/compositionend events), so finishAndroidComposing() can skip the round trip.
let composing = false
// Every in-flight finishAndroidComposing() resolver, fulfilled together once compositionend
// is observed - a list so overlapping taps don't displace each other's resolver.
let pendingFinishResolvers: Array<() => void> = []
// Whether a native finishComposing() request is already outstanding, so a second overlapping
// call queues onto the same commit instead of asking the IME to finish twice.
let finishRequestInFlight = false

// Wires up xterm's input textarea so finishAndroidComposing() can tell a real commit apart
// and know when one has landed. Call once per terminal instance; dispose the cleanup on teardown.
export function registerCompositionBridge(textarea: HTMLTextAreaElement): () => void {
  const onStart = () => {
    composing = true
  }
  const onEnd = () => {
    composing = false
    finishRequestInFlight = false
    // xterm's own compositionend schedules the real socket send via setTimeout(0); scheduling
    // our resolution the same way lands it strictly after, so a button's bytes can't overtake it.
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

// Commits any composing word and resolves once it has actually reached the terminal, not when
// the native request returned. Resolves immediately when nothing is composing.
export function finishAndroidComposing(): Promise<void> {
  const bridge = androidBridge()
  if (!bridge || !composing) return Promise.resolve()
  return new Promise((resolve) => {
    pendingFinishResolvers.push(resolve)
    if (!finishRequestInFlight) {
      finishRequestInFlight = true
      bridge.finishComposing()
    }
    // Backstop: some IME/WebView combos finish composing without firing compositionend - don't
    // hang a button forever waiting.
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
