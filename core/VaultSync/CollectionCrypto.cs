using System.Security.Cryptography;
using Slopterm.Server.Vault;

namespace Slopterm.Server.VaultSync;

/// <summary>
/// The collection's own key for records leaving the device. It can't reuse the vault key: a
/// no-password install derives that from a public seed, useless off-disk.
/// </summary>
public static class CollectionCrypto
{
    private const int KeySizeBytes = 32;

    public static byte[] GenerateCollectionKey() => RandomNumberGenerator.GetBytes(KeySizeBytes);

    /// <summary>128 random bits, hex - the collection id, and also what names its vault folder.</summary>
    public static string GenerateCollectionId() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));

    /// <summary>A short digest of a collection key, so two people can confirm they share a token.</summary>
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
