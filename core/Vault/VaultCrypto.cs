using System.Security.Cryptography;
using System.Text;
using Konscious.Security.Cryptography;

namespace Slopterm.Server.Vault;

public static class VaultCrypto
{
    public const int SaltSizeBytes = 16;
    public const int KeySizeBytes = 32;
    public const int NonceSizeBytes = 12; // 96-bit, standard for AES-GCM
    public const int TagSizeBytes = 16;

    // OWASP-recommended-and-above Argon2id parameters. This only runs once per unlock
    // (not a high-throughput auth path), so it's fine to spend real time on it.
    public const int Argon2MemoryKb = 65536;
    public const int Argon2Iterations = 3;
    public const int Argon2Parallelism = 4;

    // Key derivation seed used when "require master password" is OFF. NOT a secret - a
    // public constant - so this only obfuscates at rest, it does not provide confidentiality.
    public const string NoPasswordSeed = "slopterm-no-master-password-mode-v1";

    // Non-secret key material for the portable "share a host" format (see HostShareCodec).
    // Deliberately public: any slopterm build can decode a token, it only obfuscates.
    public const string ShareSeed = "slopterm-host-share-key-v1";

    /// <summary>The fixed AES-256 key for the host-share format: SHA-256 of the public ShareSeed.</summary>
    public static byte[] DeriveShareKey() => SHA256.HashData(Encoding.UTF8.GetBytes(ShareSeed));

    public static byte[] DeriveKey(
        string masterPassword, byte[] salt, int iterations, int memoryKb, int parallelism)
    {
        using var argon2 = new Argon2id(Encoding.UTF8.GetBytes(masterPassword))
        {
            Salt = salt,
            DegreeOfParallelism = parallelism,
            Iterations = iterations,
            MemorySize = memoryKb,
        };
        return argon2.GetBytes(KeySizeBytes);
    }

    public static (byte[] Nonce, byte[] Ciphertext) Encrypt(byte[] key, string plaintext)
    {
        var plaintextBytes = Encoding.UTF8.GetBytes(plaintext);
        var nonce = RandomNumberGenerator.GetBytes(NonceSizeBytes);
        var ciphertext = new byte[plaintextBytes.Length];
        var tag = new byte[TagSizeBytes];

        using var aesGcm = new AesGcm(key, TagSizeBytes);
        aesGcm.Encrypt(nonce, plaintextBytes, ciphertext, tag);

        // Store ciphertext||tag together so there's one blob per record on disk.
        var combined = new byte[ciphertext.Length + tag.Length];
        Buffer.BlockCopy(ciphertext, 0, combined, 0, ciphertext.Length);
        Buffer.BlockCopy(tag, 0, combined, ciphertext.Length, tag.Length);
        return (nonce, combined);
    }

    public static string Decrypt(byte[] key, byte[] nonce, byte[] ciphertextAndTag)
    {
        var ciphertextLength = ciphertextAndTag.Length - TagSizeBytes;
        var ciphertext = ciphertextAndTag[..ciphertextLength];
        var tag = ciphertextAndTag[ciphertextLength..];
        var plaintext = new byte[ciphertextLength];

        using var aesGcm = new AesGcm(key, TagSizeBytes);
        aesGcm.Decrypt(nonce, ciphertext, tag, plaintext);
        return Encoding.UTF8.GetString(plaintext);
    }
}
