import { useEffect } from 'react'
import { isMobileApp } from '../lib/androidBridge'

/** Returns the current keyboard height in pixels (0 if not visible). */
function getKeyboardHeight(): number {
  const bridge = (window as any).SloptermAndroid
  if (bridge?.getKeyboardHeight !== undefined) {
    return bridge.getKeyboardHeight()
  }

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
 * Global hook that scrolls focused elements into view when the virtual keyboard appears,
 * including inputs, the xterm.js helper textarea, and content-editable elements.
 * Must be called once at the app root (App.tsx).
 */
export function useMobileKeyboardScroll() {
  useEffect(() => {
    if (!isMobileApp()) return

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement
      if (!target) return

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

        if (rect.bottom > visibleHeight) {
          const scrollAmount = rect.bottom - visibleHeight + 20
          window.scrollBy({ top: -scrollAmount, behavior: 'smooth' })
        }
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

/** Returns the current keyboard height in pixels. */
export function useMobileKeyboardHeight(): number {
  // For now, just return the current height - a full reactive hook would need
  // event listeners that we handle in useMobileKeyboardScroll
  return getKeyboardHeight()
}

/**
 * Keeps the app's own height equal to the part of the window the virtual keyboard isn't
 * covering, by publishing it as `--app-height` (consumed by #root in index.css). The keyboard
 * is painted over the layout viewport rather than shrinking it, so `visualViewport.height` is
 * what keeps bottom-anchored elements above it. Must be called once at the app root (App.tsx).
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
