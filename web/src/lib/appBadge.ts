// App icon badge support - communicates open tab count to native platforms.
// Posts the current tab count to the native host via Photino message bridge or Android bridge.

import { sendWindowMessage } from './photino'

const MAX_BADGE_COUNT = 99

/**
 * Sends the badge count to all supported platforms.
 * Safe to call on any platform - unsupported ones are no-ops.
 *
 * Platform support:
 * - PWA: Uses navigator.setAppBadge (standard Badging API)
 * - Photino (Windows/Linux/macOS): Uses wc:set-badge message to native window
 * - Android: Uses SloptermAndroid JS bridge
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

  // Android: Use the SloptermAndroid bridge
  if (typeof window !== 'undefined' && (window as any).SloptermAndroid?.setAppBadge) {
    try {
      (window as any).SloptermAndroid.setAppBadge(normalized)
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Clears the app badge on all platforms.
 */
export function clearAppBadge(): void {
  updateAppBadge(0)
}
