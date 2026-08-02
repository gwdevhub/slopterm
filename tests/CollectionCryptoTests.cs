using System.Security.Cryptography;
using Slopterm.Server.VaultSync;
using Xunit;

namespace Slopterm.Tests;

public sealed class CollectionCryptoTests
{
    [Fact]
    public void WrapsAndUnwrapsTheCollectionKeyForOneMember()
    {
        var key = CollectionCrypto.GenerateCollectionKey();
        var identity = CollectionCrypto.GenerateIdentity("laptop");

        var wrapped = CollectionCrypto.WrapKey(key, identity.X25519Public);

        Assert.Equal(key, CollectionCrypto.UnwrapKey(wrapped, identity));
    }

    [Fact]
    public void WrappingIsFreshEveryTime()
    {
        var key = CollectionCrypto.GenerateCollectionKey();
        var identity = CollectionCrypto.GenerateIdentity("laptop");

        // A fresh ephemeral keypair per wrap means the same key sealed twice never produces
        // the same bytes - otherwise the member list would leak "these two entries hold the
        // same key" to anyone reading the share.
        Assert.NotEqual(
            CollectionCrypto.WrapKey(key, identity.X25519Public),
            CollectionCrypto.WrapKey(key, identity.X25519Public));
    }

    [Fact]
    public void AnotherDeviceCannotUnwrapSomeoneElsesEntry()
    {
        var key = CollectionCrypto.GenerateCollectionKey();
        var mine = CollectionCrypto.GenerateIdentity("laptop");
        var theirs = CollectionCrypto.GenerateIdentity("phone");

        var wrappedForThem = CollectionCrypto.WrapKey(key, theirs.X25519Public);

        // AuthenticationTagMismatchException, which derives from CryptographicException -
        // the same type VaultSyncService catches to report "you no longer have access".
        Assert.ThrowsAny<CryptographicException>(() => CollectionCrypto.UnwrapKey(wrappedForThem, mine));
    }

    [Fact]
    public void FingerprintsAreStableAndDistinct()
    {
        var a = CollectionCrypto.GenerateIdentity("a");
        var b = CollectionCrypto.GenerateIdentity("b");

        Assert.Equal(CollectionCrypto.Fingerprint(a), CollectionCrypto.Fingerprint(a));
        Assert.NotEqual(CollectionCrypto.Fingerprint(a), CollectionCrypto.Fingerprint(b));
        Assert.StartsWith("sha256:", CollectionCrypto.Fingerprint(a), StringComparison.Ordinal);

        // Short form is what two people read to each other over a call.
        Assert.Equal(4, CollectionCrypto.ShortFingerprint(CollectionCrypto.Fingerprint(a)).Split(' ').Length);
    }

    [Fact]
    public void SealsAndVerifiesAMemberList()
    {
        var key = CollectionCrypto.GenerateCollectionKey();
        var identity = CollectionCrypto.GenerateIdentity("laptop");
        var members = MembersWith(key, identity);

        CollectionCrypto.SealMembers(members, identity, key);
        var verification = CollectionCrypto.VerifyMembers(members, identity.Ed25519Public, key);

        Assert.True(verification.Trusted);
        Assert.True(verification.SignatureValid);
        Assert.True(verification.SignerIsPinned);
    }

    /// <summary>
    /// The attack the HMAC exists to stop: someone with write access to the WebDAV share,
    /// but not the collection key, adding themselves so the next rotation hands them the
    /// new key. They can produce a perfectly valid Ed25519 signature with their own key -
    /// and it still has to be refused.
    /// </summary>
    [Fact]
    public void RejectsAMemberListFromSomeoneWhoDoesntHoldTheCollectionKey()
    {
        var key = CollectionCrypto.GenerateCollectionKey();
        var member = CollectionCrypto.GenerateIdentity("laptop");
        var intruder = CollectionCrypto.GenerateIdentity("attacker");

        var members = MembersWith(key, member);
        members.Members.Add(new MemberEntry
        {
            Id = "intruder",
            Label = "attacker",
            X25519 = intruder.X25519Public,
            Ed25519 = intruder.Ed25519Public,
            WrappedKey = "not-a-real-wrap",
            AddedAt = DateTimeOffset.UtcNow,
        });
        CollectionCrypto.SealMembers(members, intruder, CollectionCrypto.GenerateCollectionKey());

        var verification = CollectionCrypto.VerifyMembers(members, member.Ed25519Public, key);

        Assert.False(verification.Trusted);
        Assert.True(verification.SignatureValid); // they really did sign it - it's just not theirs to sign
    }

