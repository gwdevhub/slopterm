import type { ConnectRequest, SavedHost, SavedRecentConnection, SavedSnippet } from './api'

// Shared by the saved-host "Connect"/"SSH"/"SFTP" buttons (HostModal, HostGrid) -
// picks the first usable credential off a host record. Full multi-credential selection
// (letting the user pick when a host has more than one) is issue #12, not this change.
export function resolveConnectRequest(host: SavedHost): ConnectRequest | undefined {
  const credential = host.host.credentials.find((c) => c.kind === 'password' || c.kind === 'privateKey')
  if (!credential) {
    return undefined
  }

  return {
    host: host.host.address,
    port: host.host.port,
    username: credential.username ?? '',
    authMethod: credential.kind === 'password' ? 'password' : 'privateKey',
    password: credential.kind === 'password' ? credential.secret : undefined,
    privateKey: credential.kind === 'privateKey' ? credential.secret : undefined,
    passphrase: credential.kind === 'privateKey' ? credential.passphrase : undefined,
    columns: 80,
    rows: 24,
  }
}

// Resolves a host's attached startup snippets to actual command text, in the order
// they're listed on the host - looked up fresh from the current snippets list rather than
// a snapshot, so editing/deleting a snippet is reflected the next time this host connects
// (see HostRecord.StartupSnippetIds's doc comment). An id whose snippet no longer exists
// is silently skipped rather than erroring the whole connect.
export function resolveStartupCommands(host: SavedHost, snippets: SavedSnippet[]): string[] {
  const ids = host.host.startupSnippetIds ?? []
  return ids
    .map((id) => snippets.find((s) => s.id === id)?.snippet.command)
    .filter((command): command is string => command !== undefined)
}

// Mirrors resolveConnectRequest, but for a Recent connection - RecentConnectionRecord
// always carries exactly one credential (never a list), so there's no "first usable
// credential" search needed.
export function resolveRecentConnectRequest(recent: SavedRecentConnection): ConnectRequest {
  const { connection } = recent
  return {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    authMethod: connection.authMethod,
    password: connection.authMethod === 'password' ? connection.secret : undefined,
    privateKey: connection.authMethod === 'privateKey' ? connection.secret : undefined,
    passphrase: connection.authMethod === 'privateKey' ? connection.passphrase : undefined,
    columns: 80,
    rows: 24,
  }
}
