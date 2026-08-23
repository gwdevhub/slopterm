namespace Slopterm.Server;

public sealed class ConnectRequest
{
    public required string Host { get; set; }
    public int Port { get; set; } = 22;
    public required string Username { get; set; }

    /// <summary>"password" or "privateKey".</summary>
    public string AuthMethod { get; set; } = "password";
    public string? Password { get; set; }
    public string? PrivateKey { get; set; }
    public string? Passphrase { get; set; }

    public int Columns { get; set; } = 80;
    public int Rows { get; set; } = 24;

    /// <summary>
    /// The saved host's id, when this connection is to one (null for Quick Connect / Recent).
    /// Lets the connect endpoint bring that host's port forwards up automatically - see
    /// ForwardingService.
    /// </summary>
    public string? HostId { get; set; }

    /// <summary>
    /// Which of the host's credentials to use, when it has more than one. Only meaningful
    /// alongside HostId, and only when the request carries no secret of its own - the
    /// backend then resolves it (see CredentialResolver), which is what lets the frontend
    /// hold no host secrets at all.
    /// </summary>
    public string? CredentialId { get; set; }

    /// <summary>
    /// Names a Keychain entry to connect with, for a request that isn't tied to a saved host
    /// (Quick Connect's "use a saved key"). Resolved by NAME through the same
    /// CredentialResolver a synced host uses, so the frontend never has to hold the key -
    /// which is what lets the Keychain listing mask it.
    /// </summary>
    public string? KeychainName { get; set; }
}

/// <summary>Open a shell on the machine slopterm itself is running on.</summary>
public sealed class LocalShellRequest
{
    /// <summary>
    /// Which shell to run. Null or empty means the OS default - see LocalShell.Resolve, which
    /// is also where $SHELL and the SLOPTERM_LOCAL_SHELL override are honoured.
    /// </summary>
    public string? Shell { get; set; }

    public int Columns { get; set; } = 80;
    public int Rows { get; set; } = 24;
}

public sealed class VaultPasswordRequest
{
    public required string MasterPassword { get; set; }
}

public sealed class SetRequireMasterPasswordRequest
{
    public required bool Required { get; set; }
    public string? CurrentPassword { get; set; } // needed when turning protection off
    public string? NewPassword { get; set; } // needed when turning protection on
}

public sealed class SetCloseToTrayRequest
{
    public required bool Enabled { get; set; }
}

public sealed class SetShowSshConfigHostsRequest
{
    public required bool Enabled { get; set; }
}

public sealed class SetSessionNotificationBadgeRequest
{
    public required bool Enabled { get; set; }
}

public sealed class ImportHostShareRequest
{
    public required string Token { get; set; }
}

/// <summary>
/// Create/update a collection. Every field except Name is nullable on update and means
/// "leave it alone" - which is what lets the edit form show a password field it never
/// fills in, and still save the rest of the form without wiping the stored password.
/// </summary>
public sealed class CollectionRequest
{
    public string? Name { get; set; }
    public string? RemoteUrl { get; set; }
    public string? Username { get; set; }
    public string? Password { get; set; }
    public List<string>? Scopes { get; set; }
    public bool? Enabled { get; set; }
}

public sealed class JoinCollectionRequest
{
    public required string Token { get; set; }
    public string? Passphrase { get; set; }
}

public sealed class LeaveCollectionRequest
{
    // On by default: leaving a team collection must not silently take every host it carried
    // off this device too.
    public bool KeepRecordsLocally { get; set; } = true;
}

/// <summary>Moves one record between collections - "share this host with the team".</summary>
public sealed class MoveRecordRequest
{
    public required string CollectionId { get; set; }
}

/// <summary>
/// The schedule half of a job the user is still editing, for /api/jobs/schedule-preview. A
/// separate type from JobRecord rather than reusing it: the form asks for this while the
/// command, host and name may all still be empty, and none of them affect the answer.
/// Defaults mirror JobRecord's so an omitted field previews what saving would actually do.
/// </summary>
public sealed class SchedulePreviewRequest
{
    public string ScheduleKind { get; set; } = "interval";
    public int IntervalMinutes { get; set; } = 60;
    public string DailyTime { get; set; } = "06:00";
    public string? CronExpression { get; set; }
}

public sealed class SetGithubTokenRequest
{
    // Null/empty clears it.
    public string? Token { get; set; }
}

public sealed class SetAiSettingsRequest
{
    // Null/empty on either field means "reset to the default" (local Ollama / its default model).
    public string? BaseUrl { get; set; }
    public string? Model { get; set; }

    // The endpoint's optional bearer token, which - unlike the two above - is a secret and is
    // never read back out, so "leave it as it is" needs its own value: null (or an absent
    // field) keeps whatever is stored, "" clears it, anything else replaces it. That's what
    // lets the agent bar's model switcher POST baseUrl+model without wiping the key.
    public string? ApiKey { get; set; }
}

public sealed class UpdateApplyRequest
{
    public required long AssetId { get; set; }
    public required string ExpectedSha256 { get; set; }
}

public sealed class TerminalResizeRequest
{
    public required int Cols { get; set; }
    public required int Rows { get; set; }
}

public sealed class SftpUploadRequest
{
    public required string LocalPath { get; set; }
    public required string RemoteDir { get; set; }
}

public sealed class SftpDownloadRequest
{
    public required string RemotePath { get; set; }
    public required string LocalDir { get; set; }
}

// Rename/delete/mkdir on the remote side operate on an SFTP session (path is the target
// entry; NewName/Name are leaf names, never full paths, so nothing can escape the parent).
public sealed class SftpRenameRequest
{
    public required string Path { get; set; }
    public required string NewName { get; set; }
}

public sealed class SftpDeleteRequest
{
    public required string Path { get; set; }
}

public sealed class SftpMakeDirectoryRequest
{
    public required string ParentDir { get; set; }
    public required string Name { get; set; }
}

// The local-side equivalents - same shapes, but they need no session (they hit the
// machine running slopterm directly, gated the same way /api/local/list is).
public sealed class LocalRenameRequest
{
    public required string Path { get; set; }
    public required string NewName { get; set; }
}

public sealed class LocalDeleteRequest
{
    public required string Path { get; set; }
}

public sealed class LocalMakeDirectoryRequest
{
    public required string ParentDir { get; set; }
    public required string Name { get; set; }
}
