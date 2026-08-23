// "The AI endpoint settings just changed" - the same shape as vaultEvents, and for the same
// reason: the Settings page and a terminal tab's AgentBar are in different trees, and the bar
// has to appear (or disappear) the moment an endpoint is added or cleared, not on the next
// reload. No payload; every listener re-reads the status itself.

type Listener = () => void
const listeners = new Set<Listener>()

export function onAiSettingsChanged(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notifyAiSettingsChanged() {
  for (const fn of listeners) fn()
}
