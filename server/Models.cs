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

public sealed class ImportHostShareRequest
{
    public required string Token { get; set; }
}

public sealed class SetGithubTokenRequest
{
    // Null/empty clears it.
    public string? Token { get; set; }
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
