import type { ConnectRequest, SavedHost, SavedRecentConnection, SavedSnippet, SshConfigHostEntry } from './api'

// Shared by the saved-host "Connect"/"SSH"/"SFTP" buttons (HostModal, HostGrid).
//
// Deliberately carries NO credential material: the frontend never receives a saved host's
// password or private key any more, so the request names the host (and, when the host has
// more than one, which credential) and the backend resolves it - which is also what makes
// "use a key named prod-deploy" work, since only the backend can see this device's keychain.
// `canConnect` is likewise server-computed, from the same resolver, so the button state and
// what actually happens on click can't drift apart.
export function resolveConnectRequest(host: SavedHost): ConnectRequest | undefined {
  if (!host.canConnect) {
    return undefined
  }

  const credential = host.host.credentials.find((c) => c.resolution?.resolved) ?? host.host.credentials[0]

  return {
    host: host.host.address,
    port: host.host.port,
    username: credential?.username ?? '',
    authMethod: credential?.kind === 'password' ? 'password' : 'privateKey',
    columns: 80,
    rows: 24,
    hostId: host.id,
    credentialId: credential?.id,
  }
}

// A one-line description of where a host's credential resolved on THIS device, for the card.
// Returns undefined when there's nothing worth saying (an ordinary inline credential).
export function describeCredentialResolution(host: SavedHost): string | undefined {
  const credential = host.host.credentials.find((c) => c.kind === 'keychain')
  if (!credential) {
    return undefined
  }

  const resolution = credential.resolution
  const name = credential.keychainName ?? 'a key'
  switch (resolution?.source) {
    case 'keychain-local':
      return `key: ${resolution.detail ?? name} (yours)`
    case 'keychain-collection':
      return `key: ${resolution.detail ?? name} (shared)`
    case 'keychain-other':
      return `key: ${resolution.detail ?? name} (another collection)`
    case 'ssh-default':
      return `key: ~/.ssh/${resolution.detail}`
    default:
      return `no key called "${name}" on this device`
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

// Mirrors resolveRecentConnectRequest, for a ~/.ssh/config-sourced entry (the Settings
// "Show hosts from ~/.ssh/config" toggle). Undefined when the backend found no usable
// private key for this alias - it likely relies on ssh-agent/interactive auth this app
// has no way to drive, so its card shows read-only but not connectable (see HostCard's
// canConnect).
export function resolveSshConfigConnectRequest(entry: SshConfigHostEntry): ConnectRequest | undefined {
  if (!entry.privateKey) {
    return undefined
  }

  return {
    host: entry.hostName,
    port: entry.port,
    username: entry.username,
    authMethod: 'privateKey',
    privateKey: entry.privateKey,
    columns: 80,
    rows: 24,
  }
}
