using Slopterm.Server;
using Slopterm.Server.Vault;
using Xunit;

namespace Slopterm.Tests;

/// <summary>Resolve real saved sync rules without starting an SFTP connection or a watcher.</summary>
[Collection("vault-dir")]
public sealed class SyncServiceCredentialTests : IDisposable
{
    private readonly TwoDeviceFixture _fixture;

    public SyncServiceCredentialTests()
    {
        var store = new InMemoryRemote.Store();
        _fixture = new TwoDeviceFixture((_, _, _) => new InMemoryRemote(store));
    }

    public void Dispose() => _fixture.Dispose();

    private static CredentialRecord NamedKey(string name = "prod-deploy") =>
        new() { Id = "key", Kind = "keychain", Username = "deploy", KeychainName = name };

    private static string SaveRule(
        VaultService vault, List<CredentialRecord> credentials, string? hostCollectionId = null, string? ruleCollectionId = null)
    {
        var hostId = vault.SaveHost(null, new HostRecord
        {
            Name = "prod-db",
            Address = "ssh.example.com",
            Port = 2222,
            Credentials = credentials,
        }, hostCollectionId);

        return vault.SaveSyncRule(null, new SyncRuleRecord
        {
            HostId = hostId,
            LocalPath = "local-folder",
            RemotePath = "/remote-folder",
        }, ruleCollectionId);
    }

    private string TeamCollection(string name = "Team") =>
        _fixture.Laptop.Collections.Create(name, $"https://webdav.example.com/{name}", null, null, null).Id;

    [Fact]
    public void UsesTheLocalNamedKeyAndItsPassphraseInsteadOfTheSharedKey()
    {
        var vault = _fixture.Laptop.Vault;
        var team = TeamCollection();
        vault.SaveKeychainEntry(null, new KeychainEntryRecord
        {
            Name = "Prod-Deploy", PrivateKey = "LOCAL-KEY", Passphrase = "local-passphrase",
        });
        vault.SaveKeychainEntry(null, new KeychainEntryRecord
        {
            Name = "prod-deploy", PrivateKey = "SHARED-KEY", Passphrase = "shared-passphrase",
        }, team);

        var reference = NamedKey(" prod-deploy ");
        // A name reference must use the resolved entry's secret/passphrase, not stale inline fields.
        reference.Secret = "STALE-KEY";
        reference.Passphrase = "stale-passphrase";
        var ruleId = SaveRule(vault, [reference], team);
        using var sync = new SyncService(vault);

        var (rule, request) = sync.ResolveRule(ruleId);

        Assert.Equal(vault.ListSyncRules().Single().Record.HostId, rule.HostId);
        Assert.Equal("ssh.example.com", request.Host);
        Assert.Equal(2222, request.Port);
        Assert.Equal("deploy", request.Username);
        Assert.Equal("privateKey", request.AuthMethod);
        Assert.Equal("LOCAL-KEY", request.PrivateKey);
        Assert.Equal("local-passphrase", request.Passphrase);
        Assert.Null(request.Password);
    }

    [Fact]
    public void UsesTheHostsCollectionBeforeTheSyncRulesCollection()
    {
        var vault = _fixture.Laptop.Vault;
        var hostCollection = TeamCollection("Hosts");
        var ruleCollection = TeamCollection("Rules");
        vault.SaveKeychainEntry(null, new KeychainEntryRecord
        {
            Name = "prod-deploy", PrivateKey = "HOST-KEY", Passphrase = "host-passphrase",
        }, hostCollection);
        vault.SaveKeychainEntry(null, new KeychainEntryRecord
        {
            Name = "prod-deploy", PrivateKey = "RULE-KEY", Passphrase = "rule-passphrase",
        }, ruleCollection);
        var ruleId = SaveRule(vault, [NamedKey()], hostCollection, ruleCollection);
        using var sync = new SyncService(vault);

        var request = sync.ResolveRule(ruleId).Request;

        Assert.Equal("HOST-KEY", request.PrivateKey);
        Assert.Equal("host-passphrase", request.Passphrase);
    }

