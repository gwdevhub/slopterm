// The Android head (see android/MainActivity.cs) injects a `SloptermAndroid` object exposing
// native file operations a WebView can't do itself. Absent everywhere else (desktop Photino,
// a normal browser), so callers fall back to the standard web behavior when this returns false.
interface AndroidBridge {
  saveFile(base64Data: string, fileName: string, mimeType: string): void
}

function androidBridge(): AndroidBridge | undefined {
  return (window as unknown as { SloptermAndroid?: AndroidBridge }).SloptermAndroid
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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    // readAsDataURL gives "data:<mime>;base64,<data>" - the native side wants just the base64.
    reader.onload = () => resolve((reader.result as string).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
