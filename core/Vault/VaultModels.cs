using System.Text.Json;
using Slopterm.Server.Ai;

namespace Slopterm.Server.Vault;

/// <summary>vault.json - never contains secrets, just what's needed to derive/verify the key.</summary>
public sealed class VaultMetadata
{
    public required string Salt { get; set; }
    public required int Iterations { get; set; }
    public required int MemoryKb { get; set; }
    public required int Parallelism { get; set; }

    // AES-GCM(key, "slopterm-vault-ok") canary - lets unlock fail as "wrong password"
    // instead of a per-record decrypt failure.
    public required string CanaryNonce { get; set; }
    public required string CanaryCiphertext { get; set; }
}

/// <summary>
/// {subfolder}/{id}.json on disk (hosts/snippets/logs all share this shape). Id and UpdatedAt
/// stay outside the ciphertext so sync/merge can compare records without decrypting them.
/// </summary>
public sealed class RecordEnvelope
{
    public required string Id { get; set; }
    public required DateTimeOffset UpdatedAt { get; set; }
    public required string Nonce { get; set; }
    public required string Ciphertext { get; set; }

    // Hybrid logical clock (see VaultSync/HybridLogicalClock). Nullable because records
    // written before sync existed read as the epoch; stamped on every save regardless.
    public string? Hlc { get; set; }
}

/// <summary>The decrypted content of a HostEnvelope.</summary>
public sealed class HostRecord
{
    public required string Name { get; set; }
    public required string Address { get; set; }
    public int Port { get; set; } = 22;
    public string? ParentGroupId { get; set; }

    // A list from day one, not a single field, to allow multiple credentials per host
    // later without a breaking schema change.
    public List<CredentialRecord> Credentials { get; set; } = [];

    // References SnippetRecord ids, resolved to command text at connect time, so editing
    // a snippet is reflected the next time this host connects.
    public List<string> StartupSnippetIds { get; set; } = [];
}

public sealed class CredentialRecord
{
    public required string Id { get; set; }

    /// <summary>
    /// "password" | "privateKey" | "envVar" | "keychain". "keychain" carries no secret,
    /// only <see cref="KeychainName"/>, resolved locally per device (see CredentialResolver).
    /// </summary>
    public required string Kind { get; set; }

    public string? Username { get; set; }
    public string? Secret { get; set; } // password, private key contents, or "NAME=value"
    public string? Passphrase { get; set; } // only meaningful when Kind is "privateKey"

    /// <summary>Names a KeychainEntryRecord by Name, so it resolves to a different local entry per device.</summary>
    public string? KeychainName { get; set; }
}

/// <summary>
/// An SSH port-forward rule through a saved host. "local" binds here and tunnels out;
/// "remote" has the server bind and tunnels back (the xdebug case). AutoStart brings it up
/// at launch; rules also come up when a terminal/SFTP session to the host opens.
/// </summary>
public sealed class PortForwardRecord
{
    public required string HostId { get; set; }
    public required string Type { get; set; } // "local" | "remote"
    public string BindAddress { get; set; } = "127.0.0.1";
    public required int BindPort { get; set; }
    public required string DestinationAddress { get; set; }
    public required int DestinationPort { get; set; }
    public string? Description { get; set; }
    public bool AutoStart { get; set; }
}

/// <summary>
/// A folder sync rule between LocalPath and RemotePath over SFTP (see SyncService).
/// </summary>
public sealed class SyncRuleRecord
{
    public required string HostId { get; set; }
    public required string LocalPath { get; set; }
    public required string RemotePath { get; set; }
    public string? Description { get; set; }
    public bool AutoStart { get; set; }

    // "localToRemote", "remoteToLocal" (SFTP has no notify, so this polls), or "twoWay"
    // (last-writer-wins on conflicting changes, not real conflict handling).
    public string Direction { get; set; } = "localToRemote";

    // Off = additive/copy-only; on (default) mirrors deletions too.
    public bool DeleteExtraneous { get; set; } = true;

    // On (default) skips files whose size and modified time already match at the destination.
    public bool SkipUnchanged { get; set; } = true;
}

/// <summary>
/// A command run against a saved host on a schedule (see SchedulerService). Best-effort:
/// only fires while slopterm is running, not installed into cron/systemd.
/// </summary>
public sealed class JobRecord
{
    public required string HostId { get; set; }
    public required string Name { get; set; }

    // Exactly one of the two: literal text, or a SnippetRecord id resolved at run time.
    public string? Command { get; set; }
    public string? SnippetId { get; set; }

    // "interval", "daily", or "cron" - all local time. The simple kinds stay because cron
    // can't express "every 90 minutes"; cron covers everything else.
    public string ScheduleKind { get; set; } = "interval";
    public int IntervalMinutes { get; set; } = 60;
    public string DailyTime { get; set; } = "06:00"; // "HH:mm", local time

    // Standard 5-field cron plus @daily/@weekly/@hourly macros (Cronos, see
    // SchedulerService.NextRunUtcAfter). Only read when ScheduleKind is "cron".
    public string? CronExpression { get; set; }

    public bool Enabled { get; set; } = true;

    // Off (default) skips a job whose time passed while closed; on runs it once at pickup
    // (systemd's Persistent=true convention).
    public bool RunOnStart { get; set; }

    // When a run is still going: "skip", "queue" (at most one queued), or "kill".
    public string OverlapPolicy { get; set; } = "skip";

    // Hard ceiling on one run. A job that hangs forever otherwise holds a connection and,
    // under "skip", silently stops the schedule dead.
    public int TimeoutSeconds { get; set; } = 300;

    // Optional .NET regex over the run's combined stdout+stderr; a match marks the run failed
    // even on exit 0.
    public string? FailurePattern { get; set; }

