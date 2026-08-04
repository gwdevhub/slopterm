using Slopterm.Server.Vault;
using Slopterm.Server.VaultSync;
using Xunit;

namespace Slopterm.Tests;

/// <summary>
/// The precedence rules behind "a host can name a credential instead of carrying one" - the
/// feature that lets a team share a host inventory while every member connects with their
/// own key.
/// </summary>
[Collection("vault-dir")]
public sealed class CredentialResolverTests : IDisposable
{
    private readonly InMemoryRemote.Store _store = new();
    private readonly TwoDeviceFixture _fixture;

    public CredentialResolverTests()
    {
        _fixture = new TwoDeviceFixture((_, _, _) => new InMemoryRemote(_store));
    }

    public void Dispose() => _fixture.Dispose();

    private static CredentialRecord NamedKey(string name) =>
        new() { Id = "c1", Kind = "keychain", Username = "deploy", KeychainName = name };

    private string TeamCollection(VaultService vault, CollectionService collections)
    {
        var created = collections.Create("Team", "https://webdav.example.com/", "team", "pw", null);
        return created.Id;
    }

    /// <summary>
    /// The whole point: the same synced host resolves to a DIFFERENT local key on each
    /// device, and neither device's private key ever needed to travel.
    /// </summary>
    [Fact]
    public void TheSameNameResolvesToADifferentLocalKeyOnEachDevice()
    {
        var laptop = _fixture.Laptop.Vault;
        var phone = _fixture.Phone.Vault;

        laptop.SaveKeychainEntry(null, new KeychainEntryRecord { Name = "prod-deploy", PrivateKey = "LAPTOP-KEY" });
        phone.SaveKeychainEntry(null, new KeychainEntryRecord { Name = "prod-deploy", PrivateKey = "PHONE-KEY" });

        var host = new HostRecord { Name = "prod-db", Address = "10.0.0.5", Credentials = [NamedKey("prod-deploy")] };

        Assert.Equal("LAPTOP-KEY", CredentialResolver.ResolveForHost(laptop, "team", host)!.PrivateKey);
        Assert.Equal("PHONE-KEY", CredentialResolver.ResolveForHost(phone, "team", host)!.PrivateKey);
    }

    /// <summary>Your own key wins over a shared team key of the same name, on your own machine.</summary>
    [Fact]
    public void TheLocalCollectionBeatsTheHostsOwnCollection()
    {
        var vault = _fixture.Laptop.Vault;
        var collectionId = TeamCollection(vault, _fixture.Laptop.Collections);

        vault.SaveKeychainEntry(null, new KeychainEntryRecord { Name = "prod-deploy", PrivateKey = "MINE" });
        vault.SaveKeychainEntry(null, new KeychainEntryRecord { Name = "prod-deploy", PrivateKey = "TEAMS" }, collectionId);

        var host = new HostRecord { Name = "prod-db", Address = "10.0.0.5", Credentials = [NamedKey("prod-deploy")] };
        var resolved = CredentialResolver.ResolveForHost(vault, collectionId, host)!;

        Assert.Equal("MINE", resolved.PrivateKey);
        Assert.Equal("keychain-local", resolved.Source);
    }

    /// <summary>A deliberately shared team key is used when this device has none of its own.</summary>
    [Fact]
    public void FallsBackToTheHostsOwnCollection()
    {
        var vault = _fixture.Laptop.Vault;
        var collectionId = TeamCollection(vault, _fixture.Laptop.Collections);
        vault.SaveKeychainEntry(null, new KeychainEntryRecord { Name = "prod-deploy", PrivateKey = "TEAMS" }, collectionId);

        var host = new HostRecord { Name = "prod-db", Address = "10.0.0.5", Credentials = [NamedKey("prod-deploy")] };
        var resolved = CredentialResolver.ResolveForHost(vault, collectionId, host)!;

        Assert.Equal("TEAMS", resolved.PrivateKey);
        Assert.Equal("keychain-collection", resolved.Source);
    }

    [Fact]
    public void FallsBackToAnyOtherCollectionThisDeviceHolds()
    {
        var vault = _fixture.Laptop.Vault;
        var hostCollection = TeamCollection(vault, _fixture.Laptop.Collections);
        var otherCollection = _fixture.Laptop.Collections.Create("Other", "https://webdav.example.com/other", null, null, null).Id;
        vault.SaveKeychainEntry(null, new KeychainEntryRecord { Name = "prod-deploy", PrivateKey = "ELSEWHERE" }, otherCollection);

        var host = new HostRecord { Name = "prod-db", Address = "10.0.0.5", Credentials = [NamedKey("prod-deploy")] };
        var resolved = CredentialResolver.ResolveForHost(vault, hostCollection, host)!;

        Assert.Equal("ELSEWHERE", resolved.PrivateKey);
        Assert.Equal("keychain-other", resolved.Source);
    }

