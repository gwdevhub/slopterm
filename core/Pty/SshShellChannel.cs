using Renci.SshNet;

namespace Slopterm.Server;

/// <summary>
/// A remote shell: an SSH connection and the shell channel on it, as one disposable unit.
/// This is the behaviour <see cref="TerminalSession"/> used to hold inline, moved out
/// unchanged when the local PTY gained the right to be pumped by the same session code.
/// </summary>
public sealed class SshShellChannel : IShellChannel
{
    private readonly SshClient _client;
    private readonly ShellStream _shell;

    // Set from ShellStream.Closed, which SSH.NET raises only when the shell CHANNEL closes -
    // never when the SSH session disconnects. That distinction is the whole basis for telling
    // `exit` apart from a dead transport. Deliberately never disposed: the reader may still
    // be waiting on it while teardown runs, and a disposed wait handle throws.
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
            // An interactive shell can sit idle for hours emitting nothing at all, and a
            // silent TCP flow is exactly what carrier NAT and sshd's ClientAlive timers reap.
            // Matches ForwardingService/SyncService, which have always set this - the
            // interactive paths were the ones missing it. Set on the client, not on
            // ConnectionInfo: in SSH.NET the property lives on BaseClient.
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

    // Wrapped because IsConnected reaches into a session object that may be being torn down
    // underneath us, and a throw here would be read as "still connected" by callers that
    // can't afford to guess.
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
    /// This deliberately does NOT go by whether the client still reports itself connected.
    /// SSH.NET tears things down in an order that makes that answer a coin flip: on a
    /// server-sent disconnect it disposes the ShellStream - waking the reader - BEFORE it
    /// shuts the socket down, so the client can still look connected; and on a real
    /// <c>exit</c> the listener thread often runs straight on into closing the transport
    /// before the reader is scheduled at all, so the client can already look disconnected.
    /// Either way round the guess is wrong half the time, and each way costs the user
    /// something: one closes a tab whose connection merely blipped, the other silently opens
    /// a fresh authenticated session for a shell they just exited.
    ///
    /// <c>ShellStream.Closed</c> has no such ambiguity. It arrives on another thread just
    /// after the stream is disposed, though, so the reader can get here first; the short wait
    /// is what turns that into a definite answer instead of another race. Timing out is read
    /// as a transport loss, which is the safer way to be wrong: the tab reconnects rather
    /// than disappearing.
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

    // Disposing the shell is what unparks a reader blocked on a stream that will never
    // produce another byte. The SshClient is deliberately left alone: the session disposes
    // the whole channel a moment later and that is where the connection is closed.
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

        // Every step is isolated, because this runs on connections that are by definition
        // suspect - the reaper's whole job is collecting sessions whose transport broke - and
        // SSH.NET throws out of both the channel close and the disconnect when the link is
        // already dead. Unguarded, the first throw would skip the rest and strand the
        // SshClient (and its transport thread) for the life of the process.
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
