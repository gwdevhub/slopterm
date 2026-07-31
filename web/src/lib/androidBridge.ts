// The Android head (see android/MainActivity.cs) injects a `SloptermAndroid` object exposing
// native file operations a WebView can't do itself. Absent everywhere else (desktop Photino,
// a normal browser), so callers fall back to the standard web behavior when this returns false.
interface AndroidBridge {
  saveFile(base64Data: string, fileName: string, mimeType: string): void
  finishComposing(): void
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

// Commits any word the on-screen keyboard is still composing (underlined, not yet sent to the
// shell) as if the user had finished typing it normally. Composing is on for real now (see
// MainActivity's TerminalWebView) so it feels instant to type - xterm.js renders the in-progress
// word itself right at the cursor - but a toolbar button acting mid-composition would otherwise
// tear that word down and lose it (the bug that used to make composing get disabled outright).
// The toolbar calls this synchronously right before it acts, so the commit always lands first.
// No-op off Android (desktop/browser input never holds a separate composing region this way).
export function finishAndroidComposing(): void {
  androidBridge()?.finishComposing()
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
