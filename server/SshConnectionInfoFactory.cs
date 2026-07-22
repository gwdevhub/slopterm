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
            // .NET's ECDiffieHellman/Windows CNG support for Curve25519 (X25519) is
            // inconsistent across Windows versions and patch levels (dotnet/runtime#42312),
            // and SSH.NET throws instead of falling back to another algorithm. Almost every
            // modern OpenSSH server prefers an X25519-based key exchange, so without this
            // every connection from Windows would fail. Drop every X25519-based method (the
            // plain curve25519 ones and the newer post-quantum hybrids, which use X25519 as
            // part of the hybrid construction) and let it negotiate ecdh-nistp*/classical
            // Diffie-Hellman instead, which Windows always supports consistently.
            connectionInfo.KeyExchangeAlgorithms.Remove("curve25519-sha256");
            connectionInfo.KeyExchangeAlgorithms.Remove("curve25519-sha256@libssh.org");
            connectionInfo.KeyExchangeAlgorithms.Remove("mlkem768x25519-sha256");
            connectionInfo.KeyExchangeAlgorithms.Remove("sntrup761x25519-sha512");
            connectionInfo.KeyExchangeAlgorithms.Remove("sntrup761x25519-sha512@openssh.com");
        }

        return connectionInfo;
    }
}
