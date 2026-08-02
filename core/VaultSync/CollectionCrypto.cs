using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Agreement;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Slopterm.Server.Vault;

namespace Slopterm.Server.VaultSync;

/// <summary>
/// Everything a collection needs that the vault's own crypto doesn't already do: generating
/// and wrapping the collection key, this device's per-collection identity, and signing and
/// verifying members.json.
///
/// Two decisions worth not re-litigating:
///
/// The collection key (CK) is independent of the vault key. A default install has no master
/// password, so its vault key derives from the public <see cref="VaultCrypto.NoPasswordSeed"/> -
/// perfectly fine for encrypting files at rest on your own disk, and useless for anything
/// leaving the device. CK being separate is what lets that default install sync safely.
///
/// The asymmetric primitives are BouncyCastle, not the BCL. P-256 via ECDiffieHellman/ECDsa
/// would be the obvious choice, but Wine cannot generate ECDH keys at all (CngKey.Create
/// throws 0x80090029 - see AGENTS.md), and this repo's mandatory verification pass is a
/// win-x64 build under Wine. BouncyCastle does X25519/Ed25519 in managed code, so the same
/// tests exercise the same paths everywhere. It ships in the publish output already via
/// SSH.NET, but is referenced directly so a future SSH.NET release can't silently drop it.
/// </summary>
public static class CollectionCrypto
{
    private const int KeySizeBytes = 32;
    private const int NonceSizeBytes = 12;
    private const int TagSizeBytes = 16;
    private const int X25519KeySizeBytes = 32;

    private static readonly byte[] WrapInfo = "slopterm-collection-key-wrap-v1"u8.ToArray();

    public static byte[] GenerateCollectionKey() => RandomNumberGenerator.GetBytes(KeySizeBytes);

