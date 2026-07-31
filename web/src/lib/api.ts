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

// `since` is how many bytes of this session's output the caller has already rendered, so a
// reattach after the socket dropped (the Android app was in the background, the page was
// reloaded) picks up exactly where the screen left off instead of restarting the stream.
// Omit it when there's nothing on screen to continue from - the backend then replays the
// whole tail it still has.
export function terminalSocketUrl(sessionId: string, since?: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const query = since === undefined ? '' : `?since=${since}`
  return `${protocol}//${window.location.host}/ws/terminal/${sessionId}${query}`
}

export interface LiveSshSession {
  sessionId: string
  host: string
  port: number
  username: string
  attached: boolean
}

// The SSH sessions the backend still holds. Losing the terminal WebSocket doesn't end a
// session any more (it survives detached for a few minutes), so this is what lets a reloaded
// page find the sessions its restored tabs were already on.
export async function listSshSessions(): Promise<LiveSshSession[]> {
  const res = await fetch('/api/ssh/sessions')
  await throwOnError(res)
  return res.json()
}

export interface LiveSftpSession {
  sessionId: string
  host: string
  port: number
  username: string
  homeDirectory: string
}

// The SFTP equivalent, so restored file-browser tabs reattach rather than opening a second
// connection per tab and orphaning the first.
export async function listSftpSessions(): Promise<LiveSftpSession[]> {
  const res = await fetch('/api/sftp/sessions')
  await throwOnError(res)
  return res.json()
}

//   live    - the backend is still holding this session; reattach to it.
//   ended   - its shell finished while we were away; the tab is done.
//   unknown - no such session; whatever it was, it's not coming back.
export type SshSessionState = 'live' | 'ended' | 'unknown'

// What became of a session, asked after the terminal's socket closed. The browser reports a
// rejected WebSocket upgrade and a dead connection identically, so this is the only way to
// tell "reattach", "close the tab" and "dial a new connection" apart.
export async function sshSessionState(sessionId: string): Promise<SshSessionState> {
  try {
    const res = await fetch(`/api/ssh/session/${sessionId}/state`)
    await throwOnError(res)
    const body = (await res.json()) as { state?: SshSessionState }
    return body.state ?? 'unknown'
  } catch {
    // The backend didn't answer at all - that's no evidence about the session, so report it
    // as live and let the caller keep retrying rather than tear anything down.
    return 'live'
  }
}

// The AI-agent bottom bar's streaming channel - a sibling of terminalSocketUrl using the
// exact same same-origin construction (so the auth cookie rides the handshake), pointed at
// /ws/agent/{sessionId} instead. See AgentBar.tsx and the pinned agent WS contract.
export function agentSocketUrl(sessionId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/agent/${sessionId}`
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

export interface SyncRuleRecord {
  hostId: string
  localPath: string
  remotePath: string
  description?: string
  autoStart: boolean
  direction: 'localToRemote' | 'remoteToLocal' | 'twoWay'
  deleteExtraneous: boolean
  skipUnchanged: boolean
}

export interface SavedSyncRule {
  id: string
  updatedAt: string
  rule: SyncRuleRecord
}

// Live state of a rule: 'active' (connected, watching), 'connecting' (initial sync / not
// connected yet), or 'error'. Rules not present here are inactive/stopped.
export interface SyncRuleStatus {
  ruleId: string
  hostId: string
  state: 'active' | 'connecting' | 'error'
  error?: string | null
  lastSyncUtc?: string | null
}

export async function listSyncRules(): Promise<SavedSyncRule[]> {
  const res = await fetch('/api/vault/sync-rules')
  await throwOnError(res)
  return res.json()
}

export async function createSyncRule(rule: SyncRuleRecord): Promise<{ id: string }> {
  const res = await fetch('/api/vault/sync-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rule),
  })
  await throwOnError(res)
  return res.json()
}

export async function updateSyncRule(id: string, rule: SyncRuleRecord): Promise<void> {
  const res = await fetch(`/api/vault/sync-rules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rule),
  })
  await throwOnError(res)
}

export async function deleteSyncRule(id: string): Promise<void> {
  await fetch(`/api/vault/sync-rules/${id}`, { method: 'DELETE' })
}

export async function getSyncStatus(): Promise<SyncRuleStatus[]> {
  const res = await fetch('/api/sync/status')
  await throwOnError(res)
  return res.json()
}

export async function startSyncRule(id: string): Promise<void> {
  const res = await fetch(`/api/sync/rules/${id}/start`, { method: 'POST' })
  await throwOnError(res)
}

