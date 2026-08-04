using System.Text.Json;

namespace Slopterm.Server.VaultSync;

/// <summary>
/// Which kinds of record a collection carries. A scope maps one-to-one onto a vault
/// subfolder and onto a remote records/{type}/ folder, so adding a syncable kind is one
/// entry here plus whatever UI names it.
///
/// The three kinds that are deliberately absent - logs, open tabs and the GitHub token -
/// are not "off by default", they have no scope at all: logs are append-only and noisy,
/// open tabs describe one device's live session, and the GitHub token is a credential for
/// something unrelated to any collection (see todo/webdav-sync.md's scope table).
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
/// collections/{cid}/collection.json - everything about one collection except its records:
/// where it syncs, under which key, what it last did. Vault-encrypted at rest like any
/// other record, because it carries both the remote password and the collection key.
///
/// Access control is the WebDAV server's, not this app's. Several people can each have
/// their own account on the server pointed at one shared folder, or everyone can share a
/// single account, or the folder can need no auth at all - slopterm neither knows nor cares.
/// A read-only share simply answers 403 to a write, which surfaces as "this collection is
/// read-only for you" rather than as a sync error loop. Revoking someone is done where their
/// access actually lives: on the server.
/// </summary>
public sealed class CollectionRecord
{
    public required string Name { get; set; }

    // Empty for a collection that exists only on this device (created but not yet pointed
    // at a share) - it just never syncs until a URL is set.
    public string RemoteUrl { get; set; } = string.Empty;

    // The WebDAV account this device uses. Two devices in the same collection may well use
    // DIFFERENT accounts against the same folder; nothing here assumes otherwise. Both may
    // also be empty, for a share that needs no authentication.
    public string? RemoteUsername { get; set; }
    public string? RemotePassword { get; set; }

    public List<string> Scopes { get; set; } = [.. SyncScopes.Defaults];

    /// <summary>
    /// Base64 AES-256 key the records are encrypted under before they're uploaded, so the
    /// server stores ciphertext it can't read. Independent of the vault key - see
    /// CollectionCrypto - and shared with other devices by the collection's token.
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
/// What this device knows about one record's last agreed state with the remote: the ETag
/// it last saw (so a PROPFIND can skip unchanged records without downloading them) and the
/// HLC it last pushed or pulled (so "changed locally since the last sync" is answerable
/// without keeping a second copy of the record).
/// </summary>
public sealed class RecordSyncState
{
    public string? ETag { get; set; }
    public string? Hlc { get; set; }
}

/// <summary>
/// &lt;base&gt;/slopterm/v1/collection.json - the human-facing description of a share, so a
/// person poking at the WebDAV folder can tell what it is. Deliberately carries no secrets.
/// </summary>
public sealed class RemoteCollectionInfo
{
    public int Version { get; set; } = 1;
    public required string CollectionId { get; set; }
    public required string Name { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>
/// One record as it travels: the same id/timestamp-outside-the-ciphertext shape the vault
/// already uses on disk, plus the clock reading merging needs. The ciphertext is AES-GCM
/// under the collection key, never the vault key - a no-password vault derives its key from
/// a public seed, so anything leaving the device has to be encrypted under something else.
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
/// A deletion, kept as its own tiny file so a device that was offline learns the record is
/// gone rather than re-uploading its stale copy. Carries an HLC for exactly the same reason
/// a record does: a tombstone only wins against an edit that happened before it.
/// </summary>
public sealed class SyncTombstone
{
    public required string Id { get; set; }
    public required string Type { get; set; }
    public required string Hlc { get; set; }
    public DateTimeOffset DeletedAt { get; set; }
}

/// <summary>
/// The payload behind a "slopterm:collection:v1:" token - everything another device needs
/// to join: where the share is, how to authenticate to it, and the key its records are
/// encrypted under. The UI treats it exactly like a password, because that is what it is.
///
/// The WebDAV credentials are included so the common case (one paste, it works) needs no
/// second step - but the receiving device can replace them with its own account, which is
/// the point of the server owning access control rather than this app.
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

/// <summary>
/// The payload behind "slopterm:sync-config:v1:" - every collection at once, so setting up
/// a new device is one paste rather than one token per collection.
/// </summary>
public sealed class SyncConfigurationToken
{
    public int V { get; set; } = 1;
    public List<CollectionInviteToken> Collections { get; set; } = [];
}

/// <summary>
/// Where a host's named credential actually resolved on THIS device, so the card can show
/// it. Source is one of "local", "collection", "other-collection", "ssh-config" or
/// "none" - a host must never silently connect with a different key than the card claims.
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
