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
