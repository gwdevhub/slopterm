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
/// </summary>
public sealed class CollectionRecord
{
    public required string Name { get; set; }

    // Empty for a collection that exists only on this device (created but not yet pointed
    // at a share) - it just never syncs until a URL is set.
    public string RemoteUrl { get; set; } = string.Empty;
    public string? RemoteUsername { get; set; }
    public string? RemotePassword { get; set; }

    public List<string> Scopes { get; set; } = [.. SyncScopes.Defaults];

    /// <summary>Base64 AES-256 collection key. Independent of the vault key - see CollectionCrypto.</summary>
    public required string CollectionKey { get; set; }

    public int KeyEpoch { get; set; } = 1;

    /// <summary>
    /// Base64 Ed25519 public key this device expects to have signed members.json - pinned
    /// when the collection is created (this device's own) or joined (the one carried in the
    /// token). Advisory, not a gate: any member may legitimately sign, so a different signer
    /// is surfaced in the UI rather than refused. What actually gates trust is the HMAC under
    /// the collection key - see MembersFile.
    /// </summary>
    public required string SignerEd25519Pub { get; set; }

    /// <summary>Off pauses this collection's loop without deleting anything.</summary>
    public bool Enabled { get; set; } = true;

    public DateTimeOffset? LastSyncUtc { get; set; }
    public string? LastError { get; set; }

    /// <summary>Per-record sync state, keyed "{type}/{id}" - see <see cref="RecordSyncState"/>.</summary>
    public Dictionary<string, RecordSyncState> Records { get; set; } = [];

    /// <summary>Remote ETags of tombstones already applied here, keyed "{type}/{id}".</summary>
    public Dictionary<string, string> Tombstones { get; set; } = [];

    public string? MembersETag { get; set; }
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
/// collections/{cid}/identity.json - this device's keypair for this collection. Separate
/// per collection so leaving one reveals nothing about membership of another.
/// </summary>
public sealed class CollectionIdentity
{
    public required string MemberId { get; set; }
    public required string Label { get; set; }
    public required string X25519Public { get; set; }   // base64
    public required string X25519Private { get; set; }  // base64
    public required string Ed25519Public { get; set; }  // base64
    public required string Ed25519Private { get; set; } // base64
}

/// <summary>One entry in <see cref="MembersFile"/>. WrappedKey is the CK sealed to this member's X25519 key.</summary>
public sealed class MemberEntry
{
    public required string Id { get; set; }
    public required string Label { get; set; }
    public required string X25519 { get; set; }
    public required string Ed25519 { get; set; }
    public required string WrappedKey { get; set; }
    public DateTimeOffset AddedAt { get; set; }
    public string? AddedBy { get; set; }
}

/// <summary>
/// The member list at &lt;base&gt;/slopterm/v1/members.json, carrying two independent proofs.
///
/// <see cref="KeyProof"/> is the boundary: HMAC-SHA256 over the canonical JSON, keyed by the
/// collection key. Only someone who already holds CK - i.e. an actual member - can produce
/// one, which is exactly what stops a stranger with write access to the WebDAV share adding
/// themselves and being handed the new key on the next rotation.
///
/// <see cref="Signature"/> is attribution: Ed25519 by whichever member wrote the list, over
/// the same canonical JSON, verifiable against <see cref="SignerEd25519"/>. It answers "who
/// changed this", and its fingerprint is what two people compare out of band.
///
/// todo/webdav-sync.md asks for the signature alone, verified against a signer pinned at
/// create/join time. That can't hold together with "any member may sign, there are no
/// roles": the second device to join signs with its OWN key, which no other device has
/// pinned, so every other device would reject a member list that is entirely legitimate.
/// Pinning only works if exactly one device may ever sign, which is the role model the doc
/// rules out. The HMAC gives the property the doc actually wanted - "this came from someone
/// already in the collection" - without one, and the pinned key is kept as an advisory: a
/// list signed by an unexpected device is shown as such rather than silently trusted.
/// </summary>
public sealed class MembersFile
{
    public int Version { get; set; } = 1;
    public int KeyEpoch { get; set; } = 1;
    public List<MemberEntry> Members { get; set; } = [];

    /// <summary>Base64 Ed25519 public key of whoever wrote this list.</summary>
    public string? SignerEd25519 { get; set; }

    /// <summary>Base64 Ed25519 over the canonical JSON of everything above.</summary>
    public string? Signature { get; set; }

    /// <summary>Base64 HMAC-SHA256, keyed by the collection key, over the same canonical JSON.</summary>
    public string? KeyProof { get; set; }

    /// <summary>
    /// The same HMAC keyed by the PREVIOUS collection key, present only on a list that
    /// rotates the key. Without it a device still on the old epoch could never verify the
    /// list that carries the new key - it would need the new key to check the proof, and the
    /// proof is what tells it the new key is legitimate.
    /// </summary>
    public string? PreviousKeyProof { get; set; }
}

/// <summary>
/// The outcome of checking a <see cref="MembersFile"/>. Trusted is the gate - a false here
/// means the list is refused outright. SignerIsPinned false means the list is genuine but
/// was written by a device other than the one this collection first pinned, which the UI
/// mentions rather than acts on.
/// </summary>
public sealed record MembersVerification(bool Trusted, bool SignatureValid, bool SignerIsPinned, string? SignerFingerprint);

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
/// already uses on disk, plus what merging needs (hlc, keyEpoch) and who wrote it. The
/// ciphertext is AES-GCM under the collection key, never the vault key - a no-password
/// vault derives its key from a public seed, so anything leaving the device has to be
/// encrypted under something else.
/// </summary>
public sealed class SyncEnvelope
{
    public required string Id { get; set; }
    public required string Type { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public required string Hlc { get; set; }
    public int KeyEpoch { get; set; }
    public required string Nonce { get; set; }
    public required string Ciphertext { get; set; }
    public string? AuthorFingerprint { get; set; }
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
    public string? AuthorFingerprint { get; set; }
}

/// <summary>
/// The payload behind a "slopterm:collection:v1:" invite token. Possession is membership -
/// it carries the collection key - so the UI treats it exactly like a password.
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
    public int KeyEpoch { get; set; } = 1;
    public required string SignerEd25519Pub { get; set; }
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
