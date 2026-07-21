import { useEffect, useState, type ReactNode } from 'react'
import { getVaultStatus } from '../lib/api'
import { VaultUnlock } from './VaultUnlock'

interface VaultGateProps {
  children: ReactNode
}

// Shared by every section that reads/writes the vault (Hosts, Snippets, Logs) - shows the
// setup/unlock screen until the vault is actually unlocked, then renders its children.
export function VaultGate({ children }: VaultGateProps) {
  const [state, setState] = useState<'loading' | 'setup' | 'locked' | 'unlocked'>('loading')

  useEffect(() => {
    getVaultStatus()
      .then((s) => setState(s.exists ? (s.unlocked ? 'unlocked' : 'locked') : 'setup'))
      .catch(() => setState('setup'))
  }, [])

  if (state === 'loading') {
    return <p className="p-4 text-slate-400">Loading vault…</p>
  }

  if (state !== 'unlocked') {
    return <VaultUnlock mode={state === 'setup' ? 'setup' : 'locked'} onUnlocked={() => setState('unlocked')} />
  }

  return <>{children}</>
}
