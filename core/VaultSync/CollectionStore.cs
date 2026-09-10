using System.Security.Cryptography;
using System.Text.Json;
using Slopterm.Server.Vault;

namespace Slopterm.Server.VaultSync;

/// <summary>One record read out of the vault: its envelope metadata plus decrypted JSON.</summary>
public sealed record StoredRecord(string CollectionId, string Id, DateTimeOffset UpdatedAt, string Hlc, string Json);

/// <summary>
/// Owns where every record lands on disk. The implicit <c>local</c> collection keeps records at
/// their historical paths; others mirror the layout under <c>collections/{collectionId}/</c>.
/// All of it is vault-key encrypted at rest; the collection key only encrypts wire data.
/// </summary>
/// <param name="clock">This device's HLC. Injected so tests can run two independent "devices" in one process.</param>
public sealed class CollectionStore(string vaultDir, Func<byte[]?> keyAccessor, HybridLogicalClock? clock = null)
{
    private readonly HybridLogicalClock _clock = clock ?? HybridLogicalClock.Shared;

    public const string LocalCollectionId = "local";

    private const string CollectionsFolder = "collections";
    private const string CollectionFile = "collection.json";
    private const string TombstonesFolder = "tombstones";

    // Collection ids are 128 bits of hex we generate ourselves, but they arrive from pasted
    // tokens too - so they're validated before ever reaching a path, rather than trusted.
    private static bool IsValidCollectionId(string id) =>
        id.Length is > 0 and <= 64 && id.All(c => char.IsAsciiLetterOrDigit(c) || c == '-');

    /// <summary>This device's clock, so the sync loop stamps and observes through the same one.</summary>
    public HybridLogicalClock Clock => _clock;

    private byte[] RequireKey() =>
        keyAccessor() ?? throw new InvalidOperationException("Vault is locked.");

    // --- paths ---------------------------------------------------------------------------

    public string CollectionDirectory(string collectionId) =>
        collectionId == LocalCollectionId
            ? vaultDir
            : Path.Combine(vaultDir, CollectionsFolder, Validated(collectionId));

    private string RecordDirectory(string collectionId, string folder) =>
        Path.Combine(CollectionDirectory(collectionId), folder);

    private static string Validated(string collectionId) =>
        IsValidCollectionId(collectionId)
            ? collectionId
            : throw new ArgumentException($"Not a valid collection id: {collectionId}");

    // --- collections ---------------------------------------------------------------------

