using System.Security.Cryptography;
using System.Text;
using Konscious.Security.Cryptography;

namespace Slopterm.Server.Vault;

public static class VaultCrypto
{
    public const int SaltSizeBytes = 16;
    public const int KeySizeBytes = 32; // AES-256
    public const int NonceSizeBytes = 12; // 96-bit, standard for AES-GCM
    public const int TagSizeBytes = 16;

    // OWASP-recommended-and-above Argon2id parameters. This only runs once per unlock
    // (not a high-throughput auth path), so it's fine to spend real time on it.
    public const int Argon2MemoryKb = 65536; // 64 MiB
    public const int Argon2Iterations = 3;
    public const int Argon2Parallelism = 4;

    // Used to derive the vault key when the user has turned OFF "require master
    // password" (see AGENTS.md's Settings note). This is NOT a secret - it's a public
    // constant in open-source code - so "no master password" mode still encrypts the
    // vault at rest (protects against casually opening the files) but provides no real
    // confidentiality against anyone who has both the vault files and this app's source.
    public const string NoPasswordSeed = "slopterm-no-master-password-mode-v1";

    // Non-secret, app-wide key material for the portable "share a host" format (see
    // HostShareCodec). Deliberately public, exactly like NoPasswordSeed above: a shared
    // host token is meant to be decodable by ANY slopterm instance, so this provides
    // encoding/obfuscation (the raw password/key never sits on the clipboard as plaintext)
    // NOT confidentiality against someone who already has this app. Anyone running slopterm
    // can decode a token - that's the whole point of the feature.
    public const string ShareSeed = "slopterm-host-share-key-v1";

    /// <summary>
    /// The fixed AES-256 key for the host-share format. SHA-256 of the public ShareSeed -
    /// no Argon2/salt here on purpose: this isn't guarding a secret (see ShareSeed), it just
    /// needs to be a stable 32-byte key every slopterm build derives identically.
    /// </summary>
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
