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
/// settings.json - plaintext, never encrypted, lives alongside vault.json. Must be
/// readable/writable regardless of whether a vault exists yet or is unlocked, since it's
/// what decides whether to prompt for a master password at all (see AGENTS.md's Settings
/// note on what "optional master password" actually means cryptographically).
/// </summary>
public sealed class AppSettings
{
    public bool RequireMasterPassword { get; set; } = true;
}
