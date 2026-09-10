// "The AI endpoint settings just changed" - the same shape as vaultEvents, so the Settings
// page and a terminal tab's AgentBar (different trees) stay in sync. No payload.

type Listener = () => void
const listeners = new Set<Listener>()

export function onAiSettingsChanged(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notifyAiSettingsChanged() {
  for (const fn of listeners) fn()
}
