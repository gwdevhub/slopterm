using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using Slopterm.Server.Ai;
using Slopterm.Server.VaultSync;

namespace Slopterm.Server.Vault;

public sealed class VaultService
{
    private const string CanaryPlaintext = "slopterm-vault-ok";

    private readonly string _vaultDir;
    private readonly string _metadataPath;
    private readonly string _settingsPath;

    // In-memory only for the life of the process - never written to disk, never logged.
    private byte[]? _key;

    /// <param name="clock">
    /// This install's hybrid logical clock. Defaults to the process-wide one keyed to this
    /// device's id, which is right for the app - there is one device per process. Tests pass
    /// their own so two "devices" in one process are genuinely independent rather than
    /// sharing a clock no real pair of devices ever would.
    /// </param>
    /// <param name="vaultDirectory">
    /// Where this vault lives. Defaults to <see cref="AppPaths.GetVaultDirectory"/>, which is
    /// what the app uses. Passing it explicitly is how a test runs two vaults in one process
    /// without reaching for the SLOPTERM_VAULT_DIR environment variable - process-global
    /// mutable state that every other vault in the process shares, and which nothing can make
    /// safe once more than one of them exists.
    /// </param>
    public VaultService(HybridLogicalClock? clock = null, string? vaultDirectory = null)
    {
        _vaultDir = vaultDirectory ?? AppPaths.GetVaultDirectory();
        _metadataPath = Path.Combine(_vaultDir, "vault.json");
        _settingsPath = Path.Combine(_vaultDir, "settings.json");
        Collections = new CollectionStore(_vaultDir, () => _key, clock);
    }

    public bool Exists => File.Exists(_metadataPath);
    public bool IsUnlocked => _key is not null;

    /// <summary>
    /// Where records actually live, per collection. Every typed accessor below goes through
    /// this - the `local` collection is just "the vault directory as it always was", so a
    /// vault with no collections behaves byte-for-byte the way it did before sync existed.
    /// </summary>
    public CollectionStore Collections { get; }

    /// <summary>
    /// Raised after any record changes, with the collection that changed. VaultSyncService
    /// subscribes to debounce a push; nothing else may throw out of it, since a subscriber
    /// blowing up would take the save that triggered it with it.
    /// </summary>
    public event Action<string>? RecordChanged;

    private void NotifyChanged(string collectionId)
    {
        try
        {
            RecordChanged?.Invoke(collectionId);
        }
        catch
        {
            // A sync trigger failing must never fail the save that raised it.
        }
    }

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

