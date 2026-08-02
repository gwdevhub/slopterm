using Slopterm.Server.Vault;

namespace Slopterm.Server.VaultSync;

/// <summary>
/// One collection as the UI sees it. Deliberately carries no <c>remotePassword</c> and no
/// <c>collectionKey</c>: a saved secret is something the app uses, not something it shows
/// back to you, and the invite token is the one sanctioned way either leaves the device.
/// </summary>
public sealed record CollectionSummary(
    string Id,
    string Name,
    string RemoteUrl,
    string? RemoteUsername,
    bool HasRemotePassword,
    IReadOnlyList<string> Scopes,
    bool Enabled,
    int KeyEpoch,
    DateTimeOffset? LastSyncUtc,
    string? LastError,
    string DeviceFingerprint,
    string DeviceShortFingerprint);

public sealed record CollectionMemberInfo(
    string Id,
    string Label,
    string Fingerprint,
    string ShortFingerprint,
    DateTimeOffset AddedAt,
    bool IsThisDevice);

/// <summary>
/// Creating, joining, leaving and describing collections - everything about membership that
/// doesn't need the remote in hand. The actual converging lives in
/// <see cref="VaultSyncService"/>; this decides what exists.
/// </summary>
public sealed class CollectionService(VaultService vault, VaultSyncService sync)
{
    public IReadOnlyList<CollectionSummary> List()
    {
        var results = new List<CollectionSummary>();
        foreach (var collectionId in vault.Collections.ListCollectionIds())
        {
            if (Describe(collectionId) is { } summary)
            {
                results.Add(summary);
            }
        }

        return results;
    }

    public CollectionSummary? Describe(string collectionId)
    {
        var collection = vault.Collections.GetCollection(collectionId);
        if (collection is null)
        {
            return null;
        }

        var identity = vault.Collections.GetOrCreateIdentity(collectionId, DeviceLabel());
        var fingerprint = CollectionCrypto.Fingerprint(identity);
        return new CollectionSummary(
            collectionId,
            collection.Name,
            collection.RemoteUrl,
            collection.RemoteUsername,
            !string.IsNullOrEmpty(collection.RemotePassword),
            collection.Scopes,
            collection.Enabled,
            collection.KeyEpoch,
            collection.LastSyncUtc,
            collection.LastError,
            fingerprint,
            CollectionCrypto.ShortFingerprint(fingerprint));
    }

    public CollectionSummary Create(string name, string remoteUrl, string? username, string? password, IReadOnlyList<string>? scopes)
    {
        var collectionId = CollectionCrypto.GenerateCollectionId();
        var identity = vault.Collections.GetOrCreateIdentity(collectionId, DeviceLabel());

        vault.Collections.SaveCollection(collectionId, new CollectionRecord
        {
            Name = string.IsNullOrWhiteSpace(name) ? "Collection" : name.Trim(),
            RemoteUrl = remoteUrl.Trim(),
            RemoteUsername = username,
            RemotePassword = password,
            Scopes = [.. NormalizeScopes(scopes)],
            CollectionKey = Convert.ToBase64String(CollectionCrypto.GenerateCollectionKey()),
            // The creating device pins its own key: it's the only one that exists yet, and
            // it's what an invite hands to whoever joins next.
            SignerEd25519Pub = identity.Ed25519Public,
        });

        sync.RequestSync(collectionId);
        return Describe(collectionId)!;
    }

    /// <summary>
    /// Applies whatever the caller supplied and leaves the rest alone - a null password
    /// means "keep the one you have", which is what makes the Edit form able to show a
    /// password field it never fills in.
    /// </summary>
    public CollectionSummary Update(
        string collectionId, string? name, string? remoteUrl, string? username, string? password,
        IReadOnlyList<string>? scopes, bool? enabled)
    {
        var collection = vault.Collections.GetCollection(collectionId)
            ?? throw new InvalidOperationException("That collection doesn't exist on this device.");

        if (!string.IsNullOrWhiteSpace(name))
        {
            collection.Name = name.Trim();
        }

        if (remoteUrl is not null)
        {
            collection.RemoteUrl = remoteUrl.Trim();
        }

        if (username is not null)
        {
            collection.RemoteUsername = username.Length == 0 ? null : username;
        }

        if (password is not null)
        {
            collection.RemotePassword = password.Length == 0 ? null : password;
        }

        if (scopes is not null)
        {
            collection.Scopes = [.. NormalizeScopes(scopes)];
        }

        if (enabled is not null)
        {
            collection.Enabled = enabled.Value;
        }

        vault.Collections.SaveCollection(collectionId, collection);
        sync.RequestSync(collectionId);
        return Describe(collectionId)!;
    }

