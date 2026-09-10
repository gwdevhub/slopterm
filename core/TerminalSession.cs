using System.Net.WebSockets;
using Slopterm.Server.Ai;

namespace Slopterm.Server;

/// <summary>How an attached terminal WebSocket ended - see <see cref="TerminalSession.AttachAsync"/>.</summary>
public enum AttachResult
{
    /// <summary>Transport went away while the shell stayed alive; reattach later.</summary>
    Detached,

    /// <summary>The remote shell itself ended; the tab closes.</summary>
    ShellEnded,

    /// <summary>The SSH connection died; the tab should reconnect rather than close.</summary>
    TransportLost,

    /// <summary>Another client took the session over; this one stops rather than reconnecting.</summary>
    Superseded,

    /// <summary>The session is already torn down; nothing to reattach to.</summary>
    Gone,
}

public sealed class TerminalSession : IDisposable
{
    private readonly IShellChannel _channel;
    private readonly object _writeLock = new();

    // Guards attach/detach/teardown state; never held across an await.
    private readonly object _stateLock = new();
    private readonly CancellationTokenSource _lifetime = new();
    private Attachment? _currentAttach;

    // Superseded asks the send loop to stop so it can close politely; cancelling aborts.
    private sealed class Attachment(CancellationTokenSource cts)
    {
        public readonly CancellationTokenSource Cts = cts;
        public volatile bool Superseded;
    }
    private int _attachCount;
    private bool _disposed;
    private int _teardownStarted;
    private volatile bool _shellEnded;
    private volatile bool _readerStopped;
    private bool _everAttached;

    // Completed and swapped on each reader append; collapses to "there is news" rather than
    // accumulating counts like a semaphore.
    private TaskCompletionSource _outputSignal = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public string Id { get; }

    /// <summary>"ssh" for a remote shell, "local" for one on this machine.</summary>
    public string Kind { get; }

    /// <summary>The SSH destination, or a description of this machine and shell for a local session.</summary>
    public string Host { get; }
    public int Port { get; }
    public string Username { get; }

    /// <summary>Recent raw PTY output - the AI agent's view of the session, and the terminal WebSocket's source.</summary>
    public TerminalScrollback Scrollback { get; }

    /// <summary>The AI agent conversation bound to this session; dies with it.</summary>
    public AgentConversation Agent { get; }

    /// <summary>True once the remote shell has ended cleanly, as opposed to a client merely detaching.</summary>
    public bool ShellEnded => _shellEnded;

    /// <summary>True once no more output will ever arrive and there is nothing to reattach to.</summary>
    public bool Ended => _readerStopped;

    /// <summary>When the last client detached, or null while one is attached. Drives reaping.</summary>
    public DateTimeOffset? DetachedAtUtc { get; private set; }

    public bool IsAttached
    {
        get
        {
            lock (_stateLock)
            {
                return _attachCount > 0;
            }
        }
    }

    private TerminalSession(string id, string kind, IShellChannel channel, string host, int port, string username)
    {
        Id = id;
        Kind = kind;
        _channel = channel;
        Host = host;
        Port = port;
        Username = username;
        Scrollback = new TerminalScrollback();
        Agent = new AgentConversation(this);
        // Starts the reaper clock even if the session is never attached to.
        DetachedAtUtc = DateTimeOffset.UtcNow;
    }

    public static TerminalSession Connect(ConnectRequest request) =>
        Start("ssh", SshShellChannel.Connect(request), request.Host, request.Port, request.Username);

    /// <summary>A shell on the machine slopterm runs on; the session layer only sees an IShellChannel.</summary>
    public static TerminalSession StartLocal(LocalShellRequest request)
    {
        var channel = LocalShellChannel.Start(request);
        return Start("local", channel, LocalShell.PlatformName(), 0, channel.ShellName);
    }

