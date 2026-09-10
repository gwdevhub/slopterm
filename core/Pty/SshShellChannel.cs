using Renci.SshNet;

namespace Slopterm.Server;

/// <summary>
/// A remote shell: an SSH connection and the shell channel on it, as one disposable unit.
/// </summary>
public sealed class SshShellChannel : IShellChannel
{
    private readonly SshClient _client;
    private readonly ShellStream _shell;

    // Set from ShellStream.Closed, which fires only when the shell CHANNEL closes, never when
    // the SSH session disconnects - the basis for telling `exit` from a dead transport. Never
    // disposed: the reader may still be waiting on it during teardown.
    private readonly ManualResetEventSlim _channelClosed = new(false);

    private int _disposed;

    private SshShellChannel(SshClient client, ShellStream shell)
    {
        _client = client;
        _shell = shell;
        shell.Closed += (_, _) => _channelClosed.Set();
    }

    public static SshShellChannel Connect(ConnectRequest request)
    {
        var connectionInfo = SshConnectionInfoFactory.Create(request);
        var client = new SshClient(connectionInfo)
        {
            // An idle interactive shell would otherwise be reaped by carrier NAT and sshd's
            // ClientAlive timers. Set on the client, where the property lives.
            KeepAliveInterval = TimeSpan.FromSeconds(30),
        };
        client.Connect();

        var shell = client.CreateShellStream(
            terminalName: "xterm-256color",
            columns: (uint)request.Columns,
            rows: (uint)request.Rows,
            width: 0,
            height: 0,
            bufferSize: 4096);

        return new SshShellChannel(client, shell);
    }

    public int Read(byte[] buffer, int offset, int count) => _shell.Read(buffer, offset, count);

    public void Write(byte[] buffer, int offset, int count)
    {
        _shell.Write(buffer, offset, count);
        _shell.Flush();
    }

    // Pixel width/height are 0: character cells are what matter, and the server derives
    // nothing from the pixel dims.
    public void Resize(uint columns, uint rows) => _shell.ChangeWindowSize(columns, rows, 0, 0);

    public bool CanLoseTransport => true;

    // Wrapped because IsConnected can throw while the session is being torn down underneath us.
    public bool IsTransportUp
    {
        get
        {
            try
            {
                return _client.IsConnected;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    /// <summary>
    /// Does NOT go by IsConnected: SSH.NET tears down in an order that makes that a coin flip
    /// (ShellStream disposed before the socket, or vice versa). ShellStream.Closed is
    /// unambiguous; the short wait covers the reader arriving first. A timeout reads as a
    /// transport loss, the safer way to be wrong.
    /// </summary>
    public bool ShellClosedCleanly(TimeSpan timeout, CancellationToken cancellationToken)
    {
        try
        {
            return _channelClosed.Wait(timeout, cancellationToken);
        }
        catch (Exception)
        {
            // Cancelled (we're being disposed) or already torn down - not a clean exit.
            return false;
        }
    }

    // Disposing the shell unparks a blocked reader; the SshClient is left for Dispose below.
    public void AbortRead()
    {
        try
        {
            _shell.Dispose();
        }
        catch (Exception)
        {
            // Already gone; the reader will notice either way.
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        // Isolated because SSH.NET throws from both the channel close and the disconnect when
        // the link is already dead; a throw would otherwise strand the SshClient.
        try
        {
            // This is also what unparks the reader thread's blocking Read.
            _shell.Dispose();
        }
        catch (Exception) { }

        try
        {
            if (_client.IsConnected)
            {
                _client.Disconnect();
            }
        }
        catch (Exception) { }

        try
        {
            _client.Dispose();
        }
        catch (Exception) { }
    }
}
