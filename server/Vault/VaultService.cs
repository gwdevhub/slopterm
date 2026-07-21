using System.Security.Cryptography;
using System.Text.Json;

namespace Slopterm.Server.Vault;

public sealed class VaultService
{
    private const string CanaryPlaintext = "slopterm-vault-ok";

    private readonly string _metadataPath;
    private readonly string _hostsDir;

    // In-memory only for the life of the process - never written to disk, never logged.
    private byte[]? _key;

    public VaultService()
    {
        var vaultDir = AppPaths.GetVaultDirectory();
        _metadataPath = Path.Combine(vaultDir, "vault.json");
        _hostsDir = Path.Combine(vaultDir, "hosts");
    }

    public bool Exists => File.Exists(_metadataPath);
    public bool IsUnlocked => _key is not null;

    public void Setup(string masterPassword)
    {
        if (Exists)
        {
            throw new InvalidOperationException("Vault already exists - use unlock instead.");
        }

        Directory.CreateDirectory(_hostsDir);

        var salt = RandomNumberGenerator.GetBytes(VaultCrypto.SaltSizeBytes);
        var key = VaultCrypto.DeriveKey(
            masterPassword, salt, VaultCrypto.Argon2Iterations, VaultCrypto.Argon2MemoryKb, VaultCrypto.Argon2Parallelism);
        var (canaryNonce, canaryCiphertext) = VaultCrypto.Encrypt(key, CanaryPlaintext);

        var metadata = new VaultMetadata
        {
            Salt = Convert.ToBase64String(salt),
            Iterations = VaultCrypto.Argon2Iterations,
            MemoryKb = VaultCrypto.Argon2MemoryKb,
            Parallelism = VaultCrypto.Argon2Parallelism,
            CanaryNonce = Convert.ToBase64String(canaryNonce),
            CanaryCiphertext = Convert.ToBase64String(canaryCiphertext),
        };
        File.WriteAllText(_metadataPath, JsonSerializer.Serialize(metadata));

        _key = key;
    }

    /// <returns>false if the master password is wrong; throws if the vault doesn't exist.</returns>
    public bool Unlock(string masterPassword)
    {
        if (!Exists)
        {
            throw new InvalidOperationException("Vault does not exist - use setup instead.");
        }

        var metadata = JsonSerializer.Deserialize<VaultMetadata>(File.ReadAllText(_metadataPath))
            ?? throw new InvalidOperationException("Vault metadata is corrupt.");
        var salt = Convert.FromBase64String(metadata.Salt);
        var key = VaultCrypto.DeriveKey(masterPassword, salt, metadata.Iterations, metadata.MemoryKb, metadata.Parallelism);

        try
        {
            var canaryPlaintext = VaultCrypto.Decrypt(
                key, Convert.FromBase64String(metadata.CanaryNonce), Convert.FromBase64String(metadata.CanaryCiphertext));
            if (canaryPlaintext != CanaryPlaintext)
            {
                return false;
            }
        }
        catch (CryptographicException)
        {
            // Wrong password - AES-GCM's authentication tag won't verify.
            return false;
        }

        _key = key;
        return true;
    }

    public void Lock() => _key = null;

    public IReadOnlyList<(string Id, DateTimeOffset UpdatedAt, HostRecord Record)> ListHosts()
    {
        RequireUnlocked();

        if (!Directory.Exists(_hostsDir))
        {
            return [];
        }

        var results = new List<(string, DateTimeOffset, HostRecord)>();
        foreach (var path in Directory.EnumerateFiles(_hostsDir, "*.json"))
        {
            var envelope = JsonSerializer.Deserialize<HostEnvelope>(File.ReadAllText(path));
            if (envelope is null)
            {
                continue;
            }

            var json = VaultCrypto.Decrypt(_key!, Convert.FromBase64String(envelope.Nonce), Convert.FromBase64String(envelope.Ciphertext));
            var record = JsonSerializer.Deserialize<HostRecord>(json)!;
            results.Add((envelope.Id, envelope.UpdatedAt, record));
        }

        return results;
    }

    public string SaveHost(string? id, HostRecord record)
    {
        RequireUnlocked();
        Directory.CreateDirectory(_hostsDir);

        id ??= Guid.NewGuid().ToString("N");
        var json = JsonSerializer.Serialize(record);
        var (nonce, ciphertext) = VaultCrypto.Encrypt(_key!, json);

        var envelope = new HostEnvelope
        {
            Id = id,
            UpdatedAt = DateTimeOffset.UtcNow,
            Nonce = Convert.ToBase64String(nonce),
            Ciphertext = Convert.ToBase64String(ciphertext),
        };
        File.WriteAllText(Path.Combine(_hostsDir, $"{id}.json"), JsonSerializer.Serialize(envelope));
        return id;
    }

    public bool DeleteHost(string id)
    {
        RequireUnlocked();
        var path = Path.Combine(_hostsDir, $"{id}.json");
        if (!File.Exists(path))
        {
            return false;
        }

        File.Delete(path);
        return true;
    }

    private void RequireUnlocked()
    {
        if (_key is null)
        {
            throw new InvalidOperationException("Vault is locked.");
        }
    }
}
