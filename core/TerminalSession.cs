using System.Net.WebSockets;
using Slopterm.Server.Ai;

namespace Slopterm.Server;

/// <summary>How an attached terminal WebSocket ended - see <see cref="TerminalSession.AttachAsync"/>.</summary>
public enum AttachResult
{
    /// <summary>
    /// The transport went away while the shell was still alive: the page was reloaded, the
    /// Android WebView was suspended behind another app, a renderer was reclaimed. The SSH
    /// session stays connected and detached, waiting to be reattached.
    /// </summary>
    Detached,

    /// <summary>
    /// The remote shell itself ended - the user typed <c>exit</c>, or the server closed the
    /// channel. The session is over and the tab with it.
    /// </summary>
    ShellEnded,

    /// <summary>
    /// The SSH connection to the host died under us - the phone moved from WiFi to mobile
    /// data, the host rebooted, sshd hung up. The session can't be salvaged (SSH.NET has no
    /// way to resume one), but unlike ShellEnded the user isn't finished: the tab should
    /// reconnect rather than close.
    /// </summary>
    TransportLost,

    /// <summary>
    /// Another client attached and took the session over, so this one was evicted. Distinct
    /// from Detached because the right response is the opposite: stop, rather than reconnect
    /// and evict the other client straight back.
    /// </summary>
    Superseded,

    /// <summary>
    /// The session is gone - already torn down when this attach arrived, or disposed out from
    /// under it by an explicit disconnect or an app quit.
    /// </summary>
    Gone,
}

public sealed class TerminalSession : IDisposable
{
    private readonly IShellChannel _channel;
    private readonly object _writeLock = new();

    // Guards everything about attach/detach/teardown state below it. Held only for
    // bookkeeping - never across an await - so it can settle the reattach-vs-reap race
    // (see AttachAsync and TryBeginReap) without any dependence on timer ordering.
    private readonly object _stateLock = new();
    private readonly CancellationTokenSource _lifetime = new();
    private Attachment? _currentAttach;

    // One attached terminal WebSocket's control state. Superseded is separate from the token
    // because the two mean different things to a socket: cancelling aborts it, which loses the
    // close frame, while this asks the send loop to stop so it can close politely and say why.
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

    // Completed (and swapped for a fresh one) each time the reader appends output, so an
    // attached writer can park until there is something to send. A plain SemaphoreSlim would
    // accumulate one count per read while nothing is attached; this collapses to "there is
    // news" no matter how many reads went by.
    private TaskCompletionSource _outputSignal = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public string Id { get; }

    /// <summary>"ssh" for a remote shell, "local" for one on this machine.</summary>
    public string Kind { get; }

    /// <summary>
    /// Where this shell is. For an SSH session that's the destination it dialled; for a local
    /// one it's a description of this machine and the shell that was launched, so the tab
    /// list, the connection log and the reattach listing all read the same for both kinds.
    /// </summary>
    public string Host { get; }
    public int Port { get; }
    public string Username { get; }

    /// <summary>Recent raw PTY output - the AI agent's view of the session, and the terminal WebSocket's source.</summary>
    public TerminalScrollback Scrollback { get; }

    /// <summary>The AI agent conversation bound to this session; dies with it.</summary>
    public AgentConversation Agent { get; }

    /// <summary>True once the remote shell has ended cleanly, as opposed to a client merely detaching.</summary>
    public bool ShellEnded => _shellEnded;

