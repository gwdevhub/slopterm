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
  passphrase?: string
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

export interface SnippetRecord {
  name: string
  command: string
}

export interface SavedSnippet {
  id: string
  updatedAt: string
  snippet: SnippetRecord
}

export async function listSnippets(): Promise<SavedSnippet[]> {
  const res = await fetch('/api/vault/snippets')
  await throwOnError(res)
  return res.json()
}

export async function createSnippet(snippet: SnippetRecord): Promise<{ id: string }> {
  const res = await fetch('/api/vault/snippets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snippet),
  })
  await throwOnError(res)
  return res.json()
}

export async function deleteSnippet(id: string): Promise<void> {
  await fetch(`/api/vault/snippets/${id}`, { method: 'DELETE' })
}

export interface KeychainEntryRecord {
  name: string
  privateKey: string
  passphrase?: string
}

export interface SavedKeychainEntry {
  id: string
  updatedAt: string
  entry: KeychainEntryRecord
}

export async function listKeychainEntries(): Promise<SavedKeychainEntry[]> {
  const res = await fetch('/api/vault/keychain')
  await throwOnError(res)
  return res.json()
}

export async function createKeychainEntry(entry: KeychainEntryRecord): Promise<{ id: string }> {
  const res = await fetch('/api/vault/keychain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
  await throwOnError(res)
  return res.json()
}

export async function deleteKeychainEntry(id: string): Promise<void> {
  await fetch(`/api/vault/keychain/${id}`, { method: 'DELETE' })
}

export interface LogEntry {
  event: 'connected' | 'connect_failed' | 'disconnected'
  host: string
  port: number
  username: string
  detail?: string | null
}

export interface SavedLogEntry {
  id: string
  timestamp: string
  entry: LogEntry
}

export async function listLogs(): Promise<SavedLogEntry[]> {
  const res = await fetch('/api/vault/logs')
  await throwOnError(res)
  return res.json()
}

export async function clearLogs(): Promise<void> {
  await fetch('/api/vault/logs', { method: 'DELETE' })
}

export interface AppSettingsInfo {
  requireMasterPassword: boolean
}

export async function getSettings(): Promise<AppSettingsInfo> {
  const res = await fetch('/api/settings')
  await throwOnError(res)
  return res.json()
}

export async function setRequireMasterPassword(
  required: boolean,
  currentPassword?: string,
  newPassword?: string,
): Promise<AppSettingsInfo> {
  const res = await fetch('/api/settings/require-master-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ required, currentPassword, newPassword }),
  })
  await throwOnError(res)
  return res.json()
}

export interface GithubTokenStatus {
  hasToken: boolean
}

export async function getGithubTokenStatus(): Promise<GithubTokenStatus> {
  const res = await fetch('/api/settings/github-token')
  await throwOnError(res)
  return res.json()
}

export async function setGithubToken(token: string | null): Promise<GithubTokenStatus> {
  const res = await fetch('/api/settings/github-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  await throwOnError(res)
  return res.json()
}

export interface UpdateCheckResult {
  supported: boolean
  updateAvailable: boolean
  currentSha256: string | null
  latestSha256: string | null
  latestTagName: string | null
  assetId: number | null
  error: string | null
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const res = await fetch('/api/update/check')
  await throwOnError(res)
  return res.json()
}

export interface UpdateProgress {
  phase: 'idle' | 'downloading' | 'verifying' | 'installing' | 'restarting' | 'error'
  percent: number
  error: string | null
}

export async function getUpdateProgress(): Promise<UpdateProgress> {
  const res = await fetch('/api/update/progress')
  await throwOnError(res)
  return res.json()
}

export async function applyUpdate(assetId: number, expectedSha256: string): Promise<void> {
  const res = await fetch('/api/update/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId, expectedSha256 }),
  })
  await throwOnError(res)
}

export async function exportVaultBackup(): Promise<Blob> {
  const res = await fetch('/api/vault/export')
  await throwOnError(res)
  return res.blob()
}

export async function importVaultBackup(file: File): Promise<void> {
  const res = await fetch('/api/vault/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  await throwOnError(res)
}

export async function resetVaultToDefault(): Promise<void> {
  const res = await fetch('/api/vault/reset', { method: 'POST' })
  await throwOnError(res)
}

export interface SftpConnectResponse {
  sessionId: string
  homeDirectory: string
}

export async function sftpConnect(request: ConnectRequest): Promise<SftpConnectResponse> {
  const res = await fetch('/api/sftp/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  await throwOnError(res)
  return res.json()
}

export async function sftpDisconnect(sessionId: string): Promise<void> {
  await fetch(`/api/sftp/session/${sessionId}`, { method: 'DELETE' })
}

export interface FsEntry {
  name: string
  isDirectory: boolean
  size: number
  modifiedUtc: string
}

// Local and remote listings share this shape (see server/SftpSession.cs/LocalFileSystem.cs)
// so the dual-pane SFTP browser can render both sides with identical UI code.
export interface FsListing {
  path: string
  parent: string | null
  entries: FsEntry[]
}

export async function sftpList(sessionId: string, path?: string): Promise<FsListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await fetch(`/api/sftp/${sessionId}/list${query}`)
  await throwOnError(res)
  return res.json()
}

export async function localList(path?: string): Promise<FsListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await fetch(`/api/local/list${query}`)
  await throwOnError(res)
  return res.json()
}

export async function sftpUpload(sessionId: string, localPath: string, remoteDir: string): Promise<void> {
  const res = await fetch(`/api/sftp/${sessionId}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ localPath, remoteDir }),
  })
  await throwOnError(res)
}

export async function sftpDownload(sessionId: string, remotePath: string, localDir: string): Promise<void> {
  const res = await fetch(`/api/sftp/${sessionId}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remotePath, localDir }),
  })
  await throwOnError(res)
}

export interface WindowPosition {
  x: number
  y: number
  width: number
  height: number
}

// No throwOnError here on purpose - saving the window position is a best-effort
// convenience (via navigator.sendBeacon, see App.tsx), never worth surfacing an error
// for.
export async function saveWindowPosition(position: WindowPosition): Promise<void> {
  navigator.sendBeacon('/api/window-position', new Blob([JSON.stringify(position)], { type: 'application/json' }))
}