    /// <summary>
    /// Leaves a collection: its records and keys go from THIS device, and the shared content
    /// is untouched. Records can be kept by moving them into the local collection first,
    /// which is what <paramref name="keepRecordsLocally"/> does - otherwise leaving a team
    /// collection would silently take every host it carried with it.
    /// </summary>
    public void Leave(string collectionId, bool keepRecordsLocally)
    {
        var collection = vault.Collections.GetCollection(collectionId)
            ?? throw new InvalidOperationException("That collection doesn't exist on this device.");

        if (keepRecordsLocally)
        {
            foreach (var scope in collection.Scopes)
            {
                if (SyncScopes.FolderFor(scope) is not { } folder)
                {
                    continue;
                }

                foreach (var record in vault.Collections.ListRecords(collectionId, folder))
                {
                    vault.Collections.SaveRecord(CollectionStore.LocalCollectionId, folder, record.Id, record.Json);
                }
            }
        }

        vault.Collections.DeleteCollection(collectionId);
    }

    public IReadOnlyList<CollectionMemberInfo> ListMembers(string collectionId)
    {
        var members = vault.Collections.GetCachedMembers(collectionId);
        if (members is null)
        {
            return [];
        }

        var identity = vault.Collections.GetOrCreateIdentity(collectionId, DeviceLabel());
        var mine = CollectionCrypto.Fingerprint(identity);

        return members.Members.Select(m =>
        {
            var fingerprint = CollectionCrypto.Fingerprint(m);
            return new CollectionMemberInfo(
                m.Id, m.Label, fingerprint, CollectionCrypto.ShortFingerprint(fingerprint), m.AddedAt, fingerprint == mine);
        }).ToList();
    }

    /// <summary>
    /// The one-line invite for a single collection. It carries the collection key, so the
    /// caller shows it behind a reveal and warns against pasting it into a chat.
    /// </summary>
    public string BuildInviteToken(string collectionId, string? passphrase) =>
        CollectionShareCodec.EncodeInvite(BuildInvite(collectionId), passphrase);

    /// <summary>Every collection in one blob - the "restore my setup on a new device" path.</summary>
    public string BuildSyncConfigurationToken(string? passphrase)
    {
        var configuration = new SyncConfigurationToken
        {
            Collections = [.. vault.Collections.ListCollectionIds().Select(BuildInvite)],
        };
        return CollectionShareCodec.EncodeSyncConfiguration(configuration, passphrase);
    }

    private CollectionInviteToken BuildInvite(string collectionId)
    {
        var collection = vault.Collections.GetCollection(collectionId)
            ?? throw new InvalidOperationException("That collection doesn't exist on this device.");

        return new CollectionInviteToken
        {
            CollectionId = collectionId,
            Name = collection.Name,
            RemoteUrl = collection.RemoteUrl,
            Username = collection.RemoteUsername,
            Password = collection.RemotePassword,
            CollectionKey = collection.CollectionKey,
            KeyEpoch = collection.KeyEpoch,
            SignerEd25519Pub = collection.SignerEd25519Pub,
            Scopes = [.. collection.Scopes],
        };
    }

    /// <summary>
    /// Paste-and-confirm: adopts every collection in a token (one for an invite, all of them
    /// for a sync configuration) and queues a full pull. A collection this device already
    /// holds is refreshed rather than duplicated, so re-pasting a token is harmless.
    /// </summary>
    public IReadOnlyList<CollectionSummary> Join(string token, string? passphrase)
    {
        var invites = CollectionShareCodec.Decode(token, passphrase);
        var joined = new List<CollectionSummary>();

        foreach (var invite in invites)
        {
            var existing = vault.Collections.GetCollection(invite.CollectionId);
            var record = existing ?? new CollectionRecord
            {
                Name = invite.Name,
                CollectionKey = invite.CollectionKey,
                SignerEd25519Pub = invite.SignerEd25519Pub,
            };

            record.Name = invite.Name;
            record.RemoteUrl = invite.RemoteUrl;
            record.RemoteUsername = invite.Username;
            record.RemotePassword = invite.Password;
            record.Scopes = [.. NormalizeScopes(invite.Scopes)];
            record.SignerEd25519Pub = invite.SignerEd25519Pub;

            // Only adopt the token's key when it's at least as new as what we hold: a stale
            // token issued before a rotation must not drag a device back onto the old key.
            if (existing is null || invite.KeyEpoch >= existing.KeyEpoch)
            {
                record.CollectionKey = invite.CollectionKey;
                record.KeyEpoch = invite.KeyEpoch;
                record.Records.Clear();
            }

            vault.Collections.GetOrCreateIdentity(invite.CollectionId, DeviceLabel());
            vault.Collections.SaveCollection(invite.CollectionId, record);
            sync.RequestSync(invite.CollectionId);

            if (Describe(invite.CollectionId) is { } summary)
            {
                joined.Add(summary);
            }
        }

        return joined;
    }

    // An unknown scope name (from a newer build's token) is dropped rather than stored, so
    // this device never claims to sync something it has no idea how to read.
    private static IEnumerable<string> NormalizeScopes(IReadOnlyList<string>? scopes) =>
        scopes is null || scopes.Count == 0
            ? SyncScopes.Defaults
            : scopes.Where(s => SyncScopes.Find(s) is not null).Distinct(StringComparer.OrdinalIgnoreCase);

    private static string DeviceLabel()
    {
        try
        {
            return $"{Environment.MachineName} ({HybridLogicalClock.ShortNode(DeviceIdentity.Current)})";
        }
        catch
        {
            return "this device";
        }
    }
}
