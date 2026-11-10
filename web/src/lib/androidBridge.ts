// The Android head (see android/MainActivity.cs) injects a `SloptermAndroid` object exposing
// native file operations a WebView can't do itself. Absent on desktop/browser.
interface AndroidBridge {
  saveFile(base64Data: string, fileName: string, mimeType: string): void
  finishComposing(): void
  // Optional: an older APK still injects a bridge object, so callers must check first
  // regardless because the desktop/browser fallback has to work anyway.
  hideKeyboard?: () => void
  openExternal?: (url: string) => void
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

export function openExternalViaAndroid(url: string): boolean {
  const openExternal = androidBridge()?.openExternal
  if (!openExternal) return false
  openExternal(url)
  return true
}

// Per-terminal registration: background tabs must not finish or clear the active tab's input.
const inputOwners = new Map<HTMLTextAreaElement, () => Promise<void>>()
const pendingFinishes = new Map<HTMLTextAreaElement, Promise<void>>()

export function registerCompositionBridge(textarea: HTMLTextAreaElement, finish: () => Promise<void>): () => void {
  inputOwners.set(textarea, finish)
  return () => { inputOwners.delete(textarea); pendingFinishes.delete(textarea) }
}

export function finishAndroidComposing(): Promise<void> {
  const textarea = document.activeElement as HTMLTextAreaElement
  const finish = inputOwners.get(textarea)
  if (!finish) return Promise.resolve()
  const pending = pendingFinishes.get(textarea)
  if (pending) return pending
  // Register the waiter BEFORE posting the native request. The controller, rather
  // than a separate composition flag or xterm timer, decides when input is drained.
  const drained = finish()
  const result = drained.finally(() => {
    if (pendingFinishes.get(textarea) === result) pendingFinishes.delete(textarea)
  })
  pendingFinishes.set(textarea, result)
  androidBridge()?.finishComposing()
  return result
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