    /// <summary>128 random bits, hex - the collection id, and also what names its vault folder.</summary>
    public static string GenerateCollectionId() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));

    public static CollectionIdentity GenerateIdentity(string label)
    {
        var x25519Private = new X25519PrivateKeyParameters(RandomNumberGenerator.GetBytes(X25519KeySizeBytes));
        var ed25519Private = new Ed25519PrivateKeyParameters(RandomNumberGenerator.GetBytes(KeySizeBytes));

        return new CollectionIdentity
        {
            MemberId = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)),
            Label = label,
            X25519Public = Convert.ToBase64String(x25519Private.GeneratePublicKey().GetEncoded()),
            X25519Private = Convert.ToBase64String(x25519Private.GetEncoded()),
            Ed25519Public = Convert.ToBase64String(ed25519Private.GeneratePublicKey().GetEncoded()),
            Ed25519Private = Convert.ToBase64String(ed25519Private.GetEncoded()),
        };
    }

    /// <summary>
    /// SHA-256 over both public keys, as "sha256:&lt;hex&gt;". Identifies a device inside a
    /// collection without revealing anything about the device itself.
    /// </summary>
    public static string Fingerprint(string x25519PublicBase64, string ed25519PublicBase64)
    {
        var x = Convert.FromBase64String(x25519PublicBase64);
        var ed = Convert.FromBase64String(ed25519PublicBase64);
        var combined = new byte[x.Length + ed.Length];
        Buffer.BlockCopy(x, 0, combined, 0, x.Length);
        Buffer.BlockCopy(ed, 0, combined, x.Length, ed.Length);
        return "sha256:" + Convert.ToHexStringLower(SHA256.HashData(combined));
    }

    public static string Fingerprint(CollectionIdentity identity) => Fingerprint(identity.X25519Public, identity.Ed25519Public);

    public static string Fingerprint(MemberEntry member) => Fingerprint(member.X25519, member.Ed25519);

    /// <summary>
    /// Short hex groups for reading a fingerprint aloud over a call - the out-of-band check
    /// that the device you just added is the device you meant.
    /// </summary>
    public static string ShortFingerprint(string fingerprint)
    {
        var hex = fingerprint.StartsWith("sha256:", StringComparison.Ordinal) ? fingerprint[7..] : fingerprint;
        var groups = Enumerable.Range(0, Math.Min(4, hex.Length / 4)).Select(i => hex.Substring(i * 4, 4));
        return string.Join(' ', groups);
    }

    /// <summary>
    /// Seals CK to one member: a fresh ephemeral X25519 keypair per member per epoch, the
    /// shared secret run through HKDF-SHA256, and CK encrypted under the result. Layout is
    /// ephemeralPublic(32) || nonce(12) || ciphertext+tag(48).
    /// </summary>
    public static string WrapKey(byte[] collectionKey, string memberX25519PublicBase64)
    {
        var ephemeralPrivate = new X25519PrivateKeyParameters(RandomNumberGenerator.GetBytes(X25519KeySizeBytes));
        var ephemeralPublic = ephemeralPrivate.GeneratePublicKey().GetEncoded();
        var memberPublic = new X25519PublicKeyParameters(Convert.FromBase64String(memberX25519PublicBase64));

        var shared = new byte[X25519KeySizeBytes];
        var agreement = new X25519Agreement();
        agreement.Init(ephemeralPrivate);
        agreement.CalculateAgreement(memberPublic, shared, 0);

        var wrappingKey = HKDF.DeriveKey(HashAlgorithmName.SHA256, shared, KeySizeBytes, ephemeralPublic, WrapInfo);
        CryptographicOperations.ZeroMemory(shared);

        var nonce = RandomNumberGenerator.GetBytes(NonceSizeBytes);
        var ciphertext = new byte[collectionKey.Length];
        var tag = new byte[TagSizeBytes];
        using (var aes = new AesGcm(wrappingKey, TagSizeBytes))
        {
            aes.Encrypt(nonce, collectionKey, ciphertext, tag);
        }

        CryptographicOperations.ZeroMemory(wrappingKey);

        var blob = new byte[ephemeralPublic.Length + nonce.Length + ciphertext.Length + tag.Length];
        var offset = 0;
        Append(blob, ref offset, ephemeralPublic);
        Append(blob, ref offset, nonce);
        Append(blob, ref offset, ciphertext);
        Append(blob, ref offset, tag);
        return Convert.ToBase64String(blob);
    }

    /// <summary>
    /// The other half of <see cref="WrapKey"/>. Throws <see cref="CryptographicException"/>
    /// when this identity isn't who the entry was wrapped for - which is exactly what a
    /// removed member sees after a rotation, and is reported as "you no longer have access
    /// to this collection" rather than as a sync error.
    /// </summary>
    public static byte[] UnwrapKey(string wrappedBase64, CollectionIdentity identity)
    {
        var blob = Convert.FromBase64String(wrappedBase64);
        if (blob.Length != X25519KeySizeBytes + NonceSizeBytes + KeySizeBytes + TagSizeBytes)
        {
            throw new CryptographicException("Wrapped collection key is malformed.");
        }

        var ephemeralPublic = blob[..X25519KeySizeBytes];
        var nonce = blob[X25519KeySizeBytes..(X25519KeySizeBytes + NonceSizeBytes)];
        var ciphertext = blob[(X25519KeySizeBytes + NonceSizeBytes)..^TagSizeBytes];
        var tag = blob[^TagSizeBytes..];

        var privateKey = new X25519PrivateKeyParameters(Convert.FromBase64String(identity.X25519Private));
        var shared = new byte[X25519KeySizeBytes];
        var agreement = new X25519Agreement();
        agreement.Init(privateKey);
        agreement.CalculateAgreement(new X25519PublicKeyParameters(ephemeralPublic), shared, 0);

        var wrappingKey = HKDF.DeriveKey(HashAlgorithmName.SHA256, shared, KeySizeBytes, ephemeralPublic, WrapInfo);
        CryptographicOperations.ZeroMemory(shared);

        var plaintext = new byte[ciphertext.Length];
        try
        {
            using var aes = new AesGcm(wrappingKey, TagSizeBytes);
            aes.Decrypt(nonce, ciphertext, tag, plaintext);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(wrappingKey);
        }

        return plaintext;
    }

    /// <summary>
    /// Stamps a members list in place with both proofs - the Ed25519 signature naming who
    /// wrote it, and the HMAC under CK proving they were already a member. See
    /// <see cref="MembersFile"/> for why it takes both.
    /// </summary>
    /// <param name="previousCollectionKey">
    /// The key this list is rotating AWAY from, when it is a rotation. Without it a device
    /// still on the old epoch could never verify the list that carries the new key: it would
    /// need the new key to check the proof, and the proof is what tells it the new key is
    /// legitimate. Proving knowledge of the OLD key breaks that circle, and it is exactly the
    /// right claim - "whoever wrote this was a member before the rotation".
    /// </param>
    public static void SealMembers(
        MembersFile members, CollectionIdentity identity, byte[] collectionKey, byte[]? previousCollectionKey = null)
    {
        members.SignerEd25519 = identity.Ed25519Public;
        var payload = UnsealedBytes(members);

        var signer = new Ed25519Signer();
        signer.Init(true, new Ed25519PrivateKeyParameters(Convert.FromBase64String(identity.Ed25519Private)));
        signer.BlockUpdate(payload, 0, payload.Length);
        members.Signature = Convert.ToBase64String(signer.GenerateSignature());
        members.KeyProof = Convert.ToBase64String(HMACSHA256.HashData(collectionKey, payload));
        members.PreviousKeyProof = previousCollectionKey is null
            ? null
            : Convert.ToBase64String(HMACSHA256.HashData(previousCollectionKey, payload));
    }

    /// <summary>
    /// Checks a member list against the key this device currently holds. Trusted (an HMAC)
    /// is the gate; the signature and the pinned signer are reported alongside so the UI can
    /// say "signed by a device you haven't seen before" without refusing a list that is
    /// genuinely from a member.
    ///
    /// A list one epoch ahead is trusted via <see cref="MembersFile.PreviousKeyProof"/>. A
    /// list further ahead than that can't be checked at all - a device that slept through
    /// two rotations has no key in the chain - and is refused, which the caller reports as
    /// "re-join with a fresh invite" rather than as a sync error.
    /// </summary>
    public static MembersVerification VerifyMembers(MembersFile members, string? pinnedEd25519PublicBase64, byte[] collectionKey)
    {
        try
        {
            var payload = UnsealedBytes(members);

            var trusted =
                Proves(members.KeyProof, collectionKey, payload) ||
                Proves(members.PreviousKeyProof, collectionKey, payload);

            var signatureValid = false;
            string? signerFingerprint = null;
            if (!string.IsNullOrEmpty(members.Signature) && !string.IsNullOrEmpty(members.SignerEd25519))
            {
                var verifier = new Ed25519Signer();
                verifier.Init(false, new Ed25519PublicKeyParameters(Convert.FromBase64String(members.SignerEd25519)));
                verifier.BlockUpdate(payload, 0, payload.Length);
                signatureValid = verifier.VerifySignature(Convert.FromBase64String(members.Signature));

                var signerEntry = members.Members.FirstOrDefault(m => m.Ed25519 == members.SignerEd25519);
                signerFingerprint = signerEntry is null ? null : Fingerprint(signerEntry);
            }

            var pinned = !string.IsNullOrEmpty(pinnedEd25519PublicBase64) &&
                members.SignerEd25519 == pinnedEd25519PublicBase64;

            return new MembersVerification(trusted && signatureValid, signatureValid, pinned, signerFingerprint);
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException)
        {
            return new MembersVerification(false, false, false, null); // malformed is a failure, not a crash
        }
    }

    private static bool Proves(string? proofBase64, byte[] key, byte[] payload)
    {
        if (string.IsNullOrEmpty(proofBase64))
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(
            Convert.FromBase64String(proofBase64), HMACSHA256.HashData(key, payload));
    }

    // The bytes every proof covers: everything except the proof fields themselves.
    private static byte[] UnsealedBytes(MembersFile members) => CanonicalBytes(new MembersFile
    {
        Version = members.Version,
        KeyEpoch = members.KeyEpoch,
        Members = members.Members,
        SignerEd25519 = members.SignerEd25519,
    });

    public static (byte[] Nonce, byte[] Ciphertext) EncryptRecord(byte[] collectionKey, string plaintext) =>
        VaultCrypto.Encrypt(collectionKey, plaintext);

    public static string DecryptRecord(byte[] collectionKey, string nonceBase64, string ciphertextBase64) =>
        VaultCrypto.Decrypt(collectionKey, Convert.FromBase64String(nonceBase64), Convert.FromBase64String(ciphertextBase64));

    /// <summary>
    /// Deterministic JSON - object keys sorted, no whitespace - so two devices serializing
    /// the same members list produce byte-identical input to the signature. Anything less
    /// makes verification depend on serializer version and property declaration order,
    /// which is a signature that fails for no reason a user could ever act on.
    /// </summary>
    public static byte[] CanonicalBytes<T>(T value)
    {
        using var document = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(value, SyncJson.Options));
        var builder = new StringBuilder();
        WriteCanonical(document.RootElement, builder);
        return Encoding.UTF8.GetBytes(builder.ToString());
    }

    private static void WriteCanonical(JsonElement element, StringBuilder output)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                output.Append('{');
                var first = true;
                foreach (var property in element.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                {
                    // A null property is simply omitted, so a build that adds an optional
                    // field doesn't invalidate signatures written by one that didn't have it.
                    if (property.Value.ValueKind == JsonValueKind.Null)
                    {
                        continue;
                    }

                    if (!first)
                    {
                        output.Append(',');
                    }

                    first = false;
                    output.Append(JsonSerializer.Serialize(property.Name)).Append(':');
                    WriteCanonical(property.Value, output);
                }

                output.Append('}');
                break;

            case JsonValueKind.Array:
                output.Append('[');
                var firstItem = true;
                foreach (var item in element.EnumerateArray())
                {
                    if (!firstItem)
                    {
                        output.Append(',');
                    }

                    firstItem = false;
                    WriteCanonical(item, output);
                }

                output.Append(']');
                break;

            case JsonValueKind.String:
                output.Append(JsonSerializer.Serialize(element.GetString()));
                break;

            default:
                output.Append(element.GetRawText());
                break;
        }
    }

    private static void Append(byte[] destination, ref int offset, byte[] source)
    {
        Buffer.BlockCopy(source, 0, destination, offset, source.Length);
        offset += source.Length;
    }
}
