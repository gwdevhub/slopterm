// Detects and talks to the native Photino window host (see server/Native/AppWindowManager.cs),
// which drives window controls through window.external. Absent in a plain browser.

interface PhotinoExternal {
  sendMessage?: (message: string) => void
  receiveMessage?: (callback: (message: string) => void) => void
}

function photino(): PhotinoExternal | undefined {
  if (typeof window === 'undefined') return undefined
  const ext = window.external as unknown
  return (ext as PhotinoExternal)?.sendMessage !== undefined ? ext as PhotinoExternal : undefined
}

// Photino injects window.external.sendMessage before page scripts run, so this is settled
// by the time any component reads it.
export const isDesktopApp = typeof photino()?.sendMessage === 'function'

// Window-control verbs the title bar posts; the backend switches on the "wc:" prefix.
// 'drag' hands off to the OS's native window-move loop (see AppWindowManager).
export type WindowCommand = 'min' | 'max' | 'close' | 'ready' | 'drag'

export function sendWindowCommand(command: WindowCommand): void {
  photino()?.sendMessage?.(`wc:${command}`)
}

export function sendWindowMessage(type: string, payload: unknown): void {
  photino()?.sendMessage?.(`wc:${type}:${JSON.stringify(payload)}`)
}

export function openExternalViaDesktop(url: string): boolean {
  if (!isDesktopApp) return false
  sendWindowMessage('open-external', url)
  return true
}

// Registers a handler for backend -> frontend messages (e.g. "wc:maximized"/"wc:restored"
// so the maximize/restore glyph can track the real window state).
export function onWindowMessage(callback: (message: string) => void): void {
  photino()?.receiveMessage?.(callback)
}
