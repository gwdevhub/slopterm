import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyAppearance, loadAppearance } from './lib/appearance.ts'
import { registerExternalLinkHandler } from './lib/externalLinks.ts'

// Apply the saved colors/fonts before the first render so there's no flash of the default theme.
applyAppearance(loadAppearance())
registerExternalLinkHandler()

// Registering a service worker is one of the installability requirements for "Add as
// PWA" - see public/sw.js for why it deliberately does no caching.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
