namespace Slopterm.Server.Vault;

/// <summary>vault.json - never contains secrets, just what's needed to derive/verify the key.</summary>
public sealed class VaultMetadata
{
    public required string Salt { get; set; } // base64
    public required int Iterations { get; set; }
    public required int MemoryKb { get; set; }
    public required int Parallelism { get; set; }

    // AES-GCM(key, "slopterm-vault-ok") - lets unlock fail with a clear "wrong password"
    // instead of a confusing per-record decrypt failure.
    public required string CanaryNonce { get; set; } // base64
    public required string CanaryCiphertext { get; set; } // base64
}

/// <summary>
/// {subfolder}/{id}.json on disk (hosts/snippets/logs all use this same shape). Id and
/// UpdatedAt stay outside the ciphertext on purpose - a future sync/merge process needs
/// to compare records without decrypting them first (see AGENTS.md's Vault section).
/// </summary>
public sealed class RecordEnvelope
{
    public required string Id { get; set; }
    public required DateTimeOffset UpdatedAt { get; set; }
    public required string Nonce { get; set; } // base64
    public required string Ciphertext { get; set; } // base64
}

/// <summary>The decrypted content of a HostEnvelope.</summary>
public sealed class HostRecord
{
    public required string Name { get; set; }
    public required string Address { get; set; }
    public int Port { get; set; } = 22;
    public string? ParentGroupId { get; set; }

    // A list from day one, not a single field - matches issue #12 (multiple credentials
    // per host, including env-var injection) even though that UI doesn't exist yet; avoids
    // a breaking schema change later.
    public List<CredentialRecord> Credentials { get; set; } = [];

    // References SnippetRecord ids (the Snippets vault subfolder) - resolved to actual
    // command text client-side at connect time, not stored here, so editing a snippet's
    // command later is reflected the next time this host connects instead of being frozen
    // at whatever it said when attached.
    public List<string> StartupSnippetIds { get; set; } = [];
}

public sealed class CredentialRecord
{
    public required string Id { get; set; }
    public required string Kind { get; set; } // "password" | "privateKey" | "envVar"
    public string? Username { get; set; }
    public string? Secret { get; set; } // password, private key contents, or "NAME=value"
    public string? Passphrase { get; set; } // only meaningful when Kind is "privateKey"
}

/// <summary>A saved, reusable command - copyable into a terminal (see AGENTS.md's Snippets note).</summary>
public sealed class SnippetRecord
{
    public required string Name { get; set; }
    public required string Command { get; set; }
}

/// <summary>
/// A saved SSH private key, reusable across hosts/Quick Connect without re-entering or
/// re-pasting it each time (the Keychain nav section).
/// </summary>
public sealed class KeychainEntryRecord
{
    public required string Name { get; set; }
    public required string PrivateKey { get; set; }
    public string? Passphrase { get; set; }
}

/// <summary>
/// An append-only record of a connection attempt/outcome. Best-effort: only written when
/// the vault happens to be unlocked at the time (Quick Connect must keep working with no
/// vault at all - see AGENTS.md's Logs note), never required for a connection to proceed.
/// </summary>
public sealed class LogEntryRecord
{
    public required string Event { get; set; } // "connected" | "connect_failed" | "disconnected"
    public required string Host { get; set; }
    public required int Port { get; set; }
    public required string Username { get; set; }
    public string? Detail { get; set; } // error message, for connect_failed
}

/// <summary>
/// A remembered ad hoc ("Quick Connect") destination, keyed by host:port:username. Unlike
/// LogEntryRecord (host/port/username only, deliberately never a credential) this actually
/// retains the credential that was used, so reconnecting from the Recent list works with
/// one click/double-click the same way a saved Host does - a plain connection log can't
/// do that without storing secrets in a place meant to survive forever and be exported
/// unencrypted-adjacent. Only ad hoc connects (Quick Connect, or reconnecting to an
/// existing Recent) upsert one of these; connecting via an already-saved Host does not,
/// since that credential already lives permanently in HostRecord and doesn't need a
/// second copy here. VaultService.UpsertRecentConnection caps the total count and evicts
/// the oldest beyond it.
/// </summary>
public sealed class RecentConnectionRecord
{
    public required string Host { get; set; }
    public required int Port { get; set; }
    public required string Username { get; set; }
    public required string AuthMethod { get; set; } // "password" | "privateKey"
    public string? Secret { get; set; } // password or private key contents
    public string? Passphrase { get; set; } // only meaningful when AuthMethod is "privateKey"
}

/// <summary>
/// One entry in OpenTabsRecord - enough of a ConnectRequest to reconnect a tab that was
/// still open the last time the app closed. Same "retains the credential" trade-off as
/// RecentConnectionRecord, for the same reason: there's no other way to reconnect
/// automatically on the next launch.
/// </summary>
public sealed class OpenTabRecord
{
    public required string Kind { get; set; } // "ssh" | "sftp"
    public required string Label { get; set; }
    public required string Host { get; set; }
    public required int Port { get; set; }
    public required string Username { get; set; }
    public required string AuthMethod { get; set; } // "password" | "privateKey"
    public string? Secret { get; set; }
    public string? Passphrase { get; set; }

    // Resolved command text (see HostRecord.StartupSnippetIds), snapshotted at connect
    // time same as the credential above - a restart replays whatever ran the first time,
    // even if the underlying snippet was since edited/deleted.
    public List<string> StartupCommands { get; set; } = [];
}

/// <summary>
/// secrets/open-tabs.json - a single fixed-id record (like GithubTokenRecord), snapshotting
/// every currently-open tab. Rewritten wholesale on every add/remove/reconnect rather than
/// upserted piecemeal (there's no natural per-tab identity to key on across restarts), so
/// the app can restore the exact tab set - and which one was active - on the next launch.
/// </summary>
public sealed class OpenTabsRecord
{
    public List<OpenTabRecord> Tabs { get; set; } = [];
    public int? ActiveIndex { get; set; }
}

/// <summary>
/// A GitHub personal access token, used only to call the GitHub API when checking for/
/// downloading app updates (see UpdateService) - gwdevhub/terminal is a private repo, so
/// unauthenticated requests 404. Stored encrypted like any other secret (unlike
/// AppSettings, which must stay plaintext/readable pre-unlock) since it's a real
/// credential, just a narrow-purpose one.
/// </summary>
public sealed class GithubTokenRecord
{
    public required string Token { get; set; }
}

/// <summary>
/// settings.json - plaintext, never encrypted, lives alongside vault.json. Must be
/// readable/writable regardless of whether a vault exists yet or is unlocked, since it's
/// what decides whether to prompt for a master password at all (see AGENTS.md's Settings
/// note on what "optional master password" actually means cryptographically).
/// </summary>
public sealed class AppSettings
{
    // Off by default - a brand-new install auto-unlocks immediately with no prompt at
    // all (see VaultService.EnsureUnlockedIfPasswordNotRequired). Users who want real
    // protection opt in via the Settings page.
    public bool RequireMasterPassword { get; set; }

    // Off by default - closing the app window quits slopterm outright, the normal desktop
    // expectation. When on, closing the window instead minimizes it and leaves the app
    // running behind its tray icon (see AppWindowManager's window-closing handler). Only
    // has an effect where that native window/tray model exists (currently Windows).
    public bool CloseToTray { get; set; }
}