export async function stopSyncRule(id: string): Promise<void> {
  await fetch(`/api/sync/rules/${id}/stop`, { method: 'POST' })
}

// A command run against a saved host on a schedule (backend SchedulerService). The schedule
// lives in this app, so a job only fires while slopterm is running - the section says so.
export interface JobRecord {
  hostId: string
  name: string
  // Exactly one of the two - a snippet is resolved to its current text at run time.
  command?: string
  snippetId?: string
  scheduleKind: 'interval' | 'daily'
  intervalMinutes: number
  dailyTime: string // "HH:mm", local time
  enabled: boolean
  runOnStart: boolean
  overlapPolicy: 'skip' | 'queue' | 'kill'
  timeoutSeconds: number
  failurePattern?: string
  // null = run on any device; otherwise only the install with this id schedules it (see
  // the backend's DeviceIdentity - it's what stops a synced job running twice).
  ownerDeviceId?: string | null
}

export interface SavedJob {
  id: string
  updatedAt: string
  job: JobRecord
}

export interface JobRun {
  startedUtc: string
  finishedUtc: string
  // 'success' (exit 0), 'failed' (non-zero exit or a failure-pattern match), or 'error'
  // (never ran to completion: couldn't connect, timed out, cancelled).
  outcome: 'success' | 'failed' | 'error'
  exitCode?: number | null
  error?: string | null
  output?: string | null
  errorOutput?: string | null
  truncated: boolean
}

// Unlike forwarding/sync status, EVERY saved job has an entry - 'disabled' and 'otherDevice'
// are real states to show, so a missing entry only ever means the job was deleted.
export interface JobStatus {
  jobId: string
  hostId: string
  state: 'waiting' | 'running' | 'disabled' | 'otherDevice'
  nextRunUtc?: string | null
  lastRun?: {
    startedUtc: string
    finishedUtc: string
    outcome: JobRun['outcome']
    exitCode?: number | null
    error?: string | null
  } | null
}

export async function listJobs(): Promise<SavedJob[]> {
  const res = await fetch('/api/vault/jobs')
  await throwOnError(res)
  return res.json()
}

