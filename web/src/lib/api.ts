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
  // Set when connecting to a saved host so the backend can auto-start that host's port
  // forwards (see ForwardingService). Absent for Quick Connect / Recent.
  hostId?: string
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

// Tells the backend to resize the remote PTY to match the browser terminal (see
// TerminalView). Best-effort: a failed resize just leaves the shell at its previous size,
// not worth surfacing an error over.
export async function resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  await fetch(`/api/ssh/${sessionId}/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  }).catch(() => {})
}

export interface SshUploadResponse {
  remotePath: string
}

// Writes raw bytes (a pasted image, an OS-dropped file) into a remote directory of an SSH
// tab's session - see server /api/ssh/upload. An SSH tab holds only an interactive shell,
// not an SFTP channel, so the backend opens a fresh one-shot SFTP connection from the same
// ConnectRequest the tab already carries. multipart/form-data (not JSON) so the bytes go up
// as-is rather than base64-inflated.
export async function sshUpload(
  request: ConnectRequest,
  remoteDir: string,
  fileName: string,
  data: Blob,
): Promise<SshUploadResponse> {
  const form = new FormData()
  form.append('connect', JSON.stringify(request))
  form.append('remoteDir', remoteDir)
  form.append('file', data, fileName)
  const res = await fetch('/api/ssh/upload', { method: 'POST', body: form })
  await throwOnError(res)
  return res.json()
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
  startupSnippetIds?: string[]
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

export async function updateHost(id: string, host: HostRecord): Promise<void> {
  const res = await fetch(`/api/vault/hosts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(host),
  })
  await throwOnError(res)
}

export async function deleteHost(id: string): Promise<void> {
  await fetch(`/api/vault/hosts/${id}`, { method: 'DELETE' })
}

// Returns a portable, encrypted token encoding this host (address/port/credentials) that
// another slopterm instance can import via importHostShare - backs the "Copy" context-menu
// action. See server HostShareCodec for the format.
export async function getHostShareToken(id: string): Promise<string> {
  const res = await fetch(`/api/vault/hosts/${id}/share`)
  await throwOnError(res)
  return (await res.json()).token
}

export async function importHostShare(token: string): Promise<{ id: string }> {
  const res = await fetch('/api/vault/hosts/import-share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  await throwOnError(res)
  return res.json()
}

export interface PortForwardRecord {
  hostId: string
  type: 'local' | 'remote'
  bindAddress: string
  bindPort: number
  destinationAddress: string
  destinationPort: number
  description?: string
  autoStart: boolean
}

export interface SavedPortForward {
  id: string
  updatedAt: string
  forward: PortForwardRecord
}

// Live state of a rule: 'active' (up), 'connecting' (host connecting / port not up yet), or
// 'error'. Rules not present here are inactive/stopped.
export interface ForwardStatus {
  ruleId: string
  hostId: string
  state: 'active' | 'connecting' | 'error'
  error?: string | null
}

export async function listPortForwards(): Promise<SavedPortForward[]> {
  const res = await fetch('/api/vault/port-forwards')
  await throwOnError(res)
  return res.json()
}

export async function createPortForward(forward: PortForwardRecord): Promise<{ id: string }> {
  const res = await fetch('/api/vault/port-forwards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(forward),
  })
  await throwOnError(res)
  return res.json()
}

export async function updatePortForward(id: string, forward: PortForwardRecord): Promise<void> {
  const res = await fetch(`/api/vault/port-forwards/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(forward),
  })
  await throwOnError(res)
}

export async function deletePortForward(id: string): Promise<void> {
  await fetch(`/api/vault/port-forwards/${id}`, { method: 'DELETE' })
}

export async function getForwardingStatus(): Promise<ForwardStatus[]> {
  const res = await fetch('/api/forwarding/status')
  await throwOnError(res)
  return res.json()
}

export async function startForward(id: string): Promise<void> {
  const res = await fetch(`/api/forwarding/rules/${id}/start`, { method: 'POST' })
  await throwOnError(res)
}

export async function stopForward(id: string): Promise<void> {
  await fetch(`/api/forwarding/rules/${id}/stop`, { method: 'POST' })
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

export async function updateSnippet(id: string, snippet: SnippetRecord): Promise<void> {
  const res = await fetch(`/api/vault/snippets/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snippet),
  })
  await throwOnError(res)
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

