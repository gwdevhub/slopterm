// App icon badge support - communicates open tab count to native platforms.
// Posts the current tab count to the native host via the Photino message bridge. Android has
// no bridge method for this: the only way to show a badge there is a persistent notification,
// and posting one just for an open-tab count is worse than not having a badge at all.

import { sendWindowMessage } from './photino'

const MAX_BADGE_COUNT = 99

/**
 * Sends the badge count to all supported platforms.
 * Safe to call on any platform - unsupported ones are no-ops.
 *
 * Platform support:
 * - PWA: Uses navigator.setAppBadge (standard Badging API)
 * - Photino (Windows/Linux/macOS): Uses wc:set-badge message to native window
 */
export function updateAppBadge(count: number): void {
  const normalized = Math.max(0, Math.min(count, MAX_BADGE_COUNT))

  // PWA Badging API (works in installed PWAs)
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
