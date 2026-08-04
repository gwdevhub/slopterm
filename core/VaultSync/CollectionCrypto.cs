using System.Security.Cryptography;
using Slopterm.Server.Vault;

namespace Slopterm.Server.VaultSync;

/// <summary>
/// The one piece of crypto a collection needs beyond what the vault already does: a key of
/// its own for the records that leave the device.
///
/// Why it can't just reuse the vault key: a default install has no master password, so its
/// vault key derives from the public <see cref="VaultCrypto.NoPasswordSeed"/>. That's fine
/// for encrypting files at rest on your own disk and useless for anything crossing a
/// network. The collection key is independent, which is what lets that default install sync
/// safely.
///
/// There is deliberately nothing else here - no device identities, no signatures, no key
/// wrapping, no rotation. Who may read and write a collection is decided by the WebDAV
/// server's own accounts and permissions, not by a membership list this app maintains. See
/// <see cref="CollectionRecord"/>.
/// </summary>
public static class CollectionCrypto
{
    private const int KeySizeBytes = 32;

    public static byte[] GenerateCollectionKey() => RandomNumberGenerator.GetBytes(KeySizeBytes);

    /// <summary>128 random bits, hex - the collection id, and also what names its vault folder.</summary>
    public static string GenerateCollectionId() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));

    /// <summary>
    /// A short, readable digest of a collection key, so two people can confirm out of band
    /// that they pasted the same token - without either of them showing the key itself.
    /// </summary>
    public static string KeyFingerprint(string collectionKeyBase64)
    {
        var hex = Convert.ToHexStringLower(SHA256.HashData(Convert.FromBase64String(collectionKeyBase64)));
        return string.Join(' ', Enumerable.Range(0, 4).Select(i => hex.Substring(i * 4, 4)));
    }

    public static (byte[] Nonce, byte[] Ciphertext) EncryptRecord(byte[] collectionKey, string plaintext) =>
        VaultCrypto.Encrypt(collectionKey, plaintext);

    public static string DecryptRecord(byte[] collectionKey, string nonceBase64, string ciphertextBase64) =>
        VaultCrypto.Decrypt(collectionKey, Convert.FromBase64String(nonceBase64), Convert.FromBase64String(ciphertextBase64));
}
