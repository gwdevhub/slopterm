export interface ConnectRequest {
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  password?: string
  privateKey?: string
  passphrase?: string
  columns: number
  rows: number
}

export interface ConnectResponse {
  sessionId: string
}

export async function connect(request: ConnectRequest): Promise<ConnectResponse> {
  const res = await fetch('/api/ssh/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Connect failed with status ${res.status}`)
  }

  return res.json()
}

export async function disconnect(sessionId: string): Promise<void> {
  await fetch(`/api/ssh/session/${sessionId}`, { method: 'DELETE' })
}

export function terminalSocketUrl(sessionId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/terminal/${sessionId}`
}

export interface VaultStatus {
  exists: boolean
  unlocked: boolean
}

export interface CredentialRecord {
  id: string
  kind: 'password' | 'privateKey' | 'envVar'
  username?: string
  secret?: string
}

export interface HostRecord {
  name: string
  address: string
  port: number
  parentGroupId?: string | null
  credentials: CredentialRecord[]
}

export interface SavedHost {
  id: string
  updatedAt: string
  host: HostRecord
}

async function throwOnError(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Request failed with status ${res.status}`)
  }
}

export async function getVaultStatus(): Promise<VaultStatus> {
  const res = await fetch('/api/vault/status')
  await throwOnError(res)
  return res.json()
}

export async function setupVault(masterPassword: string): Promise<void> {
  const res = await fetch('/api/vault/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPassword }),
  })
  await throwOnError(res)
}

export async function unlockVault(masterPassword: string): Promise<void> {
  const res = await fetch('/api/vault/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterPassword }),
  })
  await throwOnError(res)
}

export async function lockVault(): Promise<void> {
  await fetch('/api/vault/lock', { method: 'POST' })
}

export async function listHosts(): Promise<SavedHost[]> {
  const res = await fetch('/api/vault/hosts')
  await throwOnError(res)
  return res.json()
}

export async function createHost(host: HostRecord): Promise<{ id: string }> {
  const res = await fetch('/api/vault/hosts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(host),
  })
  await throwOnError(res)
  return res.json()
}

export async function deleteHost(id: string): Promise<void> {
  await fetch(`/api/vault/hosts/${id}`, { method: 'DELETE' })
}
