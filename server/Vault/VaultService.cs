using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace Slopterm.Server.Vault;

public sealed class VaultService
{
    private const string CanaryPlaintext = "slopterm-vault-ok";

    private readonly string _vaultDir;
    private readonly string _metadataPath;
    private readonly string _settingsPath;

    // In-memory only for the life of the process - never written to disk, never logged.
    private byte[]? _key;

    public VaultService()
    {
        _vaultDir = AppPaths.GetVaultDirectory();
        _metadataPath = Path.Combine(_vaultDir, "vault.json");
        _settingsPath = Path.Combine(_vaultDir, "settings.json");
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
        WriteMetadata(salt, key);
        _key = key;
    }

    /// <returns>false if the master password is wrong; throws if the vault doesn't exist.</returns>
    public bool Unlock(string masterPassword)
    {
        if (!Exists)
        {
            throw new InvalidOperationException("Vault does not exist - use setup instead.");
        }

        if (!TryDeriveAndVerify(masterPassword, out var key))
        {
            return false;
        }

        _key = key;
        return true;
    }

    public void Lock() => _key = null;

    /// <summary>
    /// Called once at app startup. If settings say a master password isn't required, this
    /// transparently creates/unlocks the vault with a fixed, non-secret key (see
    /// VaultCrypto.NoPasswordSeed) so the frontend never shows an unlock prompt at all -
    /// nothing else needs to know this mode exists, since /api/vault/status will just
    /// already report "unlocked".
    /// </summary>
    public void EnsureUnlockedIfPasswordNotRequired()
    {
        if (GetSettings().RequireMasterPassword || IsUnlocked)
        {
            return;
        }

        if (Exists)
        {
            Unlock(VaultCrypto.NoPasswordSeed);
        }
        else
        {
            Setup(VaultCrypto.NoPasswordSeed);
        }
    }

