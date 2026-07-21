using System.Security.Cryptography;
using System.Text.Json;

namespace Slopterm.Server.Vault;

public sealed class VaultService
{
    private const string CanaryPlaintext = "slopterm-vault-ok";

    private readonly string _vaultDir;
    private readonly string _metadataPath;

    // In-memory only for the life of the process - never written to disk, never logged.
    private byte[]? _key;

    public VaultService()
    {
        _vaultDir = AppPaths.GetVaultDirectory();
        _metadataPath = Path.Combine(_vaultDir, "vault.json");
    }

    public bool Exists => File.Exists(_metadataPath);
    public bool IsUnlocked => _key is not null;

    public void Setup(string masterPassword)
    {
        if (Exists)
        {
            throw new InvalidOperationException("Vault already exists - use unlock instead.");
        }

        Directory.CreateDirectory(_vaultDir);

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

    public IReadOnlyList<(string Id, DateTimeOffset UpdatedAt, HostRecord Record)> ListHosts() => ListRecords<HostRecord>("hosts");
    public string SaveHost(string? id, HostRecord record) => SaveRecord("hosts", id, record);
    public bool DeleteHost(string id) => DeleteRecord("hosts", id);

    public IReadOnlyList<(string Id, DateTimeOffset UpdatedAt, SnippetRecord Record)> ListSnippets() => ListRecords<SnippetRecord>("snippets");
    public string SaveSnippet(string? id, SnippetRecord record) => SaveRecord("snippets", id, record);
    public bool DeleteSnippet(string id) => DeleteRecord("snippets", id);

    public IReadOnlyList<(string Id, DateTimeOffset UpdatedAt, LogEntryRecord Record)> ListLogs() =>
        ListRecords<LogEntryRecord>("logs").OrderByDescending(l => l.UpdatedAt).ToList();

    /// <summary>Best-effort: silently does nothing if the vault is locked (see LogEntryRecord's doc comment).</summary>
    public void AppendLog(LogEntryRecord entry)
    {
        if (!IsUnlocked)
        {
            return;
        }

        SaveRecord("logs", null, entry);
    }

    public void ClearLogs()
    {
        RequireUnlocked();
        var dir = Path.Combine(_vaultDir, "logs");
        if (Directory.Exists(dir))
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private IReadOnlyList<(string Id, DateTimeOffset UpdatedAt, T Record)> ListRecords<T>(string subfolder)
    {
        RequireUnlocked();

        var dir = Path.Combine(_vaultDir, subfolder);
        if (!Directory.Exists(dir))
        {
            return [];
        }

        var results = new List<(string, DateTimeOffset, T)>();
        foreach (var path in Directory.EnumerateFiles(dir, "*.json"))
        {
            var envelope = JsonSerializer.Deserialize<RecordEnvelope>(File.ReadAllText(path));
            if (envelope is null)
            {
                continue;
            }

            var json = VaultCrypto.Decrypt(_key!, Convert.FromBase64String(envelope.Nonce), Convert.FromBase64String(envelope.Ciphertext));
            var record = JsonSerializer.Deserialize<T>(json)!;
            results.Add((envelope.Id, envelope.UpdatedAt, record));
        }

        return results;
    }

    private string SaveRecord<T>(string subfolder, string? id, T record)
    {
        RequireUnlocked();
        var dir = Path.Combine(_vaultDir, subfolder);
        Directory.CreateDirectory(dir);

        id ??= Guid.NewGuid().ToString("N");
        var json = JsonSerializer.Serialize(record);
        var (nonce, ciphertext) = VaultCrypto.Encrypt(_key!, json);

        var envelope = new RecordEnvelope
        {
            Id = id,
            UpdatedAt = DateTimeOffset.UtcNow,
            Nonce = Convert.ToBase64String(nonce),
            Ciphertext = Convert.ToBase64String(ciphertext),
        };
        File.WriteAllText(Path.Combine(dir, $"{id}.json"), JsonSerializer.Serialize(envelope));
        return id;
    }

    private bool DeleteRecord(string subfolder, string id)
    {
        RequireUnlocked();
        var path = Path.Combine(_vaultDir, subfolder, $"{id}.json");
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