export async function updateKeychainEntry(id: string, entry: KeychainEntryRecord): Promise<void> {
  const res = await fetch(`/api/vault/keychain/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
  await throwOnError(res)
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

export interface RecentConnectionRecord {
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  secret?: string
  passphrase?: string
}

export interface SavedRecentConnection {
  id: string
  updatedAt: string
  connection: RecentConnectionRecord
}

export async function listRecentConnections(): Promise<SavedRecentConnection[]> {
  const res = await fetch('/api/vault/recent-connections')
  await throwOnError(res)
  return res.json()
}

// Fire-and-forget like the backend's own AppendLog - never worth blocking or surfacing an
// error for, since it's just remembering a destination for next time.
export async function upsertRecentConnection(connection: RecentConnectionRecord): Promise<void> {
  await fetch('/api/vault/recent-connections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(connection),
  })
}

export interface OpenTabRecord {
  kind: 'ssh' | 'sftp'
  label: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'privateKey'
  secret?: string
  passphrase?: string
  startupCommands?: string[]
}

export interface OpenTabsRecord {
  tabs: OpenTabRecord[]
  activeIndex: number | null
}

// Best-effort like listRecentConnections - a locked/missing vault just means "nothing to
// restore", not an error App.tsx needs to handle specially at startup.
export async function getOpenTabs(): Promise<OpenTabsRecord> {
  const res = await fetch('/api/vault/open-tabs')
  await throwOnError(res)
  return res.json()
}

// Fire-and-forget like upsertRecentConnection - called on every tab add/remove/reconnect,
// so it must never block the UI action that triggered it.
export async function saveOpenTabs(record: OpenTabsRecord): Promise<void> {
  await fetch('/api/vault/open-tabs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  })
}

export interface AppSettingsInfo {
  requireMasterPassword: boolean
  closeToTray: boolean
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

export async function setCloseToTray(enabled: boolean): Promise<AppSettingsInfo> {
  const res = await fetch('/api/settings/close-to-tray', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
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

// Uploads an OS-dragged File (dropped from the file manager onto a pane) - unlike
// sftpUpload it has only the file's bytes, no server-side path, so it streams the raw bytes
// to the bytes-upload endpoint with the name and target remote dir as query params.
export async function sftpUploadBytes(sessionId: string, file: File, remoteDir: string): Promise<void> {
  const query = `?name=${encodeURIComponent(file.name)}&remoteDir=${encodeURIComponent(remoteDir)}`
  const res = await fetch(`/api/sftp/${sessionId}/upload-bytes${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
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

// Remote file-management ops (backed by SftpSession over the live SFTP connection).
// newName/name are always leaf names, never full paths, matching the backend's own
// parent-relative handling.
export async function sftpRename(sessionId: string, path: string, newName: string): Promise<void> {
  const res = await fetch(`/api/sftp/${sessionId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, newName }),
  })
  await throwOnError(res)
}

export async function sftpDelete(sessionId: string, path: string): Promise<void> {
  const res = await fetch(`/api/sftp/${sessionId}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  await throwOnError(res)
}

export async function sftpMkdir(sessionId: string, parentDir: string, name: string): Promise<void> {
  const res = await fetch(`/api/sftp/${sessionId}/mkdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentDir, name }),
  })
  await throwOnError(res)
}

// Local file-management ops - same shapes as the remote ones, but they hit the machine
// running slopterm directly and need no session (gated like /api/local/list).
export async function localRename(path: string, newName: string): Promise<void> {
  const res = await fetch('/api/local/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, newName }),
  })
  await throwOnError(res)
}

export async function localDelete(path: string): Promise<void> {
  const res = await fetch('/api/local/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
  await throwOnError(res)
}

export async function localMkdir(parentDir: string, name: string): Promise<void> {
  const res = await fetch('/api/local/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentDir, name }),
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
