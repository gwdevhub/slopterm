using System.Text.Json;

namespace Slopterm.Server.VaultSync;

/// <summary>
/// Which kinds of record a collection carries; a scope maps onto a vault subfolder and a remote
/// records/{type}/ folder. Logs, open tabs and the GitHub token deliberately have no scope.
/// </summary>
public sealed record SyncScope(string Name, string Folder, bool DefaultOn, string Label, string? Warning = null);

public static class SyncScopes
{
    public const string Hosts = "hosts";
    public const string Snippets = "snippets";
    public const string Keychain = "keychain";
    public const string PortForwards = "port-forwards";
    public const string SyncRules = "sync-rules";
    public const string Preferences = "preferences";
    public const string RecentConnections = "recent-connections";

    public static readonly IReadOnlyList<SyncScope> All =
    [
        new(Hosts, "hosts", true, "Hosts"),
        new(Snippets, "snippets", true, "Snippets"),
        new(PortForwards, "port-forwards", true, "Port forwards"),
        new(Keychain, "keychain", false, "Keychain (private keys)",
            "Everyone in this collection gets a copy of every private key it carries. Naming a key on a host instead shares the host without the key."),
        new(SyncRules, "sync-rules", false, "Folder sync rules",
            "Folder sync rules point at local paths, which rarely mean the same thing on someone else's machine."),
        new(Preferences, "preferences", false, "Preferences",
            "Appearance, the AI endpoint/model and UI toggles. Never the master-password setting - that describes this device's own vault."),
        new(RecentConnections, "recent-connections", false, "Recent connections",
            "Recent connections keep the credential that was used, so sharing them shares those secrets."),
    ];

    public static IReadOnlyList<string> Defaults => All.Where(s => s.DefaultOn).Select(s => s.Name).ToList();

    public static SyncScope? Find(string name) =>
        All.FirstOrDefault(s => string.Equals(s.Name, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>The vault subfolder a scope's records live in, or null if it isn't a scope at all.</summary>
    public static string? FolderFor(string scope) => Find(scope)?.Folder;
}

/// <summary>
/// collections/{cid}/collection.json - everything about one collection except its records,
/// vault-encrypted at rest. Access control belongs to the WebDAV server, not this app.
/// </summary>
public sealed class CollectionRecord
{
    public required string Name { get; set; }

    // Empty for a collection that exists only on this device (created but not yet pointed
    // at a share) - it just never syncs until a URL is set.
    public string RemoteUrl { get; set; } = string.Empty;

    // Two devices in one collection may use DIFFERENT accounts (or none) against the same folder.
    public string? RemoteUsername { get; set; }
    public string? RemotePassword { get; set; }

    public List<string> Scopes { get; set; } = [.. SyncScopes.Defaults];

    /// <summary>
    /// Base64 AES-256 key records are encrypted under before upload. Independent of the vault key
    /// and shared by the collection's token.
    /// </summary>
    public required string CollectionKey { get; set; }

    /// <summary>Off pauses this collection's loop without deleting anything.</summary>
    public bool Enabled { get; set; } = true;

    public DateTimeOffset? LastSyncUtc { get; set; }
    public string? LastError { get; set; }

    /// <summary>Per-record sync state, keyed "{type}/{id}" - see <see cref="RecordSyncState"/>.</summary>
    public Dictionary<string, RecordSyncState> Records { get; set; } = [];

    /// <summary>Remote ETags of tombstones already applied here, keyed "{type}/{id}".</summary>
    public Dictionary<string, string> Tombstones { get; set; } = [];
}

/// <summary>
/// One record's last agreed state with the remote: the ETag last seen and the HLC last pushed
/// or pulled.
/// </summary>
public sealed class RecordSyncState
{
    public string? ETag { get; set; }
    public string? Hlc { get; set; }
}

/// <summary>
/// &lt;base&gt;/slopterm/v1/collection.json - the human-facing description of a share; no secrets.
/// </summary>
public sealed class RemoteCollectionInfo
{
    public int Version { get; set; } = 1;
    public required string CollectionId { get; set; }
    public required string Name { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// One record as it travels; ciphertext is AES-GCM under the collection key, never the vault key
/// (a no-password vault's key derives from a public seed).
/// </summary>
public sealed class SyncEnvelope
{
    public required string Id { get; set; }
    public required string Type { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public required string Hlc { get; set; }
    public required string Nonce { get; set; }
    public required string Ciphertext { get; set; }
}

/// <summary>
/// A deletion kept as its own file so an offline device learns the record is gone rather than
/// re-uploading it. Carries an HLC: a tombstone only wins against an earlier edit.
/// </summary>
public sealed class SyncTombstone
{
    public required string Id { get; set; }
    public required string Type { get; set; }
    public required string Hlc { get; set; }
    public DateTimeOffset DeletedAt { get; set; }
}

/// <summary>
/// The payload behind a "slopterm:collection:v1:" token: where the share is, how to authenticate
/// and the key its records use. The UI treats it like a password; credentials can be replaced.
/// </summary>
public sealed class CollectionInviteToken
{
    public int V { get; set; } = 1;
    public required string CollectionId { get; set; }
    public required string Name { get; set; }
    public required string RemoteUrl { get; set; }
    public string? Username { get; set; }
    public string? Password { get; set; }
    public required string CollectionKey { get; set; }
    public List<string> Scopes { get; set; } = [];
}

/// <summary>The payload behind "slopterm:sync-config:v1:" - every collection at once.</summary>
public sealed class SyncConfigurationToken
{
    public int V { get; set; } = 1;
    public List<CollectionInviteToken> Collections { get; set; } = [];
}

/// <summary>
/// Where a host's named credential resolved on THIS device. Source is one of "local",
/// "collection", "other-collection", "ssh-config" or "none".
/// </summary>
public sealed record CredentialResolution(string Source, string? Detail, bool Resolved);

/// <summary>Shared serializer options - camelCase on the wire, matching every other endpoint.</summary>
public static class SyncJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    public static byte[] SerializeToUtf8Bytes<T>(T value) => JsonSerializer.SerializeToUtf8Bytes(value, Options);
    public static T? Deserialize<T>(byte[] bytes) => JsonSerializer.Deserialize<T>(bytes, Options);
    public static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);
}
