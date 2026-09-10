// A tiny app-wide signal for "the vault just unlocked", so parts of the app outside the
// VaultGate (notably appearance sync) can react. No payload, just a ping.

type Listener = () => void
const listeners = new Set<Listener>()

export function onVaultUnlocked(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function notifyVaultUnlocked() {
  for (const fn of listeners) fn()
}
