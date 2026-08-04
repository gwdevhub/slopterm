using System.Security.Cryptography;
using Slopterm.Server.VaultSync;
using Xunit;

namespace Slopterm.Tests;

/// <summary>
/// A collection's crypto is deliberately small: one AES-256 key that records are encrypted
/// under before they leave the device. There are no device identities, signatures or key
/// wrapping to test, because who may read and write a collection is the WebDAV server's
/// decision, not this app's.
/// </summary>
public sealed class CollectionCryptoTests
{
    [Fact]
    public void GeneratesADistinctKeyEveryTime()
    {
        Assert.NotEqual(CollectionCrypto.GenerateCollectionKey(), CollectionCrypto.GenerateCollectionKey());
        Assert.Equal(32, CollectionCrypto.GenerateCollectionKey().Length);
    }

    [Fact]
    public void GeneratesADistinctCollectionIdEveryTime()
    {
        var id = CollectionCrypto.GenerateCollectionId();

        Assert.NotEqual(id, CollectionCrypto.GenerateCollectionId());
        Assert.Equal(32, id.Length);
        Assert.True(id.All(Uri.IsHexDigit));
    }

    [Fact]
    public void RoundTripsARecordUnderTheCollectionKey()
    {
        var key = CollectionCrypto.GenerateCollectionKey();
        const string plaintext = """{"name":"prod-db","address":"10.0.0.5"}""";

        var (nonce, ciphertext) = CollectionCrypto.EncryptRecord(key, plaintext);

        Assert.Equal(plaintext, CollectionCrypto.DecryptRecord(
            key, Convert.ToBase64String(nonce), Convert.ToBase64String(ciphertext)));
    }

    /// <summary>
    /// Someone pointed at the same WebDAV folder with a different collection's token can't
    /// read the records - which is what "the server stores ciphertext it can't use" means in
    /// practice, and why the sync loop skips a record it can't decrypt rather than mangling it.
    /// </summary>
    [Fact]
    public void ADifferentKeyCannotReadTheRecord()
    {
        var (nonce, ciphertext) = CollectionCrypto.EncryptRecord(CollectionCrypto.GenerateCollectionKey(), "secret");

        Assert.ThrowsAny<CryptographicException>(() => CollectionCrypto.DecryptRecord(
            CollectionCrypto.GenerateCollectionKey(), Convert.ToBase64String(nonce), Convert.ToBase64String(ciphertext)));
    }

    [Fact]
    public void EncryptingTwiceNeverProducesTheSameBytes()
    {
        var key = CollectionCrypto.GenerateCollectionKey();

        var (firstNonce, firstCiphertext) = CollectionCrypto.EncryptRecord(key, "same");
        var (secondNonce, secondCiphertext) = CollectionCrypto.EncryptRecord(key, "same");

        Assert.NotEqual(firstNonce, secondNonce);
        Assert.NotEqual(firstCiphertext, secondCiphertext);
    }

    /// <summary>
    /// The fingerprint is what two people compare out loud to confirm they pasted the same
    /// token, so it has to be stable, short, and derived from the key without revealing it.
    /// </summary>
    [Fact]
    public void KeyFingerprintIsStableDistinctAndReadable()
    {
        var key = Convert.ToBase64String(CollectionCrypto.GenerateCollectionKey());
        var other = Convert.ToBase64String(CollectionCrypto.GenerateCollectionKey());

        var fingerprint = CollectionCrypto.KeyFingerprint(key);

        Assert.Equal(fingerprint, CollectionCrypto.KeyFingerprint(key));
        Assert.NotEqual(fingerprint, CollectionCrypto.KeyFingerprint(other));
        Assert.Equal(4, fingerprint.Split(' ').Length);
        Assert.DoesNotContain(key, fingerprint, StringComparison.Ordinal);
    }
}
