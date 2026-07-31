using System.Runtime.InteropServices;
using System.Text;
using Renci.SshNet;

namespace Slopterm.Server;

/// <summary>
/// Builds a Renci.SshNet ConnectionInfo from a ConnectRequest - shared by TerminalSession
/// (interactive shell) and SftpSession (file transfer), since both go through the same
/// SSH transport/auth negotiation and both need the same Windows key-exchange workaround.
/// </summary>
public static class SshConnectionInfoFactory
{
    public static Renci.SshNet.ConnectionInfo Create(ConnectRequest request)
    {
        AuthenticationMethod authMethod;
        if (string.Equals(request.AuthMethod, "privateKey", StringComparison.OrdinalIgnoreCase))
        {
            if (string.IsNullOrEmpty(request.PrivateKey))
            {
                throw new ArgumentException("privateKey is required for privateKey auth");
            }

            using var keyStream = new MemoryStream(Encoding.UTF8.GetBytes(request.PrivateKey));
            var keyFile = string.IsNullOrEmpty(request.Passphrase)
                ? new PrivateKeyFile(keyStream)
                : new PrivateKeyFile(keyStream, request.Passphrase);
            authMethod = new PrivateKeyAuthenticationMethod(request.Username, keyFile);
        }
        else
        {
            if (string.IsNullOrEmpty(request.Password))
            {
                throw new ArgumentException("password is required for password auth");
            }

            authMethod = new PasswordAuthenticationMethod(request.Username, request.Password);
        }

        var connectionInfo = new Renci.SshNet.ConnectionInfo(request.Host, request.Port, request.Username, authMethod)
        {
            // SSH.NET defaults to a 30s connect timeout, which reads as a hung UI for a
            // mistyped host/IP. Fail fast instead.
            Timeout = TimeSpan.FromSeconds(10),
        };

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            // Every elliptic-curve key exchange SSH.NET 2025.1.0 offers computes its shared
            // secret through Windows CNG - curve25519-sha256 included (it doesn't use the
            // bundled BouncyCastle X25519 for the base method, only inside the mlkem/sntrup
            // hybrids). What differs is which CNG paths a given Windows environment actually
            // implements:
            //   - Real Windows: the NIST curves (ecdh-sha2-nistp{256,384,521}) are solid,
            //     while CNG's X25519 is inconsistent across versions/patch levels
            //     (dotnet/runtime#42312) and SSH.NET throws instead of falling back. So drop
            //     the X25519 methods and let ecdh-nistp win.
            //   - Wine: CNG has NO working ECDH at all - X25519 throws "curve not valid for
            //     this platform" and the NIST curves throw NTE_NOT_SUPPORTED (0x80090029). So
            //     drop the NIST curves too; what's left is classical Diffie-Hellman
            //     (group-exchange / group14 / group16), which SSH.NET does in managed
            //     System.Numerics.BigInteger math with no CNG in the path, so it works. Any
            //     OpenSSH server in its default configuration still offers a group* method;
            //     a server hardened to ECC-only key exchange genuinely can't be reached from
            //     the Wine build, which is a limit of Wine's crypto, not something the client
            //     can paper over without a managed ECC implementation.
            // The post-quantum hybrids (mlkem/sntrup) are dropped either way: they're
            // X25519-based, a server that offers one usually prefers it, and leaving them in
            // would just let an untested path win the negotiation.
            connectionInfo.KeyExchangeAlgorithms.Remove("curve25519-sha256");
            connectionInfo.KeyExchangeAlgorithms.Remove("curve25519-sha256@libssh.org");
            connectionInfo.KeyExchangeAlgorithms.Remove("mlkem768x25519-sha256");
            connectionInfo.KeyExchangeAlgorithms.Remove("sntrup761x25519-sha512");
            connectionInfo.KeyExchangeAlgorithms.Remove("sntrup761x25519-sha512@openssh.com");

            if (IsRunningUnderWine())
            {
                connectionInfo.KeyExchangeAlgorithms.Remove("ecdh-sha2-nistp256");
                connectionInfo.KeyExchangeAlgorithms.Remove("ecdh-sha2-nistp384");
                connectionInfo.KeyExchangeAlgorithms.Remove("ecdh-sha2-nistp521");
            }
        }

        return connectionInfo;
    }

    // Wine impersonates Windows to .NET (RuntimeInformation reports Windows, there's no
    // managed "am I on Wine" flag), so the only reliable tell is the private ntdll export
    // Wine adds and real Windows never has: wine_get_version. Cached because it can't change
    // within a process, and swallowed to false on anything unexpected - a wrong "no" just
    // means we behave exactly as before this fix, which is the safe direction.
    private static bool? _isWine;

    private static bool IsRunningUnderWine()
    {
        if (_isWine is { } cached)
        {
            return cached;
        }

        bool detected;
        try
        {
            detected = NativeLibrary.TryLoad("ntdll.dll", out var ntdll)
                && NativeLibrary.TryGetExport(ntdll, "wine_get_version", out _);
        }
        catch
        {
            detected = false;
        }

        _isWine = detected;
        return detected;
    }
}
