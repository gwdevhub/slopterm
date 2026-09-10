using System.Runtime.InteropServices;
using System.Text;
using Renci.SshNet;

namespace Slopterm.Server;

/// <summary>Builds a Renci.SshNet ConnectionInfo from a ConnectRequest - shared by
/// TerminalSession and SftpSession for the common Windows key-exchange workaround.</summary>
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
            // EC key exchange goes through Windows CNG: NIST curves are solid on real Windows,
            // X25519 is flaky, and Wine has no working ECDH (only classical group*). The PQ
            // hybrids are dropped as untested X25519 paths.
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

    // Wine reports as Windows, so the only reliable tell is Wine's private wine_get_version
    // ntdll export. Cached; any failure means false (the pre-fix behavior).
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