    [Fact]
    public void TheSameHostUsesEachDevicesLocalKey()
    {
        var laptop = _fixture.Laptop.Vault;
        var phone = _fixture.Phone.Vault;
        laptop.SaveKeychainEntry(null, new KeychainEntryRecord
        {
            Name = "prod-deploy", PrivateKey = "LAPTOP-KEY", Passphrase = "laptop-passphrase",
        });
        phone.SaveKeychainEntry(null, new KeychainEntryRecord
        {
            Name = "prod-deploy", PrivateKey = "PHONE-KEY", Passphrase = "phone-passphrase",
        });
        var laptopRule = SaveRule(laptop, [NamedKey()]);
        var phoneRule = SaveRule(phone, [NamedKey()]);
        using var laptopSync = new SyncService(laptop);
        using var phoneSync = new SyncService(phone);

        var laptopRequest = laptopSync.ResolveRule(laptopRule).Request;
        var phoneRequest = phoneSync.ResolveRule(phoneRule).Request;

        Assert.Equal("LAPTOP-KEY", laptopRequest.PrivateKey);
        Assert.Equal("laptop-passphrase", laptopRequest.Passphrase);
        Assert.Equal("PHONE-KEY", phoneRequest.PrivateKey);
        Assert.Equal("phone-passphrase", phoneRequest.Passphrase);
    }

    [Theory]
    [InlineData("password", null)]
    [InlineData("password", "ignored-passphrase")]
    [InlineData("privateKey", null)]
    [InlineData("privateKey", "inline-passphrase")]
    public void PreservesInlineCredentials(string kind, string? passphrase)
    {
        var vault = _fixture.Laptop.Vault;
        var ruleId = SaveRule(vault,
        [
            new CredentialRecord { Id = "inline", Kind = kind, Username = "admin", Secret = "INLINE-SECRET", Passphrase = passphrase },
        ]);
        using var sync = new SyncService(vault);

        var request = sync.ResolveRule(ruleId).Request;

        Assert.Equal("admin", request.Username);
        Assert.Equal(kind, request.AuthMethod);
        Assert.Equal(kind == "password" ? "INLINE-SECRET" : null, request.Password);
        Assert.Equal(kind == "privateKey" ? "INLINE-SECRET" : null, request.PrivateKey);
        Assert.Equal(kind == "privateKey" ? passphrase : null, request.Passphrase);
    }

    [Fact]
    public void SkipsUnusableCredentialsBeforeTheWorkingNamedKey()
    {
        var vault = _fixture.Laptop.Vault;
        vault.SaveKeychainEntry(null, new KeychainEntryRecord { Name = "prod-deploy", PrivateKey = "WORKING-KEY" });
        var ruleId = SaveRule(vault,
        [
            new CredentialRecord { Id = "env", Kind = "envVar", Secret = "TERM=xterm" },
            new CredentialRecord { Id = "missing", Kind = "privateKey", Username = "wrong-user" },
            // Deterministically unresolved, even if ~/.ssh has a default identity.
            new CredentialRecord { Id = "unresolved", Kind = "keychain", KeychainName = "" },
            NamedKey(),
        ]);
        using var sync = new SyncService(vault);

        var request = sync.ResolveRule(ruleId).Request;

        Assert.Equal("deploy", request.Username);
        Assert.Equal("privateKey", request.AuthMethod);
        Assert.Equal("WORKING-KEY", request.PrivateKey);
        Assert.Null(request.Passphrase);
        Assert.Null(request.Password);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("envVar")]
    [InlineData("keychain")]
    [InlineData("privateKey")]
    [InlineData("password")]
    public void RejectsHostsWithoutAConnectableCredential(string? kind)
    {
        var vault = _fixture.Laptop.Vault;
        vault.SaveKeychainEntry(null, new KeychainEntryRecord { Name = "unrelated", PrivateKey = "WRONG-KEY" });
        var ruleId = SaveRule(vault, kind is null ? [] : [new CredentialRecord { Id = "unusable", Kind = kind }]);
        using var sync = new SyncService(vault);

        Assert.Throws<InvalidOperationException>(() => sync.ResolveRule(ruleId));
    }

    [Fact]
    public void ResolvesTheCurrentKeyAndPassphraseAgainOnTheNextStart()
    {
        var vault = _fixture.Laptop.Vault;
        var keyId = vault.SaveKeychainEntry(null, new KeychainEntryRecord
        {
            Name = "prod-deploy", PrivateKey = "OLD-KEY", Passphrase = "old-passphrase",
        });
        var ruleId = SaveRule(vault, [NamedKey()]);
        using var sync = new SyncService(vault);
        Assert.Equal("OLD-KEY", sync.ResolveRule(ruleId).Request.PrivateKey);

        vault.SaveKeychainEntry(keyId, new KeychainEntryRecord { Name = "prod-deploy", PrivateKey = "NEW-KEY" });
        var request = sync.ResolveRule(ruleId).Request;

        Assert.Equal("NEW-KEY", request.PrivateKey);
        Assert.Null(request.Passphrase);
        var credential = vault.ListHosts().Single().Record.Credentials.Single();
        Assert.Null(credential.Secret);
        Assert.Null(credential.Passphrase);
    }
}
