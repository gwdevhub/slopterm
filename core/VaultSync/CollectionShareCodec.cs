using System.Security.Cryptography;
using System.Text.Json;
using Slopterm.Server.Vault;

namespace Slopterm.Server.VaultSync;

/// <summary>
/// The two clipboard formats that move a collection between devices: a versioned prefix then
/// base64url of nonce+ciphertext. Without a passphrase they're encrypted under the app-wide,
/// non-secret share key - possession of the token IS membership; a passphrase adds Argon2id.
/// </summary>
public static class CollectionShareCodec
{
    public const string CollectionPrefix = "slopterm:collection:v1:";
    public const string SyncConfigPrefix = "slopterm:sync-config:v1:";

    private const byte PlainMarker = 0;      // app-wide share key
    private const byte PassphraseMarker = 1; // Argon2id over a per-token salt

    public static string EncodeInvite(CollectionInviteToken token, string? passphrase = null) =>
        CollectionPrefix + Encode(JsonSerializer.Serialize(token, SyncJson.Options), passphrase);

    public static string EncodeSyncConfiguration(SyncConfigurationToken token, string? passphrase = null) =>
        SyncConfigPrefix + Encode(JsonSerializer.Serialize(token, SyncJson.Options), passphrase);

    /// <summary>True when a token needs a passphrase, so the paste box can ask for one before trying.</summary>
    public static bool NeedsPassphrase(string token)
    {
        try
        {
            var body = StripPrefix(token.Trim(), out _);
            return Base64UrlDecode(body) is [PassphraseMarker, ..];
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException)
        {
            return false;
        }
    }

    /// <summary>Decodes either format; a single invite is a list of one.</summary>
    public static IReadOnlyList<CollectionInviteToken> Decode(string token, string? passphrase = null)
    {
        var trimmed = token.Trim();
        var body = StripPrefix(trimmed, out var isSyncConfig);
        var json = Decrypt(Base64UrlDecode(body), passphrase);

        if (isSyncConfig)
        {
            var configuration = SyncJson.Deserialize<SyncConfigurationToken>(json)
                ?? throw new FormatException("That sync configuration decoded to nothing.");
            return configuration.Collections;
        }

        var invite = SyncJson.Deserialize<CollectionInviteToken>(json)
            ?? throw new FormatException("That collection token decoded to nothing.");
        return [invite];
    }

    private static string StripPrefix(string token, out bool isSyncConfig)
    {
        if (token.StartsWith(CollectionPrefix, StringComparison.Ordinal))
        {
            isSyncConfig = false;
            return token[CollectionPrefix.Length..];
        }

        if (token.StartsWith(SyncConfigPrefix, StringComparison.Ordinal))
        {
            isSyncConfig = true;
            return token[SyncConfigPrefix.Length..];
        }

        throw new FormatException("That isn't a slopterm collection or sync configuration token.");
    }

    private static string Encode(string json, string? passphrase)
    {
        byte[] key;
        byte[] header;
        if (string.IsNullOrEmpty(passphrase))
        {
            key = VaultCrypto.DeriveShareKey();
            header = [PlainMarker];
        }
        else
        {
            var salt = RandomNumberGenerator.GetBytes(VaultCrypto.SaltSizeBytes);
            key = VaultCrypto.DeriveKey(
                passphrase, salt, VaultCrypto.Argon2Iterations, VaultCrypto.Argon2MemoryKb, VaultCrypto.Argon2Parallelism);
            header = [PassphraseMarker, .. salt];
        }

        var (nonce, ciphertextAndTag) = VaultCrypto.Encrypt(key, json);
        return Base64UrlEncode([.. header, .. nonce, .. ciphertextAndTag]);
    }

    private static string Decrypt(byte[] blob, string? passphrase)
    {
        if (blob.Length == 0)
        {
            throw new FormatException("That token is empty.");
        }

        byte[] key;
        int offset;
        if (blob[0] == PassphraseMarker)
        {
            if (string.IsNullOrEmpty(passphrase))
            {
                throw new FormatException("That token is passphrase-protected - enter the passphrase to use it.");
            }

            if (blob.Length <= 1 + VaultCrypto.SaltSizeBytes + VaultCrypto.NonceSizeBytes + VaultCrypto.TagSizeBytes)
            {
                throw new FormatException("That token is too short to be valid.");
            }

            var salt = blob[1..(1 + VaultCrypto.SaltSizeBytes)];
            key = VaultCrypto.DeriveKey(
                passphrase, salt, VaultCrypto.Argon2Iterations, VaultCrypto.Argon2MemoryKb, VaultCrypto.Argon2Parallelism);
            offset = 1 + VaultCrypto.SaltSizeBytes;
        }
        else
        {
            if (blob.Length <= 1 + VaultCrypto.NonceSizeBytes + VaultCrypto.TagSizeBytes)
            {
                throw new FormatException("That token is too short to be valid.");
            }

            key = VaultCrypto.DeriveShareKey();
            offset = 1;
        }

        var nonce = blob[offset..(offset + VaultCrypto.NonceSizeBytes)];
        var ciphertextAndTag = blob[(offset + VaultCrypto.NonceSizeBytes)..];
        return VaultCrypto.Decrypt(key, nonce, ciphertextAndTag);
    }

    private static string Base64UrlEncode(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        var b64 = value.Replace('-', '+').Replace('_', '/');
        b64 += (b64.Length % 4) switch { 2 => "==", 3 => "=", _ => "" };
        return Convert.FromBase64String(b64);
    }
}