    [Fact]
    public void RejectsATamperedMemberList()
    {
        var key = CollectionCrypto.GenerateCollectionKey();
        var identity = CollectionCrypto.GenerateIdentity("laptop");
        var members = MembersWith(key, identity);
        CollectionCrypto.SealMembers(members, identity, key);

        members.KeyEpoch = 99;

        Assert.False(CollectionCrypto.VerifyMembers(members, identity.Ed25519Public, key).Trusted);
    }

    /// <summary>
    /// A second device signing a list it legitimately added itself to is accepted - the doc's
    /// "any member may sign, there are no roles" - while still being reported as an
    /// unexpected signer, which is what the UI mentions.
    /// </summary>
    [Fact]
    public void AcceptsAListSignedByADifferentMemberButFlagsTheSigner()
    {
        var key = CollectionCrypto.GenerateCollectionKey();
        var creator = CollectionCrypto.GenerateIdentity("laptop");
        var joiner = CollectionCrypto.GenerateIdentity("phone");

        var members = MembersWith(key, creator);
        members.Members.Add(new MemberEntry
        {
            Id = "phone",
            Label = "phone",
            X25519 = joiner.X25519Public,
            Ed25519 = joiner.Ed25519Public,
            WrappedKey = CollectionCrypto.WrapKey(key, joiner.X25519Public),
            AddedAt = DateTimeOffset.UtcNow,
        });
        CollectionCrypto.SealMembers(members, joiner, key);

        var verification = CollectionCrypto.VerifyMembers(members, creator.Ed25519Public, key);

        Assert.True(verification.Trusted);
        Assert.False(verification.SignerIsPinned);
        Assert.Equal(CollectionCrypto.Fingerprint(joiner), verification.SignerFingerprint);
    }

    [Fact]
    public void RejectsAnUnsealedList()
    {
        var key = CollectionCrypto.GenerateCollectionKey();
        var identity = CollectionCrypto.GenerateIdentity("laptop");

        Assert.False(CollectionCrypto.VerifyMembers(MembersWith(key, identity), identity.Ed25519Public, key).Trusted);
    }

    /// <summary>
    /// Both proofs cover canonical JSON, so verification has to survive a round-trip through
    /// the serializer that actually puts it on the wire - property order and all.
    /// </summary>
    [Fact]
    public void SurvivesASerializationRoundTrip()
    {
        var key = CollectionCrypto.GenerateCollectionKey();
        var identity = CollectionCrypto.GenerateIdentity("laptop");
        var members = MembersWith(key, identity);
        CollectionCrypto.SealMembers(members, identity, key);

        var reloaded = SyncJson.Deserialize<MembersFile>(SyncJson.SerializeToUtf8Bytes(members))!;

        Assert.True(CollectionCrypto.VerifyMembers(reloaded, identity.Ed25519Public, key).Trusted);
    }

    private static MembersFile MembersWith(byte[] key, CollectionIdentity identity) => new()
    {
        KeyEpoch = 1,
        Members =
        [
            new MemberEntry
            {
                Id = identity.MemberId,
                Label = identity.Label,
                X25519 = identity.X25519Public,
                Ed25519 = identity.Ed25519Public,
                WrappedKey = CollectionCrypto.WrapKey(key, identity.X25519Public),
                AddedAt = DateTimeOffset.UtcNow,
            },
        ],
    };
}