    public AppSettings GetSettings()
    {
        if (!File.Exists(_settingsPath))
        {
            return new AppSettings();
        }

        return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(_settingsPath)) ?? new AppSettings();
    }

    /// <summary>
    /// Toggles whether a master password is required, re-keying the entire vault to match
    /// (the actual encryption key changes between "derived from a real password" and
    /// "derived from the fixed, non-secret NoPasswordSeed" - see AGENTS.md's Settings note).
    /// </summary>
    public void SetRequireMasterPassword(bool required, string? currentPassword, string? newPassword)
    {
        var settings = GetSettings();
        if (required == settings.RequireMasterPassword)
        {
            return;
        }

        if (required)
        {
            if (string.IsNullOrEmpty(newPassword))
            {
                throw new ArgumentException("A new master password is required to enable password protection.");
            }

            EnsureUnlockedIfPasswordNotRequired();
            ChangeMasterKey(newPassword);
        }
        else
        {
            if (string.IsNullOrEmpty(currentPassword) || !TryDeriveAndVerify(currentPassword, out _))
            {
                throw new UnauthorizedAccessException("Incorrect master password.");
            }

            ChangeMasterKey(VaultCrypto.NoPasswordSeed);
        }

        settings.RequireMasterPassword = required;
        Directory.CreateDirectory(_vaultDir);
        File.WriteAllText(_settingsPath, JsonSerializer.Serialize(settings));
    }

    /// <summary>
    /// Persists whether closing the app window minimizes it to the tray (leaving the app
    /// running) instead of quitting outright. A plain settings.json write - unlike
    /// RequireMasterPassword it changes no encryption key, so there's nothing to re-key,
    /// and it needs no unlock (settings.json is always plaintext/readable).
    /// </summary>
    public void SetCloseToTray(bool enabled)
    {
        var settings = GetSettings();
        if (enabled == settings.CloseToTray)
        {
            return;
        }

        settings.CloseToTray = enabled;
        Directory.CreateDirectory(_vaultDir);
        File.WriteAllText(_settingsPath, JsonSerializer.Serialize(settings));
    }

    /// <summary>
    /// Re-encrypts every existing record (hosts/snippets/logs/...) and vault.json's canary
    /// with a newly derived key. Records are re-keyed before vault.json is overwritten, so
    /// a crash partway through never leaves records unreadable by either the old or new key.
    /// </summary>
    private void ChangeMasterKey(string newDerivationInput)
    {
        RequireUnlocked();
        var oldKey = _key!;

        var newSalt = RandomNumberGenerator.GetBytes(VaultCrypto.SaltSizeBytes);
        var newKey = VaultCrypto.DeriveKey(
            newDerivationInput, newSalt, VaultCrypto.Argon2Iterations, VaultCrypto.Argon2MemoryKb, VaultCrypto.Argon2Parallelism);

        if (Directory.Exists(_vaultDir))
        {
            foreach (var dir in Directory.EnumerateDirectories(_vaultDir))
            {
                foreach (var path in Directory.EnumerateFiles(dir, "*.json"))
                {
                    var envelope = JsonSerializer.Deserialize<RecordEnvelope>(File.ReadAllText(path));
                    if (envelope is null)
                    {
                        continue;
                    }

                    var plaintext = VaultCrypto.Decrypt(
                        oldKey, Convert.FromBase64String(envelope.Nonce), Convert.FromBase64String(envelope.Ciphertext));
                    var (newNonce, newCiphertext) = VaultCrypto.Encrypt(newKey, plaintext);
                    envelope.Nonce = Convert.ToBase64String(newNonce);
                    envelope.Ciphertext = Convert.ToBase64String(newCiphertext);
                    File.WriteAllText(path, JsonSerializer.Serialize(envelope));
                }
            }
        }

        WriteMetadata(newSalt, newKey);
        _key = newKey;
    }

    /// <summary>
    /// Packages vault.json, settings.json, and every record file into a zip - the whole
    /// point is that it's just already-encrypted bytes copied as-is, so exporting never
    /// needs the vault to be unlocked (zero-knowledge: the backend doesn't need the key
    /// either). settings.json is included so an imported vault's "requires a password"
    /// state always matches how its records were actually encrypted, rather than being
    /// silently overridden by whatever the importing machine's local settings said.
    /// </summary>
    public byte[] ExportBackup()
    {
        if (!Exists)
        {
            throw new InvalidOperationException("No vault exists yet to export.");
        }

        using var ms = new MemoryStream();
        using (var archive = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            archive.CreateEntryFromFile(_metadataPath, "vault.json");
            if (File.Exists(_settingsPath))
            {
                archive.CreateEntryFromFile(_settingsPath, "settings.json");
            }

            if (Directory.Exists(_vaultDir))
            {
                foreach (var dir in Directory.EnumerateDirectories(_vaultDir))
                {
                    var subfolder = Path.GetFileName(dir);
                    foreach (var file in Directory.EnumerateFiles(dir, "*.json"))
                    {
                        archive.CreateEntryFromFile(file, $"{subfolder}/{Path.GetFileName(file)}");
                    }
                }
            }
        }

        return ms.ToArray();
    }

    /// <summary>
    /// Replaces the entire vault directory with the contents of a previously exported
    /// backup. Extracts into a temp staging directory first and validates every entry
    /// resolves inside it (guards against a corrupt/malicious zip using "../" path
    /// traversal - a.k.a. zip slip) before touching the real vault directory at all, so a
    /// bad upload can't leave the vault half-replaced. Locks first (the in-memory key
    /// almost certainly doesn't match the newly imported vault.json), then immediately
    /// re-runs EnsureUnlockedIfPasswordNotRequired so an imported vault that doesn't
    /// require a password auto-unlocks right away instead of sitting locked until the
    /// next full app restart.
    /// </summary>
    public void ImportBackup(byte[] zipBytes)
    {
        using var ms = new MemoryStream(zipBytes);
        using var archive = new ZipArchive(ms, ZipArchiveMode.Read);

        // Staged as a *sibling* of the vault directory (not the system temp directory) so
        // the final Directory.Move below is guaranteed to land on the same filesystem -
        // Directory.Move throws (Linux: "Invalid cross-device link") if the source and
        // destination are on different volumes, which the system temp dir isn't
        // guaranteed to share with wherever the vault directory actually lives.
        var stagingParent = Path.GetDirectoryName(Path.GetFullPath(_vaultDir)) ?? Path.GetTempPath();
        var stagingDir = Path.Combine(stagingParent, ".slopterm-import-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stagingDir);
        var fullStagingDir = Path.GetFullPath(stagingDir);

        try
        {
            foreach (var entry in archive.Entries)
            {
                if (string.IsNullOrEmpty(entry.Name))
                {
                    continue; // directory entry
                }

                var destPath = Path.GetFullPath(Path.Combine(stagingDir, entry.FullName));
                if (!destPath.StartsWith(fullStagingDir + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("Backup contains an invalid file path.");
                }

                Directory.CreateDirectory(Path.GetDirectoryName(destPath)!);
                entry.ExtractToFile(destPath, overwrite: true);
            }

            if (!File.Exists(Path.Combine(stagingDir, "vault.json")))
            {
                throw new InvalidOperationException("Not a valid slopterm vault backup - missing vault.json.");
            }

            Lock();
            if (Directory.Exists(_vaultDir))
            {
                Directory.Delete(_vaultDir, recursive: true);
            }

            Directory.Move(stagingDir, _vaultDir);
        }
        finally
        {
            if (Directory.Exists(stagingDir))
            {
                Directory.Delete(stagingDir, recursive: true);
            }
        }

        EnsureUnlockedIfPasswordNotRequired();
    }

    /// <summary>
    /// Wipes the vault directory entirely (every host/snippet/keychain entry/log, plus
    /// settings.json) and returns to the exact state a brand-new install starts in -
    /// including re-running EnsureUnlockedIfPasswordNotRequired so a default install ends
    /// up auto-unlocked again immediately, not just "no vault at all." Deliberately does
    /// NOT require the vault to already be unlocked - this is the recovery path for
    /// someone who's locked themselves out and just wants to start fresh.
    /// </summary>
    public void ResetToDefault()
    {
        Lock();
        if (Directory.Exists(_vaultDir))
        {
            Directory.Delete(_vaultDir, recursive: true);
        }

        EnsureUnlockedIfPasswordNotRequired();
    }

    private void WriteMetadata(byte[] salt, byte[] key)
    {
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
    }

    private bool TryDeriveAndVerify(string password, out byte[] key)
    {
        var metadata = JsonSerializer.Deserialize<VaultMetadata>(File.ReadAllText(_metadataPath))
            ?? throw new InvalidOperationException("Vault metadata is corrupt.");
        var salt = Convert.FromBase64String(metadata.Salt);
        key = VaultCrypto.DeriveKey(password, salt, metadata.Iterations, metadata.MemoryKb, metadata.Parallelism);

        try
        {
            var canaryPlaintext = VaultCrypto.Decrypt(
                key, Convert.FromBase64String(metadata.CanaryNonce), Convert.FromBase64String(metadata.CanaryCiphertext));
            return canaryPlaintext == CanaryPlaintext;
        }
        catch (CryptographicException)
        {
            // Wrong password - AES-GCM's authentication tag won't verify.
            return false;
        }
    }

    private const string GithubTokenRecordId = "github-token";

    /// <summary>Null if locked, unset, or the vault doesn't exist yet - never throws.</summary>
    public string? GetGithubToken()
    {
        if (!IsUnlocked)
        {
            return null;
        }

        var path = Path.Combine(_vaultDir, "secrets", $"{GithubTokenRecordId}.json");
        if (!File.Exists(path))
        {
            return null;
        }

        var envelope = JsonSerializer.Deserialize<RecordEnvelope>(File.ReadAllText(path));
        if (envelope is null)
        {
            return null;
        }

        var json = VaultCrypto.Decrypt(_key!, Convert.FromBase64String(envelope.Nonce), Convert.FromBase64String(envelope.Ciphertext));
        return JsonSerializer.Deserialize<GithubTokenRecord>(json)?.Token;
    }

    public void SetGithubToken(string? token)
    {
        RequireUnlocked();
        if (string.IsNullOrEmpty(token))
        {
            DeleteRecord("secrets", GithubTokenRecordId);
            return;
        }

        SaveRecord("secrets", GithubTokenRecordId, new GithubTokenRecord { Token = token });
    }

    private const string OpenTabsRecordId = "open-tabs";

    /// <summary>Empty if locked or nothing saved yet - never throws (this drives app startup).</summary>
    public OpenTabsRecord GetOpenTabs()
    {
        if (!IsUnlocked)
        {
            return new OpenTabsRecord();
        }

        var path = Path.Combine(_vaultDir, "secrets", $"{OpenTabsRecordId}.json");
        if (!File.Exists(path))
        {
            return new OpenTabsRecord();
        }

        var envelope = JsonSerializer.Deserialize<RecordEnvelope>(File.ReadAllText(path));
        if (envelope is null)
        {
            return new OpenTabsRecord();
        }

        var json = VaultCrypto.Decrypt(_key!, Convert.FromBase64String(envelope.Nonce), Convert.FromBase64String(envelope.Ciphertext));
        return JsonSerializer.Deserialize<OpenTabsRecord>(json) ?? new OpenTabsRecord();
    }

    /// <summary>Best-effort, same as AppendLog/UpsertRecentConnection - silently no-ops if locked.</summary>
    public void SaveOpenTabs(OpenTabsRecord record)
    {
        if (!IsUnlocked)
        {
            return;
        }

        SaveRecord("secrets", OpenTabsRecordId, record);
    }

    public IReadOnlyList<(string Id, DateTimeOffset UpdatedAt, HostRecord Record)> ListHosts() => ListRecords<HostRecord>("hosts");
    public string SaveHost(string? id, HostRecord record) => SaveRecord("hosts", id, record);
    public bool DeleteHost(string id) => DeleteRecord("hosts", id);

    public IReadOnlyList<(string Id, DateTimeOffset UpdatedAt, SnippetRecord Record)> ListSnippets() => ListRecords<SnippetRecord>("snippets");
    public string SaveSnippet(string? id, SnippetRecord record) => SaveRecord("snippets", id, record);
    public bool DeleteSnippet(string id) => DeleteRecord("snippets", id);

    public IReadOnlyList<(string Id, DateTimeOffset UpdatedAt, KeychainEntryRecord Record)> ListKeychainEntries() =>
        ListRecords<KeychainEntryRecord>("keychain");
    public string SaveKeychainEntry(string? id, KeychainEntryRecord record) => SaveRecord("keychain", id, record);
    public bool DeleteKeychainEntry(string id) => DeleteRecord("keychain", id);

    public IReadOnlyList<(string Id, DateTimeOffset UpdatedAt, PortForwardRecord Record)> ListPortForwards() =>
        ListRecords<PortForwardRecord>("port-forwards");
    public string SavePortForward(string? id, PortForwardRecord record) => SaveRecord("port-forwards", id, record);
    public bool DeletePortForward(string id) => DeleteRecord("port-forwards", id);

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

    private const int MaxRecentConnections = 5;

    public IReadOnlyList<(string Id, DateTimeOffset UpdatedAt, RecentConnectionRecord Record)> ListRecentConnections() =>
        ListRecords<RecentConnectionRecord>("recent-connections").OrderByDescending(r => r.UpdatedAt).ToList();

    /// <summary>
    /// Best-effort, same as AppendLog. Upserts by host:port:username (case-insensitive
    /// host/username) so reconnecting to the same destination refreshes its position and
    /// credential instead of piling up duplicate entries, then trims down to
    /// MaxRecentConnections, oldest first.
    /// </summary>
    public void UpsertRecentConnection(RecentConnectionRecord entry)
    {
        if (!IsUnlocked)
        {
            return;
        }

        var existing = ListRecords<RecentConnectionRecord>("recent-connections");
        var match = existing.FirstOrDefault(e =>
            string.Equals(e.Record.Host, entry.Host, StringComparison.OrdinalIgnoreCase) &&
            e.Record.Port == entry.Port &&
            string.Equals(e.Record.Username, entry.Username, StringComparison.OrdinalIgnoreCase));

        SaveRecord("recent-connections", match.Id, entry);

        var afterSave = ListRecords<RecentConnectionRecord>("recent-connections").OrderByDescending(e => e.UpdatedAt).ToList();
        foreach (var stale in afterSave.Skip(MaxRecentConnections))
        {
            DeleteRecord("recent-connections", stale.Id);
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