    // Which install owns this job, or null for "any device". Prevents a synced job running twice.
    public string? OwnerDeviceId { get; set; }
}

/// <summary>One completed run of a JobRecord, kept in that job's JobRunHistoryRecord.</summary>
public sealed class JobRunRecord
{
    public required DateTimeOffset StartedUtc { get; set; }
    public required DateTimeOffset FinishedUtc { get; set; }

    // "success", "failed" (non-zero exit or a FailurePattern match), or "error" (never ran
    // to completion).
    public required string Outcome { get; set; }
    public int? ExitCode { get; set; }
    public string? Error { get; set; } // only for "error" - why it never produced an exit code
    public string? Output { get; set; }
    public string? ErrorOutput { get; set; }
    public bool Truncated { get; set; }
}

/// <summary>job-runs/{jobId}.json - a capped, newest-first history of one job's runs.</summary>
public sealed class JobRunHistoryRecord
{
    public List<JobRunRecord> Runs { get; set; } = [];
}

/// <summary>A saved, reusable command - copyable into a terminal (see AGENTS.md's Snippets note).</summary>
public sealed class SnippetRecord
{
    public required string Name { get; set; }
    public required string Command { get; set; }
}

/// <summary>A saved SSH private key, reusable across hosts/Quick Connect (the Keychain section).</summary>
public sealed class KeychainEntryRecord
{
    public required string Name { get; set; }
    public required string PrivateKey { get; set; }
    public string? Passphrase { get; set; }
}

/// <summary>
/// Best-effort record of a connection attempt/outcome, written only when the vault is
/// unlocked at the time.
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
/// A remembered ad hoc ("Quick Connect") destination keyed by host:port:username. Unlike
/// LogEntryRecord it retains the credential, so reconnecting is one click. Upserted only for
/// ad hoc connects; VaultService caps the count.
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
/// still open at last close. Retains the credential, like RecentConnectionRecord.
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

    // Resolved command text, snapshotted at connect time (see HostRecord.StartupSnippetIds).
    public List<string> StartupCommands { get; set; } = [];

    // The backend session id this tab was attached to; a page reload can reattach if the
    // session is still listed. Not a credential, an opaque per-process GUID.
    public string? SessionId { get; set; }

    // For a tab on a saved host these replace the credential snapshot: the frontend asks the
    // backend to resolve the host's credential again (see CredentialResolver).
    public string? HostId { get; set; }
    public string? CredentialId { get; set; }
}

/// <summary>secrets/open-tabs.json - a single fixed-id record snapshotting every open tab.</summary>
public sealed class OpenTabsRecord
{
    public List<OpenTabRecord> Tabs { get; set; } = [];
    public int? ActiveIndex { get; set; }
}

/// <summary>
/// A GitHub PAT used to raise the rate limit when checking for/downloading updates (see
/// UpdateService). Stored encrypted like any other secret.
/// </summary>
public sealed class GithubTokenRecord
{
    public required string Token { get; set; }
}

/// <summary>
/// The bearer token for the AI agent's endpoint (secrets/ai-api-key.json). Optional; hosted
/// endpoints need it, a local Ollama doesn't. Stored encrypted as a real credential.
/// </summary>
public sealed class AiApiKeyRecord
{
    public required string Key { get; set; }
}

/// <summary>
/// One AI agent conversation transcript (ai-chats/{id}.json); a host can have many.
/// HostKey/Title are nullable because older records (id = host-key hash) are still adopted.
/// </summary>
public sealed class AiChatRecord
{
    public string? HostKey { get; set; } // "user@host:port", lowercase - which host's list this belongs to
    public string? Title { get; set; }   // first user message, truncated - the list label
    public required List<ChatMessage> Messages { get; set; }
}

/// <summary>
/// preferences/preferences.json - the syncable half of what used to live in settings.json,
/// plus the old appearance blob. settings.json keeps its copy as the pre-unlock fallback.
/// </summary>
public sealed class PreferencesRecord
{
    public bool CloseToTray { get; set; }
    public bool ShowSshConfigHosts { get; set; }
    public bool SessionNotificationBadge { get; set; }
    // Empty means "no AI endpoint configured", which is how the agent stays off until asked
    // for: with no URL there is no bar on a terminal tab at all (see AgentBar).
    public string AiBaseUrl { get; set; } = string.Empty;

    // Stored opaquely, exactly as GetAppearance/SaveAppearance already did, so the theme
    // schema can keep evolving entirely client-side.
    public JsonElement? Appearance { get; set; }
}

/// <summary>
/// settings.json - plaintext, never encrypted, readable regardless of vault unlock state,
/// since it decides whether to prompt for a master password at all.
/// </summary>
public sealed class AppSettings
{
    // Off by default - a new install auto-unlocks with no prompt (see
    // VaultService.EnsureUnlockedIfPasswordNotRequired).
    public bool RequireMasterPassword { get; set; }

    // Off by default - closing the window quits. When on, it hides to the tray instead
    // (see AppWindowManager). Windows only.
    public bool CloseToTray { get; set; }

    // Off by default - when on, Hosts also lists ~/.ssh/config aliases read-only (see SshConfigService).
    public bool ShowSshConfigHosts { get; set; }

    // Off by default - when on, the Android keep-alive notification channel badges the
    // launcher icon (see SessionKeepAliveService). Android only.
    public bool SessionNotificationBadge { get; set; }

    // The in-terminal AI agent talks to an OpenAI-compatible server; empty keeps it off.
    // Plaintext settings (a URL isn't secret); the optional API key lives in the vault.
    public string AiBaseUrl { get; set; } = string.Empty;
}
