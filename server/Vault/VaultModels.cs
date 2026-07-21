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
/// hosts/{id}.json on disk. Id and UpdatedAt stay outside the ciphertext on purpose - a
/// future sync/merge process needs to compare records without decrypting them first (see
/// AGENTS.md's Vault section).
/// </summary>
public sealed class HostEnvelope
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
}
