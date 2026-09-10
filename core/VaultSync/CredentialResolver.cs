using Slopterm.Server.Vault;

namespace Slopterm.Server.VaultSync;

/// <summary>
/// What a host's credential resolves to on this device. Source is one of "inline",
/// "keychain-local", "keychain-collection", "keychain-other", "ssh-default" or "none".
/// </summary>
public sealed record ResolvedCredential(
    string Source,
    string? Detail,
    string? Username,
    string? Password,
    string? PrivateKey,
    string? Passphrase)
{
    public bool CanConnect => Password is not null || PrivateKey is not null;
}

/// <summary>
/// Resolves <c>keychain</c>-kind credentials by NAME. Precedence: local collection, then the
/// host's collection, then any other, then ~/.ssh's default identity, then nothing. The result is
/// always reported so the card never claims a different key than the connect uses.
/// </summary>
public static class CredentialResolver
{
    /// <summary>The credential a connect should use, or null when the host carries none at all.</summary>
    public static ResolvedCredential? Resolve(VaultService vault, string hostCollectionId, CredentialRecord credential)
    {
        if (credential.Kind is "password")
        {
            return new ResolvedCredential("inline", null, credential.Username, credential.Secret, null, null);
        }

        if (credential.Kind is "privateKey")
        {
            return new ResolvedCredential("inline", null, credential.Username, null, credential.Secret, credential.Passphrase);
        }

        if (credential.Kind is not "keychain")
        {
            return null; // envVar and anything a newer build invents aren't connect credentials
        }

        var name = credential.KeychainName?.Trim();
        if (string.IsNullOrEmpty(name))
        {
            return new ResolvedCredential("none", null, credential.Username, null, null, null);
        }

        var entries = SafeListKeychain(vault);

        var local = FindByName(entries, CollectionStore.LocalCollectionId, name);
        if (local is not null)
        {
            return FromEntry("keychain-local", local.Value, credential.Username);
        }

        var sameCollection = FindByName(entries, hostCollectionId, name);
        if (sameCollection is not null)
        {
            return FromEntry("keychain-collection", sameCollection.Value, credential.Username);
        }

        var elsewhere = entries.FirstOrDefault(e => NameMatches(e.Record.Name, name));
        if (elsewhere.Record is not null)
        {
            return FromEntry("keychain-other", elsewhere, credential.Username);
        }

        if (SshConfigService.TryReadDefaultIdentity() is { } identity)
        {
            return new ResolvedCredential(
                "ssh-default", Path.GetFileName(identity.Path), credential.Username, null, identity.PrivateKey, null);
        }

        return new ResolvedCredential("none", name, credential.Username, null, null, null);
    }

    /// <summary>
    /// The first credential this device can connect with; mirrors the frontend's rule so the two
    /// never disagree about a card being enabled.
    /// </summary>
    public static ResolvedCredential? ResolveForHost(VaultService vault, string hostCollectionId, HostRecord host, string? credentialId = null)
    {
        var candidates = credentialId is null
            ? host.Credentials
            : host.Credentials.Where(c => c.Id == credentialId).ToList();

        foreach (var credential in candidates)
        {
            var resolved = Resolve(vault, hostCollectionId, credential);
            if (resolved?.CanConnect == true)
            {
                return resolved;
            }
        }

        // Nothing connectable, but a keychain credential that failed to resolve is worth
        // reporting as such rather than as "this host has no credentials".
        return candidates
            .Select(c => Resolve(vault, hostCollectionId, c))
            .FirstOrDefault(r => r is not null);
    }

    /// <summary>The same lookup without the secret, for the hosts listing's card display.</summary>
    public static CredentialResolution Describe(VaultService vault, string hostCollectionId, CredentialRecord credential)
    {
        var resolved = Resolve(vault, hostCollectionId, credential);
        return resolved is null
            ? new CredentialResolution("none", null, false)
            : new CredentialResolution(resolved.Source, resolved.Detail, resolved.CanConnect);
    }

    private static ResolvedCredential FromEntry(
        string source, (string Id, string CollectionId, DateTimeOffset UpdatedAt, KeychainEntryRecord Record) entry, string? username) =>
        new(source, entry.Record.Name, username, null, entry.Record.PrivateKey, entry.Record.Passphrase);

    private static (string Id, string CollectionId, DateTimeOffset UpdatedAt, KeychainEntryRecord Record)? FindByName(
        IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, KeychainEntryRecord Record)> entries,
        string collectionId,
        string name)
    {
        foreach (var entry in entries)
        {
            if (entry.CollectionId == collectionId && NameMatches(entry.Record.Name, name))
            {
                return entry;
            }
        }

        return null;
    }

    // Case-insensitive: "prod-deploy" and "Prod-Deploy" being different keys on different
    // devices is a trap, not a feature.
    private static bool NameMatches(string candidate, string name) =>
        string.Equals(candidate.Trim(), name, StringComparison.OrdinalIgnoreCase);

    private static IReadOnlyList<(string Id, string CollectionId, DateTimeOffset UpdatedAt, KeychainEntryRecord Record)> SafeListKeychain(
        VaultService vault)
    {
        try
        {
            return vault.ListKeychainEntries();
        }
        catch (InvalidOperationException)
        {
            return []; // locked vault - resolution just finds nothing, same as an empty keychain
        }
    }
}