    private static TerminalSession Start(string kind, IShellChannel channel, string host, int port, string username)
    {
        var session = new TerminalSession(Guid.NewGuid().ToString("N"), kind, channel, host, port, username);
        session.StartReader();
        session.StartTransportWatch();
        return session;
    }

    // Sets the PTY to the browser terminal's real size; the initial request hard-codes 80x24.
    public void Resize(uint columns, uint rows)
    {
        if (columns == 0 || rows == 0)
        {
            return;
        }

        _channel.Resize(columns, rows);
    }

    /// <summary>
    /// Drains the shell into the scrollback for the session's whole life, attached or not, so
    /// output while backgrounded is replayed on reattach and the channel window never fills.
    /// </summary>
    private void StartReader()
    {
        _ = Task.Run(() =>
        {
            var buffer = new byte[4096];
            while (!_lifetime.IsCancellationRequested)
            {
                int read;
                try
                {
                    read = _channel.Read(buffer, 0, buffer.Length);
                }
                catch (Exception)
                {
                    // A throw is normal disposal or transport failure, never a clean shell exit.
                    break;
                }

                if (read <= 0)
                {
                    // EOF is ambiguous in SSH.NET: it means either channel close (`exit`) or
                    // session loss. A cancelled lifetime is deliberate disposal.
                    _shellEnded = !_lifetime.IsCancellationRequested && ShellClosedCleanly();
                    break;
                }

                Scrollback.Append(buffer.AsSpan(0, read));
                SignalOutput();
            }

            // Written after the last Append and read before the snapshot in SendOutputAsync.
            _readerStopped = true;
            SignalOutput();
        });
    }

    // Whether the EOF was the shell finishing rather than the transport dying; transport-specific.
    private bool ShellClosedCleanly() => _channel.ShellClosedCleanly(TimeSpan.FromSeconds(1), _lifetime.Token);

    /// <summary>
    /// Polls for SSH transports that died silently (SSH.NET does not close the channel on
    /// abrupt socket failure), and aborts the read so the reader reports the session lost.
    /// </summary>
    private void StartTransportWatch()
    {
        if (!_channel.CanLoseTransport)
        {
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                while (!_lifetime.IsCancellationRequested && !_readerStopped)
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), _lifetime.Token);
                    if (_channel.IsTransportUp || _readerStopped || _lifetime.IsCancellationRequested)
                    {
                        continue;
                    }

