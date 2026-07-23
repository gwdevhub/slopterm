// Detects and talks to the native Photino window host. The chromeless desktop window (see
// server/Native/AppWindowManager.cs) has no OS title bar, so the app draws its own and
// drives the window controls through Photino's window.external message bridge. In a plain
// browser (dev, or someone opening the URL directly) window.external has no sendMessage, so
// isDesktopApp is false and the custom title bar / window controls simply aren't rendered -
// the browser draws its own chrome instead.

interface PhotinoExternal {
  sendMessage?: (message: string) => void
  receiveMessage?: (callback: (message: string) => void) => void
}

function photino(): PhotinoExternal | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { external?: PhotinoExternal }).external
}

// Photino injects window.external.sendMessage before page scripts run, so this is settled
// by the time any component reads it.
export const isDesktopApp = typeof photino()?.sendMessage === 'function'

// Window-control verbs the title bar posts; the backend switches on the "wc:" prefix.
export type WindowCommand = 'min' | 'max' | 'close' | 'ready'

export function sendWindowCommand(command: WindowCommand): void {
  photino()?.sendMessage?.(`wc:${command}`)
}

// Registers a handler for backend -> frontend messages (e.g. "wc:maximized"/"wc:restored"
// so the maximize/restore glyph can track the real window state).
export function onWindowMessage(callback: (message: string) => void): void {
  photino()?.receiveMessage?.(callback)
}
