using System.Text.Json;

namespace Slopterm.Server.Vault;

/// <summary>
/// Encodes a HostRecord into a compact, clipboard-friendly token another slopterm instance
/// can import. AES-GCM encrypted under the non-secret ShareSeed, so it is not plaintext.
/// </summary>
public static class HostShareCodec
{
    // Versioned so a future format change can be detected (and rejected with a clear message)
    // rather than silently mis-decoded.
    private const string Prefix = "slopterm:host:v1:";

    public static string Encode(HostRecord host)
    {
        var json = JsonSerializer.Serialize(host);
        var key = VaultCrypto.DeriveShareKey();
        var (nonce, ciphertextAndTag) = VaultCrypto.Encrypt(key, json);

        // nonce || (ciphertext || tag) - the tag is already appended to the ciphertext by
        // VaultCrypto.Encrypt, so this is everything needed to decrypt in one blob.
        var blob = new byte[nonce.Length + ciphertextAndTag.Length];
        Buffer.BlockCopy(nonce, 0, blob, 0, nonce.Length);
        Buffer.BlockCopy(ciphertextAndTag, 0, blob, nonce.Length, ciphertextAndTag.Length);
        return Prefix + Base64UrlEncode(blob);
    }

    /// <summary>Throws FormatException for a malformed token, CryptographicException if authentication fails.</summary>
    public static HostRecord Decode(string token)
    {
        token = token.Trim();
        if (!token.StartsWith(Prefix, StringComparison.Ordinal))
        {
            throw new FormatException("Not a slopterm host share token.");
        }

        var blob = Base64UrlDecode(token[Prefix.Length..]);
        if (blob.Length <= VaultCrypto.NonceSizeBytes + VaultCrypto.TagSizeBytes)
        {
            throw new FormatException("Host share token is too short to be valid.");
        }

        var nonce = blob[..VaultCrypto.NonceSizeBytes];
        var ciphertextAndTag = blob[VaultCrypto.NonceSizeBytes..];
        var json = VaultCrypto.Decrypt(VaultCrypto.DeriveShareKey(), nonce, ciphertextAndTag);
        return JsonSerializer.Deserialize<HostRecord>(json)
            ?? throw new FormatException("Host share token decoded to nothing.");
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