                    _channel.AbortRead();
                    return;
                }
            }
            catch (OperationCanceledException)
            {
                // The session is being disposed - teardown handles the rest.
            }
        });
    }

    // Backstop for a superseded attach blocked mid-write; the send loop normally exits first.
    private static void CancelLater(CancellationTokenSource cts)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5));
                cts.Cancel();
            }
            catch (Exception)
            {
                // Already disposed, or a cancellation callback threw - neither is ours to fix.
            }
        });
    }

    private void SignalOutput()
    {
        Interlocked
            .Exchange(ref _outputSignal, new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously))
            .TrySetResult();
    }

    /// <summary>
    /// Runs one attached terminal WebSocket: replays what the client missed, then streams live
    /// output and feeds keystrokes into the shell. Returning does not end the session.
    /// </summary>
    /// <param name="since">Byte offset into total output from a previous attach; null replays the retained tail.</param>
    public async Task<AttachResult> AttachAsync(WebSocket socket, long? since, CancellationToken cancellationToken)
    {
        Attachment? attachment = null;
        Attachment? previous = null;
        var firstEverAttach = false;
        lock (_stateLock)
        {
            if (!_disposed)
            {
                // Last attach wins, so a stale socket from a frozen app can't hold the session.
                previous = _currentAttach;
                attachment = new Attachment(
                    CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token));
                _currentAttach = attachment;
                _attachCount++;
                DetachedAtUtc = null;
                // Claimed under the lock so concurrent reattaches can't both run startup commands.
                firstEverAttach = !_everAttached;
                _everAttached = true;
            }
        }

        if (previous is not null)
        {
            // Wind down politely, not cancel: an aborted socket loses the close reason, so the
            // other window would read a takeover as a network blip and evict us straight back.
            previous.Superseded = true;
            SignalOutput();
            CancelLater(previous.Cts);
        }

        if (attachment is null)
        {
            await CloseAsync(socket, AttachResult.Gone);
            return AttachResult.Gone;
        }

        var attachCts = attachment.Cts;
        var result = AttachResult.Detached;
        var headerDelivered = false;
        try
        {
            var oldest = Scrollback.OldestReplayableOffset;
            // Clamp both ends: a too-old offset is a `gap`; a too-new one would park the loop.
            var cursor = Math.Clamp(since ?? 0, oldest, Scrollback.TotalWritten);
            var gap = since is { } requested && requested < oldest;

            await SendAttachHeaderAsync(socket, cursor, gap, attachCts.Token, firstEverAttach);
            headerDelivered = true;

            var toSocket = SendOutputAsync(socket, cursor, attachment, attachCts.Token);
            var fromSocket = ReceiveInputAsync(socket, attachCts.Token);
            var first = await Task.WhenAny(toSocket, fromSocket);

            lock (_stateLock)
            {
                // A takeover is its own outcome so the losing client stops instead of retrying.
                result = ReferenceEquals(_currentAttach, attachment) ? EndedResult() : AttachResult.Superseded;
            }

            if (ReferenceEquals(first, toSocket))
            {
                // The send side stopped, so the socket is free for a close frame; its reason
                // tells the frontend whether to close the tab or reconnect. Close before cancel.
                await CloseAsync(socket, result);
            }

            attachCts.Cancel();
            try
            {
                // Drain both so nothing touches the socket after the handler unwinds.
                await Task.WhenAll(toSocket, fromSocket);
            }
            catch (Exception)
            {
                // Cancellation and transport failures are the expected ways out of both.
            }
        }
        catch (OperationCanceledException)
        {
            // The client went away, or a newer attach took over, before we got going.
        }
        catch (WebSocketException)
        {
            // Transport died mid-frame - same story.
        }
        finally
        {
            lock (_stateLock)
            {
                var stillCurrent = ReferenceEquals(_currentAttach, attachment);
                if (stillCurrent)
                {
                    _currentAttach = null;
                }

                // The header never arrived, so un-claim the startup run - unless someone else
                // attached on the strength of it in the meantime.
                if (firstEverAttach && !headerDelivered && stillCurrent)
                {
                    _everAttached = false;
                }

                if (--_attachCount == 0)
                {
                    DetachedAtUtc = DateTimeOffset.UtcNow;
                }
            }

            attachCts.Dispose();
        }

        return result;
    }

    // Classifies how the attach ended: clean EOF closes the tab, dead transport reconnects.
    private AttachResult EndedResult()
    {
        if (_lifetime.IsCancellationRequested)
        {
            return AttachResult.Gone;
        }

        if (_shellEnded)
        {
            return AttachResult.ShellEnded;
        }

        return _readerStopped ? AttachResult.TransportLost : AttachResult.Detached;
    }

    // Close reason is a contract with the frontend: "session-ended" closes the tab, anything
    // else (including a dead socket) means reattach.
    private static async Task CloseAsync(WebSocket socket, AttachResult result)
    {
        if (socket.State != WebSocketState.Open)
        {
            return;
        }

        var (status, reason) = result switch
        {
            AttachResult.ShellEnded => (WebSocketCloseStatus.NormalClosure, "session-ended"),
            AttachResult.TransportLost => (WebSocketCloseStatus.EndpointUnavailable, "session-lost"),
            AttachResult.Superseded => (WebSocketCloseStatus.NormalClosure, "session-superseded"),
            AttachResult.Gone => (WebSocketCloseStatus.NormalClosure, "session-gone"),
            _ => (WebSocketCloseStatus.EndpointUnavailable, "detached"),
        };

        try
        {
            // Bound the handshake wait: a frozen peer would otherwise keep the reaper off.
            using var closeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await socket.CloseAsync(status, reason, closeTimeout.Token);
        }
        catch (Exception)
        {
            // A client that vanished mid-close can't complete the handshake.
        }
    }

    // The one text frame on an all-binary channel: `offset` is where the following bytes begin.
    // `fresh` marks the session's first client, its cue to send the host's startup commands.
    private static async Task SendAttachHeaderAsync(
        WebSocket socket, long offset, bool gap, CancellationToken cancellationToken, bool fresh = false)
    {
        var header = System.Text.Encoding.UTF8.GetBytes(
            $"{{\"type\":\"attach\",\"offset\":{offset},\"gap\":{(gap ? "true" : "false")},\"fresh\":{(fresh ? "true" : "false")}}}");
        await socket.SendAsync(header.AsMemory(), WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
    }

    // Streams from the ring so replay and live output share a path and a slow socket can't stall the reader.
    private async Task SendOutputAsync(WebSocket socket, long cursor, Attachment attachment, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            if (attachment.Superseded)
            {
                // Return normally so the caller can still send a close frame explaining why.
                return;
            }

            // Read before the snapshot: the reader writes output first, flags second, so the
            // following snapshot is guaranteed to include anything seen here.
            var news = Volatile.Read(ref _outputSignal).Task;
            var ended = _readerStopped;

            var chunk = Scrollback.ReadFrom(cursor);
            if (chunk.Data.Length > 0)
            {
                if (chunk.StartOffset > cursor)
                {
                    // The ring dropped unsent output, so resend the header to resync the client.
                    await SendAttachHeaderAsync(socket, chunk.StartOffset, gap: true, cancellationToken);
                }

                cursor = chunk.NextOffset;
                await socket.SendAsync(chunk.Data.AsMemory(), WebSocketMessageType.Binary, endOfMessage: true, cancellationToken);
                continue;
            }

            if (ended)
            {
                return;
            }

            await news.WaitAsync(cancellationToken);
        }
    }

    private async Task ReceiveInputAsync(WebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[4096];
        while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                break;
            }

            if (result.Count > 0)
            {
                lock (_writeLock)
                {
                    _channel.Write(buffer, 0, result.Count);
                }
            }
        }
    }

    /// <summary>
    /// Claims a detached, aged-out session for teardown, atomically with AttachAsync. Returns
    /// true exactly once; only then may the caller dispose it.
    /// </summary>
    public bool TryBeginReap(TimeSpan grace)
    {
        lock (_stateLock)
        {
            if (_disposed || _attachCount > 0 || DetachedAtUtc is not { } detachedAt)
            {
                return false;
            }

            // A stopped reader has nothing to reattach to, so skip the grace period.
            if (!_readerStopped && DateTimeOffset.UtcNow - detachedAt < grace)
            {
                return false;
            }

            _disposed = true;
            return true;
        }
    }

    /// <summary>Writes agent text into the user's PTY, serialized with keystrokes via _writeLock.</summary>
    public void WriteToShell(string text)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(text);
        lock (_writeLock)
        {
            _channel.Write(bytes, 0, bytes.Length);
        }
    }

    public void Dispose()
    {
        lock (_stateLock)
        {
            _disposed = true;
        }

        // Idempotent: the reaper and a racing quit/disconnect must not tear down twice.
        if (Interlocked.Exchange(ref _teardownStarted, 1) != 0)
        {
            return;
        }

        // Unblocks the send loop and reader; not disposed because linked tokens still hold it.
        _lifetime.Cancel();

        // Both steps are isolated: a throw would skip the rest, and the teardown claim is one-shot.
        try
        {
            // Cancel any running agent turn before the shell tears down underneath it.
            Agent.Dispose();
        }
        catch (Exception) { }

        try
        {
            // This is also what unparks the reader thread's blocking Read.
            _channel.Dispose();
        }
        catch (Exception) { }

        SignalOutput();
    }
}