    /// <summary>
    /// True once no more output will ever arrive - either the shell ended or the SSH transport
    /// failed. Either way there is nothing left to reattach to.
    /// </summary>
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
        // A session that is created and then never attached to (the connect succeeded but the
        // browser never opened the WebSocket) still has to age out, so the clock starts here
        // rather than at the first detach.
        DetachedAtUtc = DateTimeOffset.UtcNow;
    }

    public static TerminalSession Connect(ConnectRequest request) =>
        Start("ssh", SshShellChannel.Connect(request), request.Host, request.Port, request.Username);

    /// <summary>
    /// A shell on the machine slopterm itself is running on - the desktop's own PC, or the
    /// phone. Everything past this point is the SSH path verbatim, because the session layer
    /// only ever deals in an <see cref="IShellChannel"/>.
    /// </summary>
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

    // Tells the shell's PTY (and programs reading COLUMNS/LINES, e.g. `systemctl status`,
    // pagers, editors) the browser terminal's real size. The frontend fits xterm to its
    // container and posts the resulting cols/rows here - both on first mount (the initial
    // request hard-codes 80x24, before xterm has measured itself) and on every subsequent
    // window resize.
    public void Resize(uint columns, uint rows)
    {
        if (columns == 0 || rows == 0)
        {
            return;
        }

        _channel.Resize(columns, rows);
    }

    /// <summary>
    /// Drains the shell into the scrollback for the whole life of the session, whether or not
    /// anyone is attached. This is the piece that lets a client come and go: output produced
    /// while the app is backgrounded is captured and replayed on reattach, the SSH channel
    /// window never fills (so a backgrounded `tail -f` or build keeps running instead of
    /// blocking on the remote side), and the AI agent's scrollback polling works with no
    /// terminal open. ShellStream's Read is synchronous/blocking, so this owns a dedicated
    /// thread-pool thread rather than faking async over it.
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
                    // Disposal is the normal way out of the parked Read (see Dispose); an
                    // exception at any other time is the SSH transport failing. Deliberately
                    // NOT treated as the shell ending: reporting a WiFi-to-mobile handover as
                    // `exit` would close the user's tab instead of reconnecting it.
                    break;
                }

                if (read <= 0)
                {
                    // EOF. SSH.NET reports two very different things this way, because the
                    // ShellStream disposes itself both when the channel closes (`exit` - the
                    // shell really is finished) and when the whole SSH session disconnects
                    // (sshd's ClientAlive timeout, the host shutting down, the transport
                    // failing). Getting it wrong matters in both directions: a shell that
                    // ended closes the user's tab, a transport that died reconnects it. A
                    // cancelled lifetime is neither - that's this process disposing the
                    // session on purpose (see Dispose).
                    _shellEnded = !_lifetime.IsCancellationRequested && ShellClosedCleanly();
                    break;
                }

                Scrollback.Append(buffer.AsSpan(0, read));
                SignalOutput();
            }

            // Written after the last Append, and read before the snapshot in SendOutputAsync,
            // so an attached writer that sees this can be sure it is also seeing every byte
            // that preceded it.
            _readerStopped = true;
            SignalOutput();
        });
    }

    // Whether the EOF the reader just saw was the shell finishing (the user typed `exit`)
    // rather than whatever carries it going away underneath. Delegated to the channel because
    // the answer is entirely transport-specific - see SshShellChannel, where it is a genuinely
    // hard question, and LocalShellChannel, where an EOF can only ever be the shell exiting.
    private bool ShellClosedCleanly() => _channel.ShellClosedCleanly(TimeSpan.FromSeconds(1), _lifetime.Token);

    /// <summary>
    /// Notices an SSH connection that died without telling anyone. SSH.NET's abrupt-failure
    /// path - the socket resetting when a phone moves from WiFi to mobile data, the host
    /// losing power - raises an error and marks the client disconnected, but never closes the
    /// channel, so nothing wakes the reader: it stays parked on a stream that will never
    /// produce another byte. Left alone, that is a session which looks perfectly healthy
    /// forever - reattaches succeed, the terminal shows a live socket, and no output ever
    /// arrives - and which the reaper can never claim, because a client keeps reattaching and
    /// resetting the detach clock.
    ///
    /// Aborting the read is what unparks the reader; it then finds the transport down and
    /// reports the session lost, so the tab reconnects instead of hanging.
    ///
    /// Not started at all for a local shell: it has no transport that can fail independently
    /// of the shell, so this would be a timer that can never do anything.
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

    // Cancels a superseded attach's token a little later, as a backstop: normally its send
    // loop notices the Superseded flag and closes politely long before this fires, but one
    // that's blocked writing to a socket nobody is reading would otherwise hold on
    // indefinitely. Fire-and-forget, and tolerant of the source having been disposed by then.
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
    /// Runs one attached terminal WebSocket for as long as it lasts: replays whatever the
    /// client missed, then streams live output and feeds keystrokes back into the shell.
    /// Returning does NOT end the session unless the result says the shell itself ended.
    /// </summary>
    /// <param name="since">
    /// The client's byte offset into the session's total output, from a previous attach.
    /// Null for a client with nothing on screen (a fresh page), which gets the whole retained
    /// tail instead of a delta.
    /// </param>
    public async Task<AttachResult> AttachAsync(WebSocket socket, long? since, CancellationToken cancellationToken)
    {
        Attachment? attachment = null;
        Attachment? previous = null;
        var firstEverAttach = false;
        lock (_stateLock)
        {
            if (!_disposed)
            {
                // Last attach wins. A socket left over from before the app was frozen can
                // still look open long after the client gave up on it; without this takeover
                // it would hold the session and the WebView that just came back sees nothing.
                previous = _currentAttach;
                attachment = new Attachment(
                    CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token));
                _currentAttach = attachment;
                _attachCount++;
                DetachedAtUtc = null;
                // Claimed here, not after the header goes out: two clients reattaching at the
                // same moment (a PWA window alongside the desktop one) would otherwise both
                // read it as unclaimed and both run the host's startup commands. Released
                // below if the header never reaches anyone.
                firstEverAttach = !_everAttached;
                _everAttached = true;
            }
        }

        if (previous is not null)
        {
            // Asked to wind down, not cancelled outright. Cancelling a WebSocket operation
            // aborts the socket, and an aborted socket cannot carry the close reason that
            // tells the other window it was taken over - and without that reason it reads the
            // close as a network blip, reconnects, evicts this attach straight back, and the
            // two windows trade the session forever. So the flag lets the outgoing send loop
            // finish its current iteration and close politely; the delayed cancel is only a
            // backstop for one that's wedged mid-send. Done outside the lock either way,
            // since Cancel runs continuations inline and they need this same lock.
            previous.Superseded = true;
            SignalOutput(); // wakes its send loop if it's parked waiting for output
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
            // Clamped at both ends. Below, because the client may be asking to resume from
            // further back than the ring still holds - a hole, which `gap` reports so the
            // frontend clears the screen rather than splicing a new chunk onto stale content.
            // Above, because an offset past what was ever written would leave the send loop
            // parked on a cursor the stream can't reach, showing a live socket that silently
            // never delivers a byte.
            var cursor = Math.Clamp(since ?? 0, oldest, Scrollback.TotalWritten);
            var gap = since is { } requested && requested < oldest;

            await SendAttachHeaderAsync(socket, cursor, gap, attachCts.Token, firstEverAttach);
            headerDelivered = true;

            var toSocket = SendOutputAsync(socket, cursor, attachment, attachCts.Token);
            var fromSocket = ReceiveInputAsync(socket, attachCts.Token);
            var first = await Task.WhenAny(toSocket, fromSocket);

            lock (_stateLock)
            {
                // Someone else took this session over while we were running. Reported as its
                // own outcome so the losing client stops rather than reconnecting - two
                // clients that both treat a takeover as "retry" take turns evicting each
                // other forever, and neither terminal ever settles.
                result = ReferenceEquals(_currentAttach, attachment) ? EndedResult() : AttachResult.Superseded;
            }

            if (ReferenceEquals(first, toSocket))
            {
                // The send side stopped of its own accord - normally because the shell ended
                // and we drained the last of its output. Nothing else is writing to the
                // socket right now (a WebSocket allows one send at a time), and the receive
                // side is still live, so this is the one moment we can hand the client a
                // close frame it will actually see. That frame's reason is what tells the
                // frontend the difference between "the shell is over, close the tab" and
                // "you lost the transport, come back" - close first, cancel after.
                await CloseAsync(socket, result);
            }

            attachCts.Cancel();
            try
            {
                // Drain both so neither ends up an unobserved faulted task, and so nothing is
                // still touching the socket when the request handler unwinds.
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

                // The header never reached anyone, so this attach doesn't get to have spent
                // the session's one chance to run its startup commands - put the claim back.
                // Only if nobody took over in the meantime, though: that client was told
                // "not fresh" on the strength of this claim, so giving it back would leave
                // the next attach after it free to type the whole startup list into a shell
                // that has been running for minutes.
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

    // Which "this attach is over" outcome applies, read once the pumps have stopped. Only a
    // clean EOF from a live connection ends the tab; a dead transport is a reconnect; a
    // session this process tore down deliberately (Disconnect, or quit) is neither - the
    // frontend asks what became of it rather than assuming; and everything else is just a
    // lost socket.
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

    // The close reason is a contract with the frontend (see TerminalView): "session-ended"
    // means the shell is over and the tab should close, "session-gone" means the session was
    // already torn down, and anything else - including a socket that simply died, which is by
    // far the common case on a backgrounded phone - means reattach rather than give up.
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
            // CloseAsync waits for the peer's half of the handshake, and the peer here may be
            // a phone that has been frozen mid-conversation and will never answer. Unbounded,
            // that wait keeps this attach "live" - _attachCount stays up, the detach clock
            // never starts, and the reaper can never claim the session. The frame is what
            // matters; the acknowledgement isn't worth hanging on.
            using var closeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await socket.CloseAsync(status, reason, closeTimeout.Token);
        }
        catch (Exception)
        {
            // A client that vanished mid-close can't complete the handshake, and there's
            // nothing to fall back to - we're finished with this socket either way.
        }
    }

    // The one text frame on an otherwise all-binary channel, sent first on every attach, so
    // the client can tell replayed-and-live output apart from a protocol message without any
    // escaping: `offset` is where the byte stream that follows begins, and the client counts
    // forward from it to know what to ask for next time.
    // `fresh` says this is the first client this session has ever had, which is the client's
    // cue to send the host's startup commands. It has to come from here rather than from the
    // client's own memory: a page reload mounts a brand-new terminal against a session that
    // has been running for minutes, and a client that only remembered its own history would
    // type the whole startup list into that live shell a second time.
    private static async Task SendAttachHeaderAsync(
        WebSocket socket, long offset, bool gap, CancellationToken cancellationToken, bool fresh = false)
    {
        var header = System.Text.Encoding.UTF8.GetBytes(
            $"{{\"type\":\"attach\",\"offset\":{offset},\"gap\":{(gap ? "true" : "false")},\"fresh\":{(fresh ? "true" : "false")}}}");
        await socket.SendAsync(header.AsMemory(), WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
    }

    // Streams the scrollback from `cursor` onward. Sourcing sends from the ring rather than
    // straight off the shell is what makes replay and live output the same code path, and it
    // means a slow or wedged socket can never stall the reader - it just falls behind.
    private async Task SendOutputAsync(WebSocket socket, long cursor, Attachment attachment, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            if (attachment.Superseded)
            {
                // Another client has the session now. Returning normally (rather than being
                // cancelled) leaves the socket open and unwritten-to, which is what lets the
                // caller send a close frame explaining why.
                return;
            }

            // Both of these are read BEFORE the snapshot, and for the same reason: the reader
            // writes output first and its flags second, so anything observed here is
            // guaranteed to be reflected in the snapshot that follows. Reading the end flag
            // after the snapshot instead would lose the shell's final chunk - an empty
            // snapshot followed by "and it's over" cannot tell "nothing more was produced"
            // apart from "the last bytes landed a moment ago".
            var news = Volatile.Read(ref _outputSignal).Task;
            var ended = _readerStopped;

            var chunk = Scrollback.ReadFrom(cursor);
            if (chunk.Data.Length > 0)
            {
                if (chunk.StartOffset > cursor)
                {
                    // This socket fell so far behind that the ring dropped output it hadn't
                    // sent yet - a stalled client on a very chatty shell. Re-send the attach
                    // header so the client clears its screen and resyncs its offset instead
                    // of splicing the new bytes onto a stale one and drifting for good.
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
    /// Claims a detached, aged-out session for teardown, atomically with respect to
    /// <see cref="AttachAsync"/>: whoever takes <c>_stateLock</c> first wins, and the loser
    /// sees a settled answer rather than a half-torn-down session. Returns true exactly once,
    /// and only then may the caller remove and dispose it.
    /// </summary>
    public bool TryBeginReap(TimeSpan grace)
    {
        lock (_stateLock)
        {
            if (_disposed || _attachCount > 0 || DetachedAtUtc is not { } detachedAt)
            {
                return false;
            }

            // A session whose reader has stopped - the shell exited, or the transport died -
            // has nothing left to reattach to, so it doesn't get to sit out the grace period.
            if (!_readerStopped && DateTimeOffset.UtcNow - detachedAt < grace)
            {
                return false;
            }

            _disposed = true;
            return true;
        }
    }

    /// <summary>
    /// Writes agent-generated text straight into the same PTY the user is watching, serialized
    /// against browser keystrokes via <c>_writeLock</c> so the two input sources never interleave
    /// a single write.
    /// </summary>
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

        // Idempotent: the reaper claims a session with TryBeginReap (which sets _disposed)
        // and then disposes it, and a racing quit or explicit disconnect must not tear the
        // same client down twice.
        if (Interlocked.Exchange(ref _teardownStarted, 1) != 0)
        {
            return;
        }

        // Unblocks any attached socket's send loop and stops the reader from looping again.
        // Deliberately not disposed: an in-flight attach holds a token linked to it, and
        // disposing the source out from under that link throws on the link's own disposal.
        _lifetime.Cancel();

        // Both steps are isolated, because this runs on connections that are by definition
        // suspect - the reaper's whole job is collecting sessions whose transport broke - and
        // a throw out of either would skip the rest with no way back: the teardown claim
        // above is one-shot, so nothing would ever retry.
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
