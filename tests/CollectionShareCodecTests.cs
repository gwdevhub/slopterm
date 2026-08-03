using System.Security.Cryptography;
using Slopterm.Server.VaultSync;
using Xunit;

namespace Slopterm.Tests;

public sealed class CollectionShareCodecTests
{
    private static CollectionInviteToken Invite(string id = "abc123") => new()
    {
        CollectionId = id,
        Name = "Team hosts",
        RemoteUrl = "https://webdav.example.com/",
        Username = "team",
        Password = "app-password",
        CollectionKey = Convert.ToBase64String(CollectionCrypto.GenerateCollectionKey()),
        Scopes = ["hosts", "snippets"],
    };

    [Fact]
    public void RoundTripsAnInvite()
    {
        var original = Invite();

        var decoded = Assert.Single(CollectionShareCodec.Decode(CollectionShareCodec.EncodeInvite(original)));

        Assert.Equal(original.CollectionId, decoded.CollectionId);
        Assert.Equal(original.CollectionKey, decoded.CollectionKey);
        Assert.Equal(original.RemoteUrl, decoded.RemoteUrl);
        Assert.Equal(original.Username, decoded.Username);
        Assert.Equal(original.Password, decoded.Password);
        Assert.Equal(original.Scopes, decoded.Scopes);
    }

    [Fact]
    public void RoundTripsAWholeSyncConfiguration()
    {
        var configuration = new SyncConfigurationToken { Collections = [Invite("one"), Invite("two")] };

        var decoded = CollectionShareCodec.Decode(CollectionShareCodec.EncodeSyncConfiguration(configuration));

        Assert.Equal(["one", "two"], decoded.Select(c => c.CollectionId));
    }

    /// <summary>
    /// Both formats decode to a list, so the join flow has exactly one code path whichever
    /// the user happened to paste.
    /// </summary>
    [Fact]
    public void CarriesItsFormatInThePrefix()
    {
        Assert.StartsWith(CollectionShareCodec.CollectionPrefix, CollectionShareCodec.EncodeInvite(Invite()), StringComparison.Ordinal);
        Assert.StartsWith(
            CollectionShareCodec.SyncConfigPrefix,
            CollectionShareCodec.EncodeSyncConfiguration(new SyncConfigurationToken()),
            StringComparison.Ordinal);
    }

    [Fact]
    public void RoundTripsAPassphraseWrappedToken()
    {
        var token = CollectionShareCodec.EncodeInvite(Invite(), "correct horse battery staple");

        Assert.True(CollectionShareCodec.NeedsPassphrase(token));
        Assert.Equal("abc123", CollectionShareCodec.Decode(token, "correct horse battery staple").Single().CollectionId);
    }

    [Fact]
    public void RefusesAPassphraseWrappedTokenWithoutOrWithTheWrongPassphrase()
    {
        var token = CollectionShareCodec.EncodeInvite(Invite(), "right");

        Assert.Throws<FormatException>(() => CollectionShareCodec.Decode(token));
        Assert.ThrowsAny<CryptographicException>(() => CollectionShareCodec.Decode(token, "wrong"));
    }

    [Fact]
    public void UnwrappedTokensDontClaimToNeedAPassphrase()
    {
        Assert.False(CollectionShareCodec.NeedsPassphrase(CollectionShareCodec.EncodeInvite(Invite())));
    }

    [Theory]
    [InlineData("")]
    [InlineData("hello")]
    [InlineData("slopterm:host:v1:abc")] // a host share, not a collection - a real paste mistake
    [InlineData("slopterm:collection:v1:")]
    [InlineData("slopterm:collection:v1:!!!!")]
    public void RejectsAnythingThatIsntOneOfItsTokens(string token)
    {
        Assert.ThrowsAny<Exception>(() => CollectionShareCodec.Decode(token));
    }
}
