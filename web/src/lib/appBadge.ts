// App icon badge support - posts the open tab count to native platforms. Android has no bridge
// method for this; a persistent notification would be worse than no badge.

import { sendWindowMessage } from './photino'

const MAX_BADGE_COUNT = 99

/**
 * Sends the badge count to all supported platforms; unsupported ones are no-ops.
 */
export function updateAppBadge(count: number): void {
  const normalized = Math.max(0, Math.min(count, MAX_BADGE_COUNT))

  if ('setAppBadge' in navigator) {
    try {
      if (normalized > 0) {
        navigator.setAppBadge(normalized)
      } else {
        navigator.clearAppBadge?.()
      }
    } catch {
      // Ignore errors - API may not be available in all contexts
    }
  }

  // Photino/WebView2 desktop window (Windows/Linux/macOS via Photino)
  // The backend (AppWindowManager) forwards this to the platform's native badge API
  sendWindowMessage('set-badge', { count: normalized })
}

/**
 * Clears the app badge on all platforms.
 */
export function clearAppBadge(): void {
  updateAppBadge(0)
}