    /// <summary>
    /// Nothing resolves: the card shows "no key on this device" and SSH/SFTP are disabled -
    /// exactly how a ~/.ssh/config alias with no resolvable identity already behaves. It must
    /// never silently connect with something else.
    /// </summary>
    [Fact]
    public void ReportsNoKeyOnThisDeviceRatherThanConnectingWithSomethingElse()
    {
        var vault = _fixture.Laptop.Vault;
        vault.SaveKeychainEntry(null, new KeychainEntryRecord { Name = "a-different-key", PrivateKey = "NOT-IT" });

        var host = new HostRecord { Name = "prod-db", Address = "10.0.0.5", Credentials = [NamedKey("prod-deploy")] };
        var resolved = CredentialResolver.ResolveForHost(vault, "team", host)!;

        // ~/.ssh may or may not hold a default identity on the machine running these tests,
        // so the assertion is the one that matters either way: it never silently picks a
        // DIFFERENT named key.
        Assert.NotEqual("NOT-IT", resolved.PrivateKey);
        Assert.Contains(resolved.Source, new[] { "none", "ssh-default" });
        if (resolved.Source == "none")
        {
            Assert.False(resolved.CanConnect);
            Assert.Equal("prod-deploy", resolved.Detail);
        }
    }

    [Fact]
    public void MatchesNamesCaseInsensitively()
    {
        var vault = _fixture.Laptop.Vault;
        vault.SaveKeychainEntry(null, new KeychainEntryRecord { Name = "Prod-Deploy", PrivateKey = "MINE" });

        var host = new HostRecord { Name = "prod-db", Address = "10.0.0.5", Credentials = [NamedKey("prod-deploy")] };

        Assert.Equal("MINE", CredentialResolver.ResolveForHost(vault, "team", host)!.PrivateKey);
    }

    [Fact]
    public void PassesInlineCredentialsStraightThrough()
    {
        var vault = _fixture.Laptop.Vault;
        var host = new HostRecord
        {
            Name = "prod-db",
            Address = "10.0.0.5",
            Credentials = [new CredentialRecord { Id = "c1", Kind = "password", Username = "deploy", Secret = "hunter2" }],
        };

        var resolved = CredentialResolver.ResolveForHost(vault, "local", host)!;

        Assert.Equal("hunter2", resolved.Password);
        Assert.Equal("inline", resolved.Source);
        Assert.True(resolved.CanConnect);
    }

    /// <summary>
    /// A host may list several credentials; the first CONNECTABLE one is used, so an
    /// unresolvable named key doesn't shadow a working password sitting behind it.
    /// </summary>
    [Fact]
    public void SkipsAnUnresolvableCredentialForOneThatWorks()
    {
        var vault = _fixture.Laptop.Vault;
        var host = new HostRecord
        {
            Name = "prod-db",
            Address = "10.0.0.5",
            Credentials =
            [
                NamedKey("nothing-called-this-anywhere"),
                new CredentialRecord { Id = "c2", Kind = "password", Username = "deploy", Secret = "hunter2" },
            ],
        };

        Assert.Equal("hunter2", CredentialResolver.ResolveForHost(vault, "local", host)!.Password);
    }

    [Fact]
    public void DescribeNeverCarriesTheSecret()
    {
        var vault = _fixture.Laptop.Vault;
        vault.SaveKeychainEntry(null, new KeychainEntryRecord { Name = "prod-deploy", PrivateKey = "MINE" });

        var description = CredentialResolver.Describe(vault, "team", NamedKey("prod-deploy"));

        Assert.True(description.Resolved);
        Assert.Equal("keychain-local", description.Source);
        Assert.Equal("prod-deploy", description.Detail);
        Assert.DoesNotContain("MINE", System.Text.Json.JsonSerializer.Serialize(description), StringComparison.Ordinal);
    }

    /// <summary>An envVar credential isn't a connect credential and must never be treated as one.</summary>
    [Fact]
    public void IgnoresCredentialKindsThatArentForConnecting()
    {
        var vault = _fixture.Laptop.Vault;
        var host = new HostRecord
        {
            Name = "prod-db",
            Address = "10.0.0.5",
            Credentials = [new CredentialRecord { Id = "c1", Kind = "envVar", Secret = "TERM=xterm" }],
        };

        Assert.Null(CredentialResolver.ResolveForHost(vault, "local", host));
    }
}