    /// <summary>Every non-local collection this device holds. Never includes <c>local</c> - that one is implicit.</summary>
    public IReadOnlyList<string> ListCollectionIds()
    {
        var root = Path.Combine(vaultDir, CollectionsFolder);
        if (!Directory.Exists(root))
        {
            return [];
        }

        return Directory.EnumerateDirectories(root)
            .Select(Path.GetFileName)
            .Where(name => !string.IsNullOrEmpty(name) && IsValidCollectionId(name))
            .Select(name => name!)
            .Order(StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>Null when the collection doesn't exist, is unreadable, or the vault is locked.</summary>
    public CollectionRecord? GetCollection(string collectionId)
    {
        if (collectionId == LocalCollectionId || keyAccessor() is null)
        {
            return null;
        }

        var path = Path.Combine(CollectionDirectory(collectionId), CollectionFile);
        return ReadEncrypted<CollectionRecord>(path);
    }

    public void SaveCollection(string collectionId, CollectionRecord record)
    {
        var directory = CollectionDirectory(collectionId);
        Directory.CreateDirectory(directory);
        WriteEncrypted(Path.Combine(directory, CollectionFile), record);
    }

    /// <summary>
    /// Removes the collection and its records from this device only - "leave" must never delete
    /// the shared content everyone else uses.
    /// </summary>
    public void DeleteCollection(string collectionId)
    {
        var directory = CollectionDirectory(collectionId);
        if (collectionId != LocalCollectionId && Directory.Exists(directory))
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    // --- records -------------------------------------------------------------------------

    /// <summary>Every record of one kind across all collections, each tagged with its origin.</summary>
    public IReadOnlyList<StoredRecord> ListAll(string folder)
    {
        var results = new List<StoredRecord>(ListRecords(LocalCollectionId, folder));
        foreach (var collectionId in ListCollectionIds())
        {
            results.AddRange(ListRecords(collectionId, folder));
        }

        return results;
    }

    public IReadOnlyList<StoredRecord> ListRecords(string collectionId, string folder)
    {
        var key = RequireKey();
        var directory = RecordDirectory(collectionId, folder);
        if (!Directory.Exists(directory))
        {
            return [];
        }

        var results = new List<StoredRecord>();
        foreach (var path in Directory.EnumerateFiles(directory, "*.json"))
        {
            var record = TryReadRecord(key, collectionId, path);
            if (record is not null)
            {
                results.Add(record);
            }
        }

        return results;
    }

    public StoredRecord? GetRecord(string collectionId, string folder, string id)
    {
        var path = Path.Combine(RecordDirectory(collectionId, folder), $"{SafeId(id)}.json");
        return File.Exists(path) ? TryReadRecord(RequireKey(), collectionId, path) : null;
    }

    /// <summary>Which collection currently holds this record id, or null if nothing does.</summary>
    public string? FindCollectionOf(string folder, string id)
    {
        if (File.Exists(Path.Combine(RecordDirectory(LocalCollectionId, folder), $"{SafeId(id)}.json")))
        {
            return LocalCollectionId;
        }

        return ListCollectionIds()
            .FirstOrDefault(cid => File.Exists(Path.Combine(RecordDirectory(cid, folder), $"{SafeId(id)}.json")));
    }

    /// <summary>
    /// Writes a record, stamping a fresh HLC unless the caller supplies one (a merge does, so a
    /// pulled record keeps its author's clock reading).
    /// </summary>
    public string SaveRecord(string collectionId, string folder, string? id, string json, string? hlc = null)
    {
        var key = RequireKey();
        var directory = RecordDirectory(collectionId, folder);
        Directory.CreateDirectory(directory);

        id = SafeId(id ?? Guid.NewGuid().ToString("N"));
        var (nonce, ciphertext) = VaultCrypto.Encrypt(key, json);
        var envelope = new RecordEnvelope
        {
            Id = id,
            UpdatedAt = DateTimeOffset.UtcNow,
            Nonce = Convert.ToBase64String(nonce),
            Ciphertext = Convert.ToBase64String(ciphertext),
            Hlc = hlc ?? _clock.Now().ToString(),
        };

        WriteAtomic(Path.Combine(directory, $"{id}.json"), JsonSerializer.Serialize(envelope));

        // A record coming back after a delete must clear the tombstone, or the next pull
        // would faithfully re-delete it.
        DeleteTombstone(collectionId, id);
        return id;
    }

    /// <summary>
    /// Deletes a record, leaving a tombstone in synced collections so offline devices don't
    /// re-upload it. The local collection never syncs, so it gets none.
    /// </summary>
    public bool DeleteRecord(string collectionId, string folder, string id, string recordType)
    {
        var path = Path.Combine(RecordDirectory(collectionId, folder), $"{SafeId(id)}.json");
        var existed = File.Exists(path);
        if (existed)
        {
            File.Delete(path);
        }

        if (collectionId != LocalCollectionId)
        {
            SaveTombstone(collectionId, new SyncTombstone
            {
                Id = SafeId(id),
                Type = recordType,
                Hlc = _clock.Now().ToString(),
                DeletedAt = DateTimeOffset.UtcNow,
            });
        }

        return existed;
    }

    /// <summary>
    /// Moves a record between collections; written to the destination first, so a crash
    /// duplicates rather than loses it.
    /// </summary>
    public void MoveRecord(string fromCollectionId, string toCollectionId, string folder, string id, string recordType)
    {
        if (fromCollectionId == toCollectionId)
        {
            return;
        }

        var record = GetRecord(fromCollectionId, folder, id)
            ?? throw new InvalidOperationException("That record no longer exists.");
        SaveRecord(toCollectionId, folder, id, record.Json);
        DeleteRecord(fromCollectionId, folder, id, recordType);
    }

    // --- tombstones ----------------------------------------------------------------------

    public IReadOnlyList<SyncTombstone> ListTombstones(string collectionId)
    {
        var directory = Path.Combine(CollectionDirectory(collectionId), TombstonesFolder);
        if (!Directory.Exists(directory) || keyAccessor() is null)
        {
            return [];
        }

        var results = new List<SyncTombstone>();
        foreach (var path in Directory.EnumerateFiles(directory, "*.json"))
        {
            var tombstone = ReadEncrypted<SyncTombstone>(path);
            if (tombstone is not null)
            {
                results.Add(tombstone);
            }
        }

        return results;
    }

    public void SaveTombstone(string collectionId, SyncTombstone tombstone)
    {
        var directory = Path.Combine(CollectionDirectory(collectionId), TombstonesFolder);
        Directory.CreateDirectory(directory);
        WriteEncrypted(Path.Combine(directory, $"{SafeId(tombstone.Id)}.json"), tombstone);
    }

    public void DeleteTombstone(string collectionId, string id)
    {
        var path = Path.Combine(CollectionDirectory(collectionId), TombstonesFolder, $"{SafeId(id)}.json");
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }

    /// <summary>
    /// Drops tombstones older than <paramref name="maxAge"/>; the window must exceed how long a
    /// device can stay offline holding the record.
    /// </summary>
    public int GcTombstones(string collectionId, TimeSpan maxAge)
    {
        var cutoff = DateTimeOffset.UtcNow - maxAge;
        var removed = 0;
        foreach (var tombstone in ListTombstones(collectionId).Where(t => t.DeletedAt < cutoff))
        {
            DeleteTombstone(collectionId, tombstone.Id);
            removed++;
        }

        return removed;
    }

    // --- re-keying -----------------------------------------------------------------------

    /// <summary>Every encrypted file this store owns, for VaultService's master-key change.</summary>
    public IEnumerable<string> EnumerateEncryptedFiles()
    {
        foreach (var collectionId in ListCollectionIds())
        {
            var directory = CollectionDirectory(collectionId);
            foreach (var path in Directory.EnumerateFiles(directory, "*.json", SearchOption.AllDirectories))
            {
                yield return path;
            }
        }
    }

    // --- helpers -------------------------------------------------------------------------

    // Ids arrive from pasted tokens and remote listings, so path-escaping ones are rejected.
    private static string SafeId(string id)
    {
        if (string.IsNullOrWhiteSpace(id) || id.Length > 128 ||
            id.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '-' && c != '_'))
        {
            throw new ArgumentException($"Not a valid record id: {id}");
        }

        return id;
    }

    private StoredRecord? TryReadRecord(byte[] key, string collectionId, string path)
    {
        try
        {
            var envelope = JsonSerializer.Deserialize<RecordEnvelope>(File.ReadAllText(path));
            if (envelope is null)
            {
                return null;
            }

            var json = VaultCrypto.Decrypt(
                key, Convert.FromBase64String(envelope.Nonce), Convert.FromBase64String(envelope.Ciphertext));
            return new StoredRecord(collectionId, envelope.Id, envelope.UpdatedAt, envelope.Hlc ?? string.Empty, json);
        }
        catch (Exception ex) when (ex is JsonException or FormatException or CryptographicException or ArgumentException)
        {
            // One unreadable file must not take a whole collection's listing down with it -
            // the same posture the rest of the vault already takes for corrupt records.
            return null;
        }
    }

    private T? ReadEncrypted<T>(string path) where T : class
    {
        var key = keyAccessor();
        if (key is null || !File.Exists(path))
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

            var json = VaultCrypto.Decrypt(
                key, Convert.FromBase64String(envelope.Nonce), Convert.FromBase64String(envelope.Ciphertext));
            return JsonSerializer.Deserialize<T>(json, SyncJson.Options);
        }
        catch (Exception ex) when (ex is JsonException or FormatException or CryptographicException or ArgumentException)
        {
            return null;
        }
    }

    private void WriteEncrypted<T>(string path, T value)
    {
        var (nonce, ciphertext) = VaultCrypto.Encrypt(RequireKey(), JsonSerializer.Serialize(value, SyncJson.Options));
        var envelope = new RecordEnvelope
        {
            Id = Path.GetFileNameWithoutExtension(path),
            UpdatedAt = DateTimeOffset.UtcNow,
            Nonce = Convert.ToBase64String(nonce),
            Ciphertext = Convert.ToBase64String(ciphertext),
        };
        WriteAtomic(path, JsonSerializer.Serialize(envelope));
    }

    /// <summary>Temp file then move, because a half-written record is a corrupt vault.</summary>
    internal static void WriteAtomic(string path, string contents)
    {
        // The temp name deliberately avoids a ".json" ending: Windows 8.3 short-name matching
        // makes the "*.json" globs match "record.json.tmp" too.
        var temporary = Path.Combine(
            Path.GetDirectoryName(path)!, $"~{Guid.NewGuid():N}.tmp");
        File.WriteAllText(temporary, contents);
        File.Move(temporary, path, overwrite: true);
    }
}