export async function createJob(job: JobRecord): Promise<{ id: string }> {
  const res = await fetch('/api/vault/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  })
  await throwOnError(res)
  return res.json()
}

export async function updateJob(id: string, job: JobRecord): Promise<void> {
  const res = await fetch(`/api/vault/jobs/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  })
  await throwOnError(res)
}

export async function deleteJob(id: string): Promise<void> {
  await fetch(`/api/vault/jobs/${id}`, { method: 'DELETE' })
}

export async function getJobStatus(): Promise<JobStatus[]> {
  const res = await fetch('/api/jobs/status')
  await throwOnError(res)
  return res.json()
}

export async function getDeviceId(): Promise<string> {
  const res = await fetch('/api/jobs/device-id')
  await throwOnError(res)
  return (await res.json()).deviceId
}

export async function listJobRuns(id: string): Promise<JobRun[]> {
  const res = await fetch(`/api/jobs/${id}/runs`)
  await throwOnError(res)
  return res.json()
}

export async function clearJobRuns(id: string): Promise<void> {
  await fetch(`/api/jobs/${id}/runs`, { method: 'DELETE' })
}

export async function runJobNow(id: string): Promise<void> {
  const res = await fetch(`/api/jobs/${id}/run`, { method: 'POST' })
  await throwOnError(res)
}

export async function cancelJobRun(id: string): Promise<void> {
  await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' })
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
  // The live backend session this tab was on, so a reload that happens while the session is
  // still held (see listSshSessions) reattaches to the running shell instead of dialing a
  // second connection to the same host. Meaningless across a restart - session ids are
  // per-process - which is exactly what checking it against the live listing handles.
  sessionId?: string
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

// Appearance (theme colors + fonts) is stored in the vault so it syncs across devices. The
// server stores it opaquely, so this is typed as unknown - lib/appearance.ts owns the schema
// and merges it over defaults. Returns null when the vault is locked or nothing's saved yet.
export async function getVaultAppearance(): Promise<unknown | null> {
  const res = await fetch('/api/vault/appearance')
  await throwOnError(res)
  return res.json()
}

// Best-effort like saveOpenTabs - no-ops server-side while the vault is locked.
export async function saveVaultAppearance(settings: unknown): Promise<void> {
  await fetch('/api/vault/appearance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
}

export interface AppSettingsInfo {
  requireMasterPassword: boolean
  closeToTray: boolean
  showSshConfigHosts: boolean
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

export async function setShowSshConfigHosts(enabled: boolean): Promise<AppSettingsInfo> {
  const res = await fetch('/api/settings/show-ssh-config-hosts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  await throwOnError(res)
  return res.json()
}

// A literal alias from ~/.ssh/config (see server SshConfigService) - read-only, never
// stored in the vault. privateKey is only present when the backend found a usable key on
// disk (an explicit IdentityFile, or one of the default OpenSSH filenames); absent means
// the alias likely relies on ssh-agent/interactive auth this app can't drive.
export interface SshConfigHostEntry {
  alias: string
  hostName: string
  port: number
  username: string
  privateKey?: string
}

export async function listSshConfigHosts(): Promise<SshConfigHostEntry[]> {
  const res = await fetch('/api/ssh-config/hosts')
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

// --- AI agent ---------------------------------------------------------------------------
// The agent talks to a local OpenAI-compatible server (Ollama by default) - a base URL and
// model name in plaintext settings, no key or account anywhere.

export interface AiSettings {
  baseUrl: string
  model: string
}

export async function getAiSettings(): Promise<AiSettings> {
  const res = await fetch('/api/settings/ai')
  await throwOnError(res)
  return res.json()
}

// Empty strings reset either field to its default (local Ollama / its default model).
export async function setAiSettings(settings: AiSettings): Promise<AiSettings> {
  const res = await fetch('/api/settings/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  await throwOnError(res)
  return res.json()
}

// Live probe: is the configured AI server up, is the configured model actually pulled, and
// which models are available to switch to? Drives the agent bar's status dot + model picker
// and the Settings readout. `models` is empty when the server is unreachable.
export interface AiStatus {
  reachable: boolean
  modelAvailable: boolean
  baseUrl: string
  model: string
  models: string[]
}

export async function getAiStatus(): Promise<AiStatus> {
  const res = await fetch('/api/ai/status')
  await throwOnError(res)
  return res.json()
}

// --- Agent WebSocket wire shapes --------------------------------------------------------
// One JSON object per text frame, camelCase, no subprotocol (see agentSocketUrl). These
// mirror the pinned agent WS contract verbatim.

// The three permission tiers: chat = answers only (no shell access), suggest = may TYPE a
// command for the user to confirm with Enter, auto = may execute, but only after a
// per-command AI safety check (unsafe commands fall back to suggest behavior).
export type AgentMode = 'chat' | 'suggest' | 'auto'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  // Typed loosely: persisted transcripts can carry mode values from older builds.
  mode: string
  // Inline tool-activity chips shown under an assistant bubble; always [] for user messages.
  activities: { tool: string; summary: string }[]
}

// One entry in the per-host saved-conversations list. `active` marks the conversation the
// bar is currently showing/continuing.
export interface ChatSummary {
  id: string
  title: string
  updatedAt: string
  messageCount: number
  active: boolean
}

// Server -> client frames. Discriminated on `type` so the AgentBar reducer can switch
// exhaustively.
export type AgentServerEvent =
  | { type: 'history'; messages: ChatMessage[] }
  | { type: 'chats'; chats: ChatSummary[] }
  | { type: 'turn_start'; id: string; mode: string }
  | { type: 'text_delta'; id: string; text: string }
  // Chain-of-thought from a reasoning model, streamed on its own channel so the bar can show
  // a "thinking" indicator; never part of the persisted transcript (see AgentBar's UiMessage).
  | { type: 'reasoning_delta'; id: string; text: string }
  | { type: 'tool_activity'; id: string; tool: string; summary: string }
  | {
      type: 'turn_done'
      id: string
      stopReason: 'end_turn' | 'stopped' | 'refusal' | 'error'
      error?: string
    }
  | { type: 'error'; message: string }

// Client -> server frames. open_chat/new_chat/delete_chat manage the per-host saved
// conversations (new_chat keeps the outgoing one in the list; clear deletes it).
export type AgentClientMessage =
  // newChat starts a fresh conversation for this message first (used when sending while the
  // saved-chats list is open) - folded into the send so no empty history frame wipes the
  // optimistically-rendered user bubble, unlike firing a separate new_chat frame.
  | { type: 'send'; mode: AgentMode; text: string; newChat?: boolean }
  | { type: 'stop' }
  | { type: 'clear' }
  | { type: 'list_chats' }
  | { type: 'open_chat'; id: string }
  | { type: 'new_chat' }
  | { type: 'delete_chat'; id: string }

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
