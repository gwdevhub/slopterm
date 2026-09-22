import { openExternalViaAndroid } from './androidBridge'
import { openExternalViaDesktop } from './photino'

export function openExternalInNativeApp(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, window.location.href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return openExternalViaAndroid(url.href) || openExternalViaDesktop(url.href)
  } catch {
    return false
  }
}

function handleExternalLink(event: MouseEvent): void {
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return

  const target = event.target
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
  if (!anchor) return

  let url: URL
  try {
    url = new URL(anchor.href, window.location.href)
  } catch {
    return
  }
  if (url.origin === window.location.origin) return

  if (openExternalInNativeApp(url.href)) {
    event.preventDefault()
  }
}

// Native app shells must never let an external anchor replace the embedded slopterm page or
// create another embedded Chromium window. Plain-browser/PWA use is deliberately unchanged.
export function registerExternalLinkHandler(): void {
  document.addEventListener('click', handleExternalLink, true)
  document.addEventListener('auxclick', handleExternalLink, true)
}