        // Deliberately NOT swallowed into defaults: settings.json carries RequireMasterPassword,
        // so silently treating a corrupt/older-format file as "all defaults" could unlock a
        // password-protected vault. Fail closed instead, with a message that names the file and
        // the fix (it's non-secret and safe to delete) - the crash reporter surfaces it, rather
        // than a raw System.Text.Json stack trace nobody can act on.
        AppSettings settings;
        try
        {
            settings = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(_settingsPath)) ?? new AppSettings();
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException(
                $"settings.json is corrupt or from an incompatible version and can't be read ({_settingsPath}). " +
                "It holds only non-secret app preferences - delete it to reset to defaults, then relaunch.", ex);
        }

        // Everything except RequireMasterPassword now lives in the vault-stored preferences
        // record so it can sync (see PreferencesRecord). settings.json keeps a copy purely
        // as the pre-unlock fallback, which is what this returns while locked.
        if (IsUnlocked && GetPreferences() is { } preferences)
        {
            settings.CloseToTray = preferences.CloseToTray;
            settings.ShowSshConfigHosts = preferences.ShowSshConfigHosts;
            settings.SessionNotificationBadge = preferences.SessionNotificationBadge;
            settings.AiBaseUrl = preferences.AiBaseUrl;
            settings.AiModel = preferences.AiModel;
        }

        return settings;
    }

    private const string PreferencesFolder = "preferences";
    private const string PreferencesRecordId = "preferences";

    /// <summary>
    /// The syncable preferences, migrating settings.json's values (and the old
    /// secrets/appearance record) into one on first read so an existing install keeps every
    /// toggle it had. Null only when the vault is locked.
    /// </summary>
    public PreferencesRecord? GetPreferences()
    {
        if (!IsUnlocked)
        {
            return null;
        }

        var stored = Collections.ListAll(PreferencesFolder)
            .FirstOrDefault(r => r.Id == PreferencesRecordId);
        if (stored is not null)
        {
            var parsed = TryDeserialize<PreferencesRecord>(stored.Json);
            if (parsed is not null)
            {
                return parsed;
            }
        }

        AppSettings fromFile;
        try
        {
            fromFile = File.Exists(_settingsPath)
                ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(_settingsPath)) ?? new AppSettings()
                : new AppSettings();
        }
        catch (JsonException)
        {
            fromFile = new AppSettings();
        }

        var migrated = new PreferencesRecord
        {
            CloseToTray = fromFile.CloseToTray,
            ShowSshConfigHosts = fromFile.ShowSshConfigHosts,
            SessionNotificationBadge = fromFile.SessionNotificationBadge,
            AiBaseUrl = fromFile.AiBaseUrl,
            AiModel = fromFile.AiModel,
            Appearance = ReadLegacyAppearance(),
        };
        SavePreferences(migrated);
        return migrated;
    }

    /// <summary>
    /// Writes the preferences record AND mirrors the same values back into settings.json,
    /// so the pre-unlock read and an older build both still see the user's choices.
    /// </summary>
    public void SavePreferences(PreferencesRecord preferences)
    {
        RequireUnlocked();
        var collectionId = Collections.FindCollectionOf(PreferencesFolder, PreferencesRecordId)
            ?? CollectionStore.LocalCollectionId;
        Collections.SaveRecord(collectionId, PreferencesFolder, PreferencesRecordId, JsonSerializer.Serialize(preferences));
        NotifyChanged(collectionId);
        MirrorPreferencesToSettingsFile(preferences);
    }

    private void MirrorPreferencesToSettingsFile(PreferencesRecord preferences)
    {
        AppSettings settings;
        try
        {
            settings = File.Exists(_settingsPath)
                ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(_settingsPath)) ?? new AppSettings()
                : new AppSettings();
        }
        catch (JsonException)
        {
            return; // a corrupt settings.json is handled by GetSettings, not silently rewritten here
        }

        settings.CloseToTray = preferences.CloseToTray;
        settings.ShowSshConfigHosts = preferences.ShowSshConfigHosts;
        settings.SessionNotificationBadge = preferences.SessionNotificationBadge;
        settings.AiBaseUrl = preferences.AiBaseUrl;
        settings.AiModel = preferences.AiModel;
        Directory.CreateDirectory(_vaultDir);
        File.WriteAllText(_settingsPath, JsonSerializer.Serialize(settings));
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
    /// Persists whether closing the app window hides it to the tray (leaving the app
    /// running) instead of quitting outright. A plain settings.json write - unlike
    /// RequireMasterPassword it changes no encryption key, so there's nothing to re-key,
    /// and it needs no unlock (settings.json is always plaintext/readable).
    /// </summary>
    public void SetCloseToTray(bool enabled)
    {
        UpdatePreferences(p => p.CloseToTray = enabled, s => s.CloseToTray = enabled);
    }

    /// <summary>
    /// Persists whether the Hosts screen also lists ~/.ssh/config aliases as read-only
    /// cards (see SshConfigService). Same shape as SetCloseToTray - no encryption key
    /// changes, no unlock needed.
    /// </summary>
    public void SetShowSshConfigHosts(bool enabled)
    {
        UpdatePreferences(p => p.ShowSshConfigHosts = enabled, s => s.ShowSshConfigHosts = enabled);
    }

    /// <summary>
    /// Applies a change to the preferences record, or - with the vault locked - straight to
    /// settings.json. The locked path matters: these toggles were always usable without an
    /// unlock, and moving them into the vault must not quietly take that away.
    /// </summary>
    private void UpdatePreferences(Action<PreferencesRecord> applyToRecord, Action<AppSettings> applyToFile)
    {
        if (GetPreferences() is { } preferences)
        {
            applyToRecord(preferences);
            SavePreferences(preferences);
            return;
        }

        var settings = GetSettings();
        applyToFile(settings);
        Directory.CreateDirectory(_vaultDir);
        File.WriteAllText(_settingsPath, JsonSerializer.Serialize(settings));
    }

    /// <summary>
    /// Persists whether the Android keep-alive notification is allowed to badge the launcher
    /// icon (see SessionKeepAliveService, which picks its notification channel from this).
    /// Same shape as SetCloseToTray - no encryption key changes, no unlock needed.
    /// </summary>
    public void SetSessionNotificationBadge(bool enabled)
    {
        UpdatePreferences(p => p.SessionNotificationBadge = enabled, s => s.SessionNotificationBadge = enabled);
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

        // Recursive, unlike before: collections/{cid}/… nests one level deeper than the
        // original record folders, and its collection.json/identity.json/members.json are
        // vault-encrypted too - missing them would leave a synced collection unreadable after
        // a password change, with its remote password and collection key stranded under the
        // old key.
        if (Directory.Exists(_vaultDir))
        {
            foreach (var path in EncryptedRecordFiles())
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
                CollectionStore.WriteAtomic(path, JsonSerializer.Serialize(envelope));
            }
        }

        WriteMetadata(newSalt, newKey);
        _key = newKey;
    }

    /// <summary>
    /// Every vault-encrypted record file, at any depth. Files sitting directly in the vault
    /// directory are deliberately excluded: vault.json, settings.json and window.json are
    /// device-local plaintext, and trying to read one as a RecordEnvelope is how a re-key
    /// blew up on an install that had simply moved its window.
    ///
    /// Materialized rather than enumerated lazily, because callers replace each file as they
    /// go (temp + move) and mutating a directory mid-enumeration can hand the same path back
    /// twice - which during a re-key would encrypt a record under the new key twice and leave
    /// it unreadable by anything.
    /// </summary>
    private string[] EncryptedRecordFiles() =>
        Directory.Exists(_vaultDir)
            ? [.. Directory.GetFiles(_vaultDir, "*.json", SearchOption.AllDirectories)
                .Where(path => Path.GetDirectoryName(path) != _vaultDir)]
            : [];

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

            // Recursive, so collections/{cid}/… travels with the backup - restoring a vault
            // that silently dropped every synced collection would be worse than not
            // exporting at all. Root-level files are excluded for the same reason a re-key
            // skips them: they describe this device, not its records.
            foreach (var file in EncryptedRecordFiles())
            {
                var relative = Path.GetRelativePath(_vaultDir, file).Replace(Path.DirectorySeparatorChar, '/');
                archive.CreateEntryFromFile(file, relative);
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

            var deviceId = ReadDeviceId();
            Lock();
            if (Directory.Exists(_vaultDir))
            {
                Directory.Delete(_vaultDir, recursive: true);
            }

            Directory.Move(stagingDir, _vaultDir);
            RestoreDeviceId(deviceId);
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
        var deviceId = ReadDeviceId();
        Lock();
        if (Directory.Exists(_vaultDir))
        {
            Directory.Delete(_vaultDir, recursive: true);
        }

        RestoreDeviceId(deviceId);
        EnsureUnlockedIfPasswordNotRequired();
    }

    // device-id identifies the MACHINE, not the vault contents (see DeviceIdentity), so it
    // survives both wipes above - it lives in the vault directory only because that's where
    // this app's per-install state goes. Losing it would silently strand every scheduled job
    // pinned to this device, including after restoring your own backup onto the same machine,
    // and would leave the running process's cached id disagreeing with the file on disk.
    // Import still can't carry one IN: ExportBackup never packages it, so a backup restored
    // on a second machine keeps that machine's own identity.
    private string? ReadDeviceId()
    {
        var path = Path.Combine(_vaultDir, "device-id");
        return File.Exists(path) ? File.ReadAllText(path) : null;
    }

    private void RestoreDeviceId(string? deviceId)
    {
        if (deviceId is null)
        {
            return;
        }

        Directory.CreateDirectory(_vaultDir);
        File.WriteAllText(Path.Combine(_vaultDir, "device-id"), deviceId);
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

    private const string AiChatsFolder = "ai-chats";

    /// <summary>
    /// All persisted AI conversations (every host's - the caller filters by HostKey). All
    /// four AI-chat methods are best-effort by design (like AppendLog): a locked vault just
    /// means chats don't persist/restore/list, never an error in the agent path.
    /// </summary>
    public IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, AiChatRecord Record)> ListAiChats()
    {
        if (!IsUnlocked)
        {
            return [];
        }

        try
        {
            return ListRecords<AiChatRecord>(AiChatsFolder);
        }
        catch
        {
            return [];
        }
    }

    /// <summary>One persisted conversation, or null if locked/missing/corrupt - never throws.</summary>
    public AiChatRecord? GetAiChat(string id)
    {
        if (!IsUnlocked)
        {
            return null;
        }

        try
        {
            var path = Path.Combine(_vaultDir, AiChatsFolder, $"{id}.json");
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
            return JsonSerializer.Deserialize<AiChatRecord>(json);
        }
        catch
        {
            return null; // a corrupt/unreadable record reads as "no saved chat"
        }
    }

    public void SaveAiChat(string id, AiChatRecord record)
    {
        if (!IsUnlocked)
        {
            return;
        }

        try
        {
            SaveRecord(AiChatsFolder, id, record);
        }
        catch
        {
            // best-effort - a failed save must never break the agent turn that triggered it
        }
    }

    public void DeleteAiChat(string id)
    {
        try
        {
            DeleteRecord(AiChatsFolder, id);
        }
        catch
        {
            // best-effort
        }
    }

    /// <summary>
    /// Persists the AI agent's endpoint/model. A plain settings.json write like SetCloseToTray -
    /// a loopback URL and a model name aren't secrets, and needing no unlock means the agent is
    /// configurable even with a locked vault.
    /// </summary>
    public void SetAiSettings(string baseUrl, string model)
    {
        UpdatePreferences(
            p => { p.AiBaseUrl = baseUrl; p.AiModel = model; },
            s => { s.AiBaseUrl = baseUrl; s.AiModel = model; });
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

        // Genuinely never throw (this runs at startup, before there's any UI to surface an
        // error): a restored-tabs record left over from an older/incompatible build - bad
        // JSON, bad base64, or ciphertext this key can't decrypt - must degrade to "no tabs
        // to restore", never take startup down. It's non-critical convenience data.
        try
        {
            var envelope = JsonSerializer.Deserialize<RecordEnvelope>(File.ReadAllText(path));
            if (envelope is null)
            {
                return new OpenTabsRecord();
            }

            var json = VaultCrypto.Decrypt(_key!, Convert.FromBase64String(envelope.Nonce), Convert.FromBase64String(envelope.Ciphertext));
            return JsonSerializer.Deserialize<OpenTabsRecord>(json) ?? new OpenTabsRecord();
        }
        catch (Exception ex) when (ex is JsonException or FormatException or CryptographicException or ArgumentException)
        {
            return new OpenTabsRecord();
        }
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

    private const string AppearanceRecordId = "appearance";

    /// <summary>
    /// The synced appearance (colors + fonts) blob, or null if locked or nothing saved yet.
    /// Stored opaquely as the raw JSON the client sends (a JsonElement) so the theme schema
    /// can evolve entirely client-side without a backend change. Never throws - the client
    /// keeps a local cache for instant theming and treats null as "nothing to sync".
    /// </summary>
    public JsonElement? GetAppearance() => GetPreferences()?.Appearance ?? ReadLegacyAppearance();

    /// <summary>Best-effort - silently no-ops if locked (same contract as SaveOpenTabs).</summary>
    public void SaveAppearance(JsonElement settings)
    {
        if (GetPreferences() is not { } preferences)
        {
            return;
        }

        preferences.Appearance = settings;
        SavePreferences(preferences);
    }

    /// <summary>
    /// The pre-split location (secrets/appearance). Read once, on the migration into the
    /// preferences record, and left on disk afterwards so an older build downgraded onto the
    /// same vault still finds the theme it wrote.
    /// </summary>
    private JsonElement? ReadLegacyAppearance()
    {
        if (!IsUnlocked)
        {
            return null;
        }

        var path = Path.Combine(_vaultDir, "secrets", $"{AppearanceRecordId}.json");
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            var envelope = JsonSerializer.Deserialize<RecordEnvelope>(File.ReadAllText(path));
            if (envelope is null)
            {
                return null;
            }

            var json = VaultCrypto.Decrypt(_key!, Convert.FromBase64String(envelope.Nonce), Convert.FromBase64String(envelope.Ciphertext));
            return JsonSerializer.Deserialize<JsonElement>(json);
        }
        catch (Exception ex) when (ex is JsonException or FormatException or CryptographicException or ArgumentException)
        {
            return null;
        }
    }

    public IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, HostRecord Record)> ListHosts() =>
        ListRecords<HostRecord>("hosts");
    public string SaveHost(string? id, HostRecord record, string? collectionId = null) =>
        SaveRecord("hosts", id, record, collectionId);
    public bool DeleteHost(string id) => DeleteRecord("hosts", id);

    public IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, SnippetRecord Record)> ListSnippets() =>
        ListRecords<SnippetRecord>("snippets");
    public string SaveSnippet(string? id, SnippetRecord record, string? collectionId = null) =>
        SaveRecord("snippets", id, record, collectionId);
    public bool DeleteSnippet(string id) => DeleteRecord("snippets", id);

    public IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, KeychainEntryRecord Record)> ListKeychainEntries() =>
        ListRecords<KeychainEntryRecord>("keychain");
    public string SaveKeychainEntry(string? id, KeychainEntryRecord record, string? collectionId = null) =>
        SaveRecord("keychain", id, record, collectionId);
    public bool DeleteKeychainEntry(string id) => DeleteRecord("keychain", id);

    public IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, PortForwardRecord Record)> ListPortForwards() =>
        ListRecords<PortForwardRecord>("port-forwards");
    public string SavePortForward(string? id, PortForwardRecord record, string? collectionId = null) =>
        SaveRecord("port-forwards", id, record, collectionId);
    public bool DeletePortForward(string id) => DeleteRecord("port-forwards", id);

    public IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, SyncRuleRecord Record)> ListSyncRules() =>
        ListRecords<SyncRuleRecord>("sync-rules");
    public string SaveSyncRule(string? id, SyncRuleRecord record, string? collectionId = null) =>
        SaveRecord("sync-rules", id, record, collectionId);
    public bool DeleteSyncRule(string id) => DeleteRecord("sync-rules", id);

    // Jobs have no sync scope at all (a schedule is pinned to one device by OwnerDeviceId,
    // see JobRecord), so they only ever live in the local collection.
    public IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, JobRecord Record)> ListJobs() =>
        ListRecords<JobRecord>("jobs");
    public string SaveJob(string? id, JobRecord record) => SaveRecord("jobs", id, record);

    /// <summary>Drops the job's run history along with it - nothing else references it.</summary>
    public bool DeleteJob(string id)
    {
        DeleteRecord(JobRunsFolder, id);
        return DeleteRecord("jobs", id);
    }

    private const string JobRunsFolder = "job-runs";
    private const int MaxJobRuns = 20;
    private const int MaxRunOutputChars = 8_000;

    /// <summary>Newest-first, empty if locked/missing/corrupt - never throws (the scheduler polls this).</summary>
    public IReadOnlyList<JobRunRecord> ListJobRuns(string jobId)
    {
        if (!IsUnlocked)
        {
            return [];
        }

        try
        {
            var path = Path.Combine(_vaultDir, JobRunsFolder, $"{jobId}.json");
            if (!File.Exists(path))
            {
                return [];
            }

            var envelope = JsonSerializer.Deserialize<RecordEnvelope>(File.ReadAllText(path));
            if (envelope is null)
            {
                return [];
            }

            var json = VaultCrypto.Decrypt(_key!, Convert.FromBase64String(envelope.Nonce), Convert.FromBase64String(envelope.Ciphertext));
            return JsonSerializer.Deserialize<JobRunHistoryRecord>(json)?.Runs ?? [];
        }
        catch
        {
            return []; // a corrupt/unreadable history reads as "no runs recorded"
        }
    }

    /// <summary>
    /// Prepends a run to the job's history, truncating its captured output and evicting
    /// everything past MaxJobRuns. Best-effort like AppendLog: a locked vault (or a failed
    /// write) means the run isn't recorded, never that the run itself fails.
    /// </summary>
    public void AppendJobRun(string jobId, JobRunRecord run)
    {
        if (!IsUnlocked)
        {
            return;
        }

        try
        {
            var truncated = run.Truncated;
            run.Output = Truncate(run.Output, ref truncated);
            run.ErrorOutput = Truncate(run.ErrorOutput, ref truncated);
            run.Truncated = truncated;

            var history = new JobRunHistoryRecord { Runs = [run, .. ListJobRuns(jobId).Take(MaxJobRuns - 1)] };
            SaveRecord(JobRunsFolder, jobId, history);
        }
        catch
        {
            // best-effort - a failed history write must never break the run that triggered it
        }
    }

    public void ClearJobRuns(string jobId)
    {
        try
        {
            DeleteRecord(JobRunsFolder, jobId);
        }
        catch
        {
            // best-effort
        }
    }

    private static string? Truncate(string? text, ref bool truncated)
    {
        if (text is null || text.Length <= MaxRunOutputChars)
        {
            return text;
        }

        truncated = true;
        return text[..MaxRunOutputChars];
    }

    public IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, LogEntryRecord Record)> ListLogs() =>
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

    public IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, RecentConnectionRecord Record)> ListRecentConnections() =>
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

    /// <summary>
    /// Every record of one kind, across every collection this device holds, each tagged
    /// with where it came from. A vault with no collections yields exactly what it always
    /// did, with CollectionId = "local".
    /// </summary>
    private IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, T Record)> ListRecords<T>(string subfolder)
    {
        RequireUnlocked();
        var results = new List<(string, string, DateTimeOffset, T)>();
        foreach (var stored in Collections.ListAll(subfolder))
        {
            var record = TryDeserialize<T>(stored.Json);
            if (record is not null)
            {
                results.Add((stored.Id, stored.CollectionId, stored.UpdatedAt, record));
            }
        }

        return results;
    }

    /// <summary>
    /// Saves into <paramref name="collectionId"/> for a new record. Updating an EXISTING id
    /// always writes back to whichever collection already holds it, ignoring the argument -
    /// changing collection is a deliberate move (see <see cref="MoveRecord"/>), never a
    /// side effect of an edit that forgot to say where the record lived.
    /// </summary>
    private string SaveRecord<T>(string subfolder, string? id, T record, string? collectionId = null)
    {
        RequireUnlocked();
        var target = (id is null ? null : Collections.FindCollectionOf(subfolder, id))
            ?? collectionId
            ?? CollectionStore.LocalCollectionId;
        var saved = Collections.SaveRecord(target, subfolder, id, JsonSerializer.Serialize(record));
        NotifyChanged(target);
        return saved;
    }

    private bool DeleteRecord(string subfolder, string id, string? recordType = null)
    {
        RequireUnlocked();
        var collectionId = Collections.FindCollectionOf(subfolder, id);
        if (collectionId is null)
        {
            return false;
        }

        var deleted = Collections.DeleteRecord(collectionId, subfolder, id, recordType ?? subfolder);
        NotifyChanged(collectionId);
        return deleted;
    }

    /// <summary>
    /// Moves one record between collections - "share this host with the team", or pull it
    /// back out again. Both sides are notified so the collection it left writes its
    /// tombstone out and the one it joined pushes it.
    /// </summary>
    public void MoveRecord(string subfolder, string id, string toCollectionId)
    {
        RequireUnlocked();
        var from = Collections.FindCollectionOf(subfolder, id)
            ?? throw new InvalidOperationException("That record no longer exists.");
        if (from == toCollectionId)
        {
            return;
        }

        if (toCollectionId != CollectionStore.LocalCollectionId && Collections.GetCollection(toCollectionId) is null)
        {
            throw new InvalidOperationException("That collection doesn't exist on this device.");
        }

        Collections.MoveRecord(from, toCollectionId, subfolder, id, subfolder);
        NotifyChanged(from);
        NotifyChanged(toCollectionId);
    }

    private static T? TryDeserialize<T>(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<T>(json);
        }
        catch (JsonException)
        {
            // A record written by a newer/older build that this type can no longer read is
            // skipped rather than taking the whole listing down.
            return default;
        }
    }

    private void RequireUnlocked()
    {
        if (_key is null)
        {
            throw new InvalidOperationException("Vault is locked.");
        }
    }
}
