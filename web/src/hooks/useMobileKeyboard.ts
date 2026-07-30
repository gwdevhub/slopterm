import { useEffect } from 'react'
import { isMobileApp } from '../lib/androidBridge'

/**
 * Returns the current keyboard height in pixels (0 if not visible).
 * On Android native, reads from the SloptermAndroid bridge.
 * On web/mobile browsers, estimates from visual viewport height.
 */
function getKeyboardHeight(): number {
  // Android native: read from bridge
  const bridge = (window as any).SloptermAndroid
  if (bridge?.getKeyboardHeight !== undefined) {
    return bridge.getKeyboardHeight()
  }

  // Web/iOS: estimate from viewport
  if (typeof window !== 'undefined' && window.visualViewport) {
    const viewportHeight = window.visualViewport.height
    const windowHeight = window.innerHeight
    const heightDiff = windowHeight - viewportHeight
    // Only consider it a keyboard if viewport is significantly smaller
    return heightDiff > 100 ? heightDiff : 0
  }

  return 0
}

/**
 * Global hook that scrolls focused elements into view when the virtual keyboard appears.
 * Must be called once at the app root (App.tsx).
 *
 * This handles:
 * - Input elements (input, textarea, select)
 * - xterm.js terminal (uses hidden textarea with class xterm-helper-textarea)
 * - Content editable elements
 */
export function useMobileKeyboardScroll() {
  useEffect(() => {
    if (!isMobileApp()) return

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement
      if (!target) return

      // Check if this is an input element we care about
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
      const isXtermTextarea = target.classList?.contains('xterm-helper-textarea')
      const isContentEditable = target.isContentEditable

      if (!isInput && !isXtermTextarea && !isContentEditable) return

      // Delay to allow keyboard animation to start
      setTimeout(() => {
        const keyboardHeight = getKeyboardHeight()
        if (keyboardHeight <= 0) return

        const rect = target.getBoundingClientRect()
        const visibleHeight = window.innerHeight - keyboardHeight

        // If the target's bottom is below the visible area, scroll it into view
        if (rect.bottom > visibleHeight) {
          const scrollAmount = rect.bottom - visibleHeight + 20
          window.scrollBy({ top: -scrollAmount, behavior: 'smooth' })
        }
        // If the target's top is above the visible area, scroll it into view
        else if (rect.top < 0) {
          window.scrollBy({ top: -rect.top + 20, behavior: 'smooth' })
        }
      }, 100)
    }

    document.addEventListener('focusin', handleFocusIn)

    return () => {
      document.removeEventListener('focusin', handleFocusIn)
    }
  }, [])
}

/**
 * Hook to track keyboard visibility and height on mobile devices.
 * Returns the current keyboard height in pixels.
 */
export function useMobileKeyboardHeight(): number {
  // For now, just return the current height - a full reactive hook would need
  // event listeners that we handle in useMobileKeyboardScroll
  return getKeyboardHeight()
}

/**
 * Keeps the app's own height equal to the part of the window the virtual keyboard ISN'T
 * covering, by publishing it as `--app-height` (consumed by #root in index.css).
 *
 * Must be called once at the app root (App.tsx).
 *
 * Opening the keyboard does not shrink the layout viewport on Android Chrome (or in a WebView
 * that draws edge-to-edge): the page keeps its full height and the keyboard is simply painted
 * over the bottom of it. A bottom-anchored element - the terminal's own key toolbar - then ends
 * up underneath the keyboard, which is exactly where it's least useful. `visualViewport.height`
 * is the part still actually visible, so sizing #root to it puts the toolbar directly above the
 * keyboard instead. The scrollTo keeps the layout viewport pinned to the top, since a browser
 * that scrolled the page to reveal the focused element would otherwise leave the app's own top
 * bar off-screen once it's no longer overflowing.
 */
export function useVisualViewportHeight() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!isMobileApp() || !viewport) return

    function apply() {
      // Guard against a transient 0 mid keyboard animation, which would collapse every pane
      // to nothing for a frame.
      if (viewport && viewport.height > 0) {
        document.documentElement.style.setProperty('--app-height', `${viewport.height}px`)
      }
      window.scrollTo(0, 0)
    }

    apply()
    viewport.addEventListener('resize', apply)
    viewport.addEventListener('scroll', apply)

    return () => {
      viewport.removeEventListener('resize', apply)
      viewport.removeEventListener('scroll', apply)
      document.documentElement.style.removeProperty('--app-height')
    }
  }, [])
}
